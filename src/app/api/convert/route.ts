import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { writeFile, readFile, unlink, readdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { platform } from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const TEMP_DIR = join(process.cwd(), 'temp');
const RUST_BINARY = join(process.cwd(), 'video-codec', 'target_web', 'release', platform() === 'win32' ? 'video-codec.exe' : 'video-codec');


// Ensure TEMP_DIR exists
import { mkdirSync } from 'fs';
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch (e) {}

// Periodic cleanup of temp directory (files older than 20 minutes for Platinum efficiency)
if (process.env.NODE_ENV !== 'test') {
  setInterval(async () => {
    try {
      const files = await readdir(TEMP_DIR).catch(() => [] as string[]);
      const now = Date.now();
      const expiry = 1000 * 60 * 20;

      for (const file of files) {
        const filePath = join(TEMP_DIR, file);
        try {
          const fileStat = await stat(filePath);
          if (now - fileStat.mtimeMs > expiry) {
            await unlink(filePath);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }, 1000 * 60 * 10);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);
    let errorOutput = '';

    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Exit code ${code}: ${errorOutput}`));
      }
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
}

function runFfmpeg(input: string, output: string, qualityStr: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let crf = '28';
    if (qualityStr && parseInt(qualityStr) < 80) crf = '32';
    
    ffmpeg(input)
      .outputOptions([
        '-vcodec libx265',
        `-crf ${crf}`,
        '-preset ultrafast' // Keep UX snappy
      ])
      .save(output)
      .on('end', () => resolve())
      .on('error', (err: any) => reject(new Error(`FFmpeg processing failed: ${err.message}`)));
  });
}

export async function POST(request: NextRequest) {
  const id = randomUUID();
  const inputPath = join(TEMP_DIR, `${id}_input`);
  const outputPath = join(TEMP_DIR, `${id}_output`);
  
  // Hardened cleanup: We seek all files prefixed with the session ID
  const hardenedCleanup = async () => {
    try {
      const files = await readdir(TEMP_DIR);
      const sessionFiles = files.filter(f => f.startsWith(id));
      for (const f of sessionFiles) {
        await unlink(join(TEMP_DIR, f)).catch(() => {});
      }
    } catch (e) {}
  };

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const mode = (formData.get('mode') as string) || 'encode';
    const compressionMode = (formData.get('compressionMode') as string) || 'zstd-json';
    const quality = (formData.get('quality') as string) || '85';
    const password = formData.get('password') as string;

    if (!file) {
      return NextResponse.json({ error: 'No payload provided' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let currentInputPath = inputPath;
    await writeFile(currentInputPath, buffer);

    // Initial Decryption check
    if (buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === 'VENC') {
      if (!password) {
        return NextResponse.json({ error: 'Payload is encrypted. Decryption key required.' }, { status: 400 });
      }
      const decryptedPath = `${inputPath}_decrypted`;
      await runCommand(RUST_BINARY, ['decrypt', currentInputPath, decryptedPath, password]);
      currentInputPath = decryptedPath;
    }

    if (mode === 'encode') {
      const isBinary = compressionMode === 'binary' || compressionMode === 'context' || compressionMode === 'lossy';
      const outputExt = isBinary ? 'bin' : 'json';
      const encodedOutputPath = `${outputPath}.${outputExt}`;

      let targetInput = currentInputPath;
      if (compressionMode === 'lossy') {
        const crushedVideoPath = `${outputPath}_crushed.mp4`;
        await runFfmpeg(targetInput, crushedVideoPath, quality);
        targetInput = crushedVideoPath;
      }
      
      let args: string[];
      switch (compressionMode) {
        case 'binary': args = ['binary', targetInput, encodedOutputPath, '0', '4096']; break;
        case 'context': args = ['context', targetInput, encodedOutputPath, '0', '4096']; break;
        case 'lossy': args = ['lossy', targetInput, encodedOutputPath, quality, '4096']; break;
        default: args = ['zstd-json', targetInput, encodedOutputPath, '0', '4096']; break;
      }
      
      await runCommand(RUST_BINARY, args);
      
      let finalPath = encodedOutputPath;
      let finalFilename = file.name.replace(/\.[^/.]+$/, '') + (isBinary ? '.vceo' : '.json');
      
      if (password) {
        const encryptedPath = `${encodedOutputPath}.enc`;
        await runCommand(RUST_BINARY, ['encrypt', encodedOutputPath, encryptedPath, password]);
        finalPath = encryptedPath;
        finalFilename += '.enc';
      }
      
      const responseFile = await readFile(finalPath);
      
      if (isBinary || password) {
        return new NextResponse(responseFile, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${finalFilename}"`,
          },
        });
      } else {
        return NextResponse.json({
          success: true,
          data: JSON.parse(responseFile.toString('utf-8')),
          jsonText: responseFile.toString('utf-8'),
          compressionMode,
        });
      }
    } else {
      // Decode
      const inputBuffer = await readFile(currentInputPath);
      let decodeType = 'decode-json';
      
      if (inputBuffer.length >= 4) {
        const magic = inputBuffer.slice(0, 4).toString('ascii');
        if (magic === 'VCEO') decodeType = 'decode-bin';
        else if (magic === 'VCTX') decodeType = 'decode-context';
      }
      
      const videoPath = `${outputPath}.mp4`;
      await runCommand(RUST_BINARY, [decodeType, currentInputPath, videoPath]);
      
      let filename = 'decoded_video.mp4';
      if (decodeType === 'decode-json') {
        try {
          const parsed = JSON.parse(inputBuffer.toString('utf-8'));
          filename = parsed.metadata?.filename || parsed.filename || filename;
        } catch {}
      }
      
      const videoStream = createReadStream(videoPath);
      // @ts-ignore
      return new NextResponse(videoStream, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }
  } catch (error: unknown) {
    const error_obj = error instanceof Error ? error : new Error(String(error));
    console.error('Conversion error:', error_obj);
    return NextResponse.json(
      { error: 'Engine conversion failed', details: error_obj.message },
      { status: 500 }
    );
  } finally {
    // Guaranteed Session-Wide Cleanup
    await hardenedCleanup();
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
