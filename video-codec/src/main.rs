use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write, BufReader, BufWriter, Seek};
use std::path::Path;
use zstd::stream::{Encoder as ZstdEncoder, Decoder as ZstdDecoder};
use serde::{Serialize, Deserialize};
use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use chacha20poly1305::{aead::{Aead, KeyInit}, ChaCha20Poly1305, Nonce};
use argon2::{Argon2, Params, Algorithm, Version};
use rand::RngCore;

#[derive(Serialize, Deserialize)]
struct VideoMetadata {
    filename: String,
    original_size: u64,
    timestamp: u64,
}

#[derive(Serialize, Deserialize)]
struct VideoPayload {
    metadata: VideoMetadata,
    data: String,
}

pub struct ZstdBudget {
    pub level: i32,
    pub window_log: u32,
}

impl ZstdBudget {
    pub fn platinum_profile() -> Self {
        // Safe 2MB window, Max compression level
        Self { level: 22, window_log: 21 }
    }
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: video-codec <mode> <input> <output> [extra...]");
        std::process::exit(1);
    }

    let mode = &args[1];
    let input_path = &args[2];
    let output_path = &args[3];

    match mode.as_str() {
        "zstd-json" => encode_zstd_json(input_path, output_path)?,
        "binary" => encode_binary(input_path, output_path)?,
        "context" => encode_context(input_path, output_path)?,
        "lossy" => encode_lossy(input_path, output_path, args[4].parse().unwrap_or(85))?,
        "encrypt" => encrypt_file(input_path, output_path, &args[4])?,
        "decrypt" => decrypt_file(input_path, output_path, &args[4])?,
        "decode-json" => decode_zstd_json(input_path, output_path)?,
        "decode-bin" => decode_binary(input_path, output_path)?,
        "decode-context" => decode_context(input_path, output_path)?,
        _ => {
            eprintln!("Unknown mode: {}", mode);
            std::process::exit(1);
        }
    }

    Ok(())
}

fn encode_zstd_json(input: &str, output: &str) -> anyhow::Result<()> {
    let budget = ZstdBudget::platinum_profile();
    let data = fs::read(input)?;
    let metadata = VideoMetadata {
        filename: input.to_string(),
        original_size: data.len() as u64,
        timestamp: 0,
    };
    
    // ZSTD compress the data payload directly
    let mut compressed_data = Vec::new();
    let mut encoder = ZstdEncoder::new(&mut compressed_data, budget.level)?;
    encoder.window_log(budget.window_log)?;
    encoder.write_all(&data)?;
    encoder.finish()?;

    let payload = VideoPayload {
        metadata,
        data: base64_encode(&compressed_data),
    };

    let json = serde_json::to_string(&payload)?;
    fs::write(output, json)?;
    Ok(())
}

fn decode_zstd_json(input: &str, output: &str) -> anyhow::Result<()> {
    let json = fs::read_to_string(input)?;
    let payload: VideoPayload = serde_json::from_str(&json)?;
    let compressed_data = base64_decode(&payload.data)?;

    let mut decoder = ZstdDecoder::new(&compressed_data[..])?;
    decoder.window_log_max(27)?; // V4 Stability
    
    let mut decoded = Vec::new();
    io::Read::read_to_end(&mut decoder, &mut decoded)?;
    fs::write(output, decoded)?;
    Ok(())
}

fn encode_binary(input: &str, output: &str) -> anyhow::Result<()> {
    // Normal Profile (Level 11) for fast streaming
    let data = fs::read(input)?;
    let mut output_file = File::create(output)?;
    
    // Header
    output_file.write_all(b"VCEO")?;
    output_file.write_u16::<LittleEndian>(1)?; // version
    output_file.write_u64::<LittleEndian>(data.len() as u64)?;
    
    let mut encoder = ZstdEncoder::new(output_file, 11)?;
    encoder.write_all(&data)?;
    encoder.finish()?;
    Ok(())
}


