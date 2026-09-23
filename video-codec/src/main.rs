use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write, BufReader, BufWriter};
use zstd::stream::{Encoder as ZstdEncoder, Decoder as ZstdDecoder};
use serde::{Serialize, Deserialize};
use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use chacha20poly1305::{aead::{Aead, KeyInit}, ChaCha20Poly1305, Nonce};
use argon2::{Argon2, Params, Algorithm, Version};
use rand::RngCore;

fn default_format_version() -> u16 { 1 }

#[derive(Serialize, Deserialize)]
struct VideoMetadata {
    filename: String,
    original_size: u64,
    timestamp: u64,
    // Absent/1 on files produced before the obfuscation layer existed — decoded
    // as plain Zstd for backward compatibility. 2+ carries obf_key/obf_nonce and
    // the payload is ChaCha20-Poly1305 ciphertext of the Zstd stream.
    #[serde(default = "default_format_version")]
    format_version: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    obf_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    obf_nonce: Option<String>,
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
    pub fn max_profile() -> Self {
        // 2MB match window, max compression level
        Self { level: 22, window_log: 21 }
    }
}

// Progress is reported on stderr as "PROGRESS:<0-100>" lines, one per percentage
// point change, flushed immediately so the parent Node process can relay it live.
fn report_progress(pct: u64) {
    eprintln!("PROGRESS:{}", pct.min(100));
    let _ = io::stderr().flush();
}

// Every encoded container — password or not — gets a fresh random key+nonce
// that seals the compressed payload with ChaCha20-Poly1305 before it's written.
// The key/nonce travel inside the container (our own decoder has to find them
// without a user-supplied secret), so this isn't a substitute for the password
// path; it's a proprietary sealed format that a generic zstd/json tool can't
// just read through, and that produces different bytes for the same input
// every single time.
fn obfuscate_encrypt(data: &[u8]) -> anyhow::Result<(Vec<u8>, [u8; 32], [u8; 12])> {
    let mut key = [0u8; 32];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut key);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let cipher = ChaCha20Poly1305::new_from_slice(&key).unwrap();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|_| anyhow::anyhow!("Internal obfuscation layer failed"))?;
    Ok((ciphertext, key, nonce_bytes))
}

fn obfuscate_decrypt(ciphertext: &[u8], key: &[u8; 32], nonce_bytes: &[u8; 12]) -> anyhow::Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key).unwrap();
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| anyhow::anyhow!("Corrupted container, or not produced by this engine"))
}

// Streams reader -> writer in fixed-size chunks (instead of reading the whole
// file into memory) so multi-GB files don't blow up RAM, and reports real
// byte-level progress as it goes.
fn copy_with_progress<R: Read, W: Write>(mut reader: R, mut writer: W, total: u64) -> anyhow::Result<u64> {
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let mut copied: u64 = 0;
    let mut last_pct: i64 = -1;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        copied += n as u64;
        if total > 0 {
            let pct = ((copied as f64 / total as f64) * 100.0) as i64;
            if pct != last_pct {
                report_progress(pct as u64);
                last_pct = pct;
            }
        }
    }
    Ok(copied)
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
        "zstd-json" => encode_zstd_json(input_path, output_path, args.get(4).map(|s| s.as_str()))?,
        "binary" => encode_binary(input_path, output_path)?,
        "context" => encode_context(input_path, output_path)?,
        "lossy" => encode_lossy(input_path, output_path, args.get(4).and_then(|s| s.parse().ok()).unwrap_or(85))?,
        "encrypt" => encrypt_file(input_path, output_path, args.get(4).map(|s| s.as_str()).unwrap_or(""))?,
        "decrypt" => decrypt_file(input_path, output_path, args.get(4).map(|s| s.as_str()).unwrap_or(""))?,
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

fn encode_zstd_json(input: &str, output: &str, display_name: Option<&str>) -> anyhow::Result<()> {
    let budget = ZstdBudget::max_profile();
    let file = File::open(input)?;
    let total = file.metadata()?.len();
    let reader = BufReader::new(file);

    // ZSTD compress the data payload directly, streaming the read so we never
    // hold the raw input in memory (the compressed+base64 copy below is unavoidable
    // for this container format, but at least we don't triple that with the raw bytes too)
    let mut compressed_data = Vec::new();
    {
        let mut encoder = ZstdEncoder::new(&mut compressed_data, budget.level)?;
        encoder.window_log(budget.window_log)?;
        copy_with_progress(reader, &mut encoder, total)?;
        encoder.finish()?;
    }

    let (ciphertext, key, nonce_bytes) = obfuscate_encrypt(&compressed_data)?;

    let metadata = VideoMetadata {
        filename: display_name.unwrap_or(input).to_string(),
        original_size: total,
        timestamp: 0,
        format_version: 2,
        obf_key: Some(base64_encode(&key)),
        obf_nonce: Some(base64_encode(&nonce_bytes)),
    };

    let payload = VideoPayload {
        metadata,
        data: base64_encode(&ciphertext),
    };

    let json = serde_json::to_string(&payload)?;
    fs::write(output, json)?;
    report_progress(100);
    Ok(())
}

fn decode_zstd_json(input: &str, output: &str) -> anyhow::Result<()> {
    // The JSON container has to be parsed whole (base64+JSON can't be streamed
    // without a custom parser), but the decompression pass below is streamed.
    let json = fs::read_to_string(input)?;
    let payload: VideoPayload = serde_json::from_str(&json)?;
    let raw_data = base64_decode(&payload.data)?;

    let compressed_data = if payload.metadata.format_version >= 2 {
        let key_b64 = payload.metadata.obf_key.as_deref()
            .ok_or_else(|| anyhow::anyhow!("Container is missing its obfuscation key"))?;
        let nonce_b64 = payload.metadata.obf_nonce.as_deref()
            .ok_or_else(|| anyhow::anyhow!("Container is missing its obfuscation nonce"))?;
        let key: [u8; 32] = base64_decode(key_b64)?.try_into()
            .map_err(|_| anyhow::anyhow!("Malformed obfuscation key"))?;
        let nonce_bytes: [u8; 12] = base64_decode(nonce_b64)?.try_into()
            .map_err(|_| anyhow::anyhow!("Malformed obfuscation nonce"))?;
        obfuscate_decrypt(&raw_data, &key, &nonce_bytes)?
    } else {
        raw_data
    };

    let mut decoder = ZstdDecoder::new(&compressed_data[..])?;
    decoder.window_log_max(27)?; // Headroom above the level-22 encoder's 21-bit window

    let output_file = File::create(output)?;
    let writer = BufWriter::new(output_file);
    copy_with_progress(&mut decoder, writer, payload.metadata.original_size)?;
    report_progress(100);
    Ok(())
}

fn encode_binary(input: &str, output: &str) -> anyhow::Result<()> {
    // Normal Profile (Level 11) for fast streaming
    let file = File::open(input)?;
    let total = file.metadata()?.len();
    let reader = BufReader::new(file);

    let mut compressed = Vec::new();
    {
        let mut encoder = ZstdEncoder::new(&mut compressed, 11)?;
        copy_with_progress(reader, &mut encoder, total)?;
        encoder.finish()?;
    }
    let (ciphertext, key, nonce_bytes) = obfuscate_encrypt(&compressed)?;

    let mut output_file = File::create(output)?;
    output_file.write_all(b"VCEO")?;
    output_file.write_u16::<LittleEndian>(2)?; // version 2: obfuscation-layer container
    output_file.write_u64::<LittleEndian>(total)?;
    output_file.write_all(&key)?;
    output_file.write_all(&nonce_bytes)?;
    output_file.write_all(&ciphertext)?;
    report_progress(100);
    Ok(())
}