fn decode_binary(input: &str, output: &str) -> anyhow::Result<()> {
    let mut input_file = File::open(input)?;
    let mut magic = [0u8; 4];
    input_file.read_exact(&mut magic)?;
    if &magic != b"VCEO" { return Err(anyhow::anyhow!("Not a VCEO file")); }
    
    input_file.seek(io::SeekFrom::Start(14))?; // Skip magic + ver + size
    let mut decoder = ZstdDecoder::new(input_file)?;
    decoder.window_log_max(27)?; // V4 Stability
    
    let mut output_file = File::create(output)?;
    io::copy(&mut decoder, &mut output_file)?;
    Ok(())
}

fn encrypt_file(input: &str, output: &str, password: &str) -> anyhow::Result<()> {
    let data = fs::read(input)?;
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let params = Params::new(65536, 1, 1, Some(32)).unwrap();
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2.hash_password_into(password.as_bytes(), &salt, &mut key).unwrap();

    let cipher = ChaCha20Poly1305::new_from_slice(&key).unwrap();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, data.as_slice()).map_err(|_| anyhow::anyhow!("Encryption failed in ChaCha20Poly1305"))?;


    let mut out = File::create(output)?;
    out.write_all(b"VENC")?;
    out.write_all(&salt)?;
    out.write_all(&nonce_bytes)?;
    out.write_all(&ciphertext)?;
    Ok(())
}

fn decrypt_file(input: &str, output: &str, password: &str) -> anyhow::Result<()> {
    let mut input_file = File::open(input)?;
    let mut magic = [0u8; 4];
    input_file.read_exact(&mut magic)?;
    if &magic != b"VENC" { return Err(anyhow::anyhow!("Not an encrypted VENC file")); }

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    input_file.read_exact(&mut salt)?;
    input_file.read_exact(&mut nonce_bytes)?;

    let mut ciphertext = Vec::new();
    input_file.read_to_end(&mut ciphertext)?;

    let params = Params::new(65536, 1, 1, Some(32)).unwrap();
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2.hash_password_into(password.as_bytes(), &salt, &mut key).unwrap();

    let cipher = ChaCha20Poly1305::new_from_slice(&key).unwrap();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext.as_slice()).map_err(|_| anyhow::anyhow!("Decryption failed - Incorrect password or corrupted payload"))?;

    fs::write(output, plaintext)?;
    Ok(())
}

// Stubs for complex modes (Lossy/Context)
fn encode_lossy(input: &str, output: &str, _quality: u8) -> anyhow::Result<()> {
    // Lossy simulation (Level 3 - very fast, low compression)
    let data = fs::read(input)?;
    let mut output_file = File::create(output)?;
    output_file.write_all(b"VCEO")?;
    output_file.write_u16::<LittleEndian>(1)?;
    output_file.write_u64::<LittleEndian>(data.len() as u64)?;
    let mut encoder = ZstdEncoder::new(output_file, 3)?;
    encoder.write_all(&data)?;
    encoder.finish()?;
    Ok(())
}

fn encode_context(input: &str, output: &str) -> anyhow::Result<()> {
    // Context Model (Platinum Level 22)
    let budget = ZstdBudget::platinum_profile();
    let data = fs::read(input)?;
    let mut output_file = File::create(output)?;
    output_file.write_all(b"VCEO")?;
    output_file.write_u16::<LittleEndian>(1)?;
    output_file.write_u64::<LittleEndian>(data.len() as u64)?;
    let mut encoder = ZstdEncoder::new(output_file, budget.level)?;
    encoder.window_log(budget.window_log)?;
    encoder.write_all(&data)?;
    encoder.finish()?;
    Ok(())
}

fn decode_context(input: &str, output: &str) -> anyhow::Result<()> {
    decode_binary(input, output)
}

// Base64 helpers
fn base64_encode(data: &[u8]) -> String {
    use base64::{Engine as _, engine::general_purpose};
    general_purpose::STANDARD.encode(data)
}

fn base64_decode(data: &str) -> anyhow::Result<Vec<u8>> {
    use base64::{Engine as _, engine::general_purpose};
    general_purpose::STANDARD.decode(data).map_err(|e| anyhow::anyhow!(e))
}