fn decode_zstd_stream(input: &str, output: &str, expected_magic: &[u8; 4]) -> anyhow::Result<()> {
    let mut input_file = File::open(input)?;
    let mut magic = [0u8; 4];
    input_file.read_exact(&mut magic)?;
    if &magic != expected_magic {
        let expected = std::str::from_utf8(expected_magic).unwrap_or("?");
        let found = std::str::from_utf8(&magic).unwrap_or("?");
        return Err(anyhow::anyhow!("Unexpected file header: expected {}, found {}", expected, found));
    }

    let version = input_file.read_u16::<LittleEndian>()?;
    let total = input_file.read_u64::<LittleEndian>()?; // original (decompressed) size, used as the progress denominator

    let output_file = File::create(output)?;
    let writer = BufWriter::new(output_file);

    if version >= 2 {
        // Obfuscation-layer container: embedded random key+nonce, then
        // ChaCha20-Poly1305 ciphertext of the Zstd stream.
        let mut key = [0u8; 32];
        let mut nonce_bytes = [0u8; 12];
        input_file.read_exact(&mut key)?;
        input_file.read_exact(&mut nonce_bytes)?;

        let mut ciphertext = Vec::new();
        input_file.read_to_end(&mut ciphertext)?;
        let plaintext = obfuscate_decrypt(&ciphertext, &key, &nonce_bytes)?;

        let mut decoder = ZstdDecoder::new(&plaintext[..])?;
        decoder.window_log_max(27)?;
        copy_with_progress(&mut decoder, writer, total)?;
    } else {
        // Legacy version-1 container: plain Zstd stream, no obfuscation layer.
        let mut decoder = ZstdDecoder::new(input_file)?;
        decoder.window_log_max(27)?;
        copy_with_progress(&mut decoder, writer, total)?;
    }
    report_progress(100);
    Ok(())
}

fn decode_binary(input: &str, output: &str) -> anyhow::Result<()> {
    decode_zstd_stream(input, output, b"VCEO")
}

fn encrypt_file(input: &str, output: &str, password: &str) -> anyhow::Result<()> {
    let data = fs::read(input)?;
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let params = Params::new(65536, 3, 1, Some(32)).unwrap();
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
    report_progress(100);
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

    let params = Params::new(65536, 3, 1, Some(32)).unwrap();
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2.hash_password_into(password.as_bytes(), &salt, &mut key).unwrap();

    let cipher = ChaCha20Poly1305::new_from_slice(&key).unwrap();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext.as_slice()).map_err(|_| anyhow::anyhow!("Decryption failed - Incorrect password or corrupted payload"))?;

    fs::write(output, plaintext)?;
    report_progress(100);
    Ok(())
}

fn encode_lossy(input: &str, output: &str, _quality: u8) -> anyhow::Result<()> {
    // Quality is already applied upstream via the FFmpeg H.265 CRF pass.
    // This stage just wraps the already-crushed video in a fast zstd envelope.
    let file = File::open(input)?;
    let total = file.metadata()?.len();
    let reader = BufReader::new(file);

    let mut compressed = Vec::new();
    {
        let mut encoder = ZstdEncoder::new(&mut compressed, 3)?;
        copy_with_progress(reader, &mut encoder, total)?;
        encoder.finish()?;
    }
    let (ciphertext, key, nonce_bytes) = obfuscate_encrypt(&compressed)?;

    let mut output_file = File::create(output)?;
    output_file.write_all(b"VCEO")?;
    output_file.write_u16::<LittleEndian>(2)?;
    output_file.write_u64::<LittleEndian>(total)?;
    output_file.write_all(&key)?;
    output_file.write_all(&nonce_bytes)?;
    output_file.write_all(&ciphertext)?;
    report_progress(100);
    Ok(())
}

fn encode_context(input: &str, output: &str) -> anyhow::Result<()> {
    // Max-compression profile: Zstd level 22 with a wider match window.
    let budget = ZstdBudget::max_profile();
    let file = File::open(input)?;
    let total = file.metadata()?.len();
    let reader = BufReader::new(file);

    let mut compressed = Vec::new();
    {
        let mut encoder = ZstdEncoder::new(&mut compressed, budget.level)?;
        encoder.window_log(budget.window_log)?;
        copy_with_progress(reader, &mut encoder, total)?;
        encoder.finish()?;
    }
    let (ciphertext, key, nonce_bytes) = obfuscate_encrypt(&compressed)?;

    let mut output_file = File::create(output)?;
    output_file.write_all(b"VCTX")?;
    output_file.write_u16::<LittleEndian>(2)?;
    output_file.write_u64::<LittleEndian>(total)?;
    output_file.write_all(&key)?;
    output_file.write_all(&nonce_bytes)?;
    output_file.write_all(&ciphertext)?;
    report_progress(100);
    Ok(())
}

fn decode_context(input: &str, output: &str) -> anyhow::Result<()> {
    decode_zstd_stream(input, output, b"VCTX")
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
