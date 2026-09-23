import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { writeFile, readFile, rm, mkdir, readdir, stat, open } from 'fs/promises';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { platform } from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { setProgress, clearProgress } from './progressStore';
import { packFiles, unpackFile, isPackFile, zipDirectory, PackEntry } from './pack';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const TEMP_DIR = join(process.cwd(), 'temp');
const RUST_BINARY = join(process.cwd(), 'video-codec', 'target_web', 'release', platform() === 'win32' ? 'video-codec.exe' : 'video-codec');

// Base64 inflates data by ~4/3, and JSON adds a little more on top of that.
// fs.readFile() (used to build the response) hard-refuses any file over 2GiB
// (ERR_FS_FILE_TOO_LARGE), so once the *compressed* payload could plausibly
// cross that line after base64 inflation, fall back to the raw-binary
// container instead of json+base64. Already-compressed video barely shrinks
// under Zstd, so this is sized off the original (worst case ~1:1 ratio).
const LARGE_FILE_THRESHOLD = 1.2 * 1024 * 1024 * 1024; // 1.2 GiB


// Ensure TEMP_DIR exists
import { mkdirSync } from 'fs';
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

// Periodic cleanup: purge temp files older than 20 minutes
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
            await rm(filePath, { recursive: true, force: true });
          }
        } catch {}
      }
    } catch {}
  }, 1000 * 60 * 10);
}

async function runCommand(command: string, args: string[], onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);
    let errorOutput = '';
    let stderrLineBuffer = '';

    process.stderr.on('data', (data) => {
      stderrLineBuffer += data.toString();
      const lines = stderrLineBuffer.split('\n');
      stderrLineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(/^PROGRESS:(\d+)/);
        if (match) {
          onProgress?.(Math.min(100, parseInt(match[1], 10)));
        } else if (line.trim()) {
          errorOutput += line + '\n';
        }
      }
    });

    process.on('close', (code) => {
      if (stderrLineBuffer.trim() && !stderrLineBuffer.match(/^PROGRESS:\d+/)) {
        errorOutput += stderrLineBuffer;
      }
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

// Maps the UI's 50-100 quality slider onto a continuous libx265 CRF range (35 -> 18).
// Lower CRF = higher quality/larger file, so the mapping is inverted.
function qualityToCrf(qualityStr: string): number {
  const quality = Math.min(100, Math.max(50, parseInt(qualityStr, 10) || 85));
  const t = (quality - 50) / 50;
  return Math.round(35 - t * (35 - 18));
}

function runFfmpeg(input: string, output: string, qualityStr: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const crf = qualityToCrf(qualityStr);

    ffmpeg(input)
      .outputOptions([
        '-vcodec libx265',
        `-crf ${crf}`,
        '-preset ultrafast' // Keep UX snappy
      ])
      .on('progress', (p: { percent?: number }) => {
        if (onProgress && typeof p.percent === 'number' && isFinite(p.percent)) {
          onProgress(Math.max(0, Math.min(100, Math.round(p.percent))));
        }
      })
      .save(output)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`FFmpeg processing failed: ${err.message}`)));
  });
}

// Only [0-9a-f-] of UUID length — this feeds directly into temp file paths,
// so a malformed/attacker-supplied jobId must never be trusted as-is.
const JOB_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

export async function POST(request: NextRequest) {
  let id: string = randomUUID();
  let inputPath = join(TEMP_DIR, `${id}_input`);
  let outputPath = join(TEMP_DIR, `${id}_output`);
  let cleanupHandledByStream = false;

  // Hardened cleanup: We seek all files/dirs prefixed with the session ID
  // (batch mode leaves behind per-entry temp files and an extracted-archive
  // directory alongside the usual single-file temps, so this has to be recursive).
  const hardenedCleanup = async () => {
    try {
      const files = await readdir(TEMP_DIR);
      const sessionFiles = files.filter(f => f.startsWith(id));
      for (const f of sessionFiles) {
        await rm(join(TEMP_DIR, f), { recursive: true, force: true }).catch(() => {});
      }
    } catch {}
  };

  // Streams a file as the response body and only deletes temp files once the
  // stream actually finishes — deleting eagerly (like the old readFile-based
  // response did implicitly, since it fully buffered first) would race the
  // in-flight download and truncate it.
  const streamFileAsResponse = (path: string, headers: Record<string, string>) => {
    const nodeStream = createReadStream(path);
    nodeStream.on('close', () => { hardenedCleanup().catch(() => {}); });
    nodeStream.on('error', () => { hardenedCleanup().catch(() => {}); });
    cleanupHandledByStream = true;
    return new NextResponse(Readable.toWeb(nodeStream) as ReadableStream, { headers });
  };

  try {
    const formData = await request.formData();
    const mode = (formData.get('mode') as string) || 'encode';
    const compressionMode = (formData.get('compressionMode') as string) || 'zstd-json';
    const quality = (formData.get('quality') as string) || '85';
    const password = formData.get('password') as string;
    const clientJobId = formData.get('jobId') as string | null;
    const batchMode = (formData.get('batchMode') as string) === 'true';

    if (clientJobId && JOB_ID_PATTERN.test(clientJobId)) {
      id = clientJobId;
      inputPath = join(TEMP_DIR, `${id}_input`);
      outputPath = join(TEMP_DIR, `${id}_output`);
    }

    if (batchMode && mode !== 'encode') {
      return NextResponse.json({ error: 'Folder/batch conversion only supports encoding' }, { status: 400 });
    }

    let currentInputPath = inputPath;
    let displayName: string;

    if (batchMode) {
      // Folder/multi-file mode: pack everything into one VPAK blob first, then
      // fall straight into the exact same single-file pipeline below — it
      // doesn't know or care whether the bytes it's compressing are one video
      // or a packed archive.
      const files = formData.getAll('files') as File[];
      const paths = formData.getAll('paths') as string[];
      if (files.length === 0) {
        return NextResponse.json({ error: 'No files provided' }, { status: 400 });
      }
      displayName = (formData.get('archiveName') as string) || 'archive';

      setProgress(id, { stage: 'Receiving files', percent: 0, done: false });
      const entries: PackEntry[] = [];
      for (let i = 0; i < files.length; i++) {
        const entryPath = `${inputPath}_entry_${i}`;
        await writeFile(entryPath, Buffer.from(await files[i].arrayBuffer()));
        entries.push({ relativePath: paths[i] || files[i].name, sourcePath: entryPath });
        setProgress(id, { stage: 'Receiving files', percent: Math.round(((i + 1) / files.length) * 100), done: false });
      }

      const packedPath = `${inputPath}_packed`;
      setProgress(id, { stage: 'Packing files', percent: 0, done: false });
      await packFiles(entries, packedPath, (pct) =>
        setProgress(id, { stage: 'Packing files', percent: pct, done: false })
      );
      currentInputPath = packedPath;
    } else {
      const file = formData.get('file') as File;
      if (!file) {
        return NextResponse.json({ error: 'No payload provided' }, { status: 400 });
      }
      displayName = file.name;

      setProgress(id, { stage: 'Receiving upload', percent: 0, done: false });

      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(currentInputPath, buffer);

      // Initial Decryption check
      if (buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === 'VENC') {
        if (!password) {
          return NextResponse.json({ error: 'Payload is encrypted. Decryption key required.' }, { status: 400 });
        }
        setProgress(id, { stage: 'Decrypting', percent: 0, done: false });
        const decryptedPath = `${inputPath}_decrypted`;
        await runCommand(RUST_BINARY, ['decrypt', currentInputPath, decryptedPath, password]);
        currentInputPath = decryptedPath;
      }
    }

    if (mode === 'encode') {
      const inputSize = (await stat(currentInputPath)).size;

      if (batchMode && compressionMode === 'lossy') {
        return NextResponse.json({ error: 'Lossy H.265 mode is video-specific and not available for folder/batch conversion' }, { status: 400 });
      }

      // Already-compressed video barely shrinks under Zstd, so json+base64
      // inflation can push the output past the 2GiB fs streaming-response
      // ceiling even for inputs comfortably under it. Fall back to the
      // equivalent raw-binary container (same Zstd level, no json/base64).
      let effectiveCompressionMode = compressionMode;
      let fellBackFromJson = false;
      if (effectiveCompressionMode === 'zstd-json' && inputSize > LARGE_FILE_THRESHOLD) {
        effectiveCompressionMode = 'context';
        fellBackFromJson = true;
      }

      const isBinary = effectiveCompressionMode === 'binary' || effectiveCompressionMode === 'context' || effectiveCompressionMode === 'lossy';
      const outputExt = isBinary ? 'bin' : 'json';
      const encodedOutputPath = `${outputPath}.${outputExt}`;

      let targetInput = currentInputPath;
      if (effectiveCompressionMode === 'lossy') {
        const crushedVideoPath = `${outputPath}_crushed.mp4`;
        setProgress(id, { stage: 'Re-encoding video (H.265)', percent: 0, done: false });
        await runFfmpeg(targetInput, crushedVideoPath, quality, (pct) =>
          setProgress(id, { stage: 'Re-encoding video (H.265)', percent: pct, done: false })
        );
        targetInput = crushedVideoPath;
      }

      let args: string[];
      switch (effectiveCompressionMode) {
        case 'binary': args = ['binary', targetInput, encodedOutputPath]; break;
        case 'context': args = ['context', targetInput, encodedOutputPath]; break;
        case 'lossy': args = ['lossy', targetInput, encodedOutputPath, quality]; break;
        default: args = ['zstd-json', targetInput, encodedOutputPath, displayName]; break;
      }

      setProgress(id, { stage: 'Compressing', percent: 0, done: false });
      await runCommand(RUST_BINARY, args, (pct) =>
        setProgress(id, { stage: 'Compressing', percent: pct, done: false })
      );

      let finalPath = encodedOutputPath;
      let finalFilename = displayName.replace(/\.[^/.]+$/, '') + (isBinary ? '.vceo' : '.json');

      if (password) {
        setProgress(id, { stage: 'Encrypting', percent: 0, done: false });
        const encryptedPath = `${encodedOutputPath}.enc`;
        await runCommand(RUST_BINARY, ['encrypt', encodedOutputPath, encryptedPath, password]);
        finalPath = encryptedPath;
        finalFilename += '.enc';
      }

      const stats = await stat(finalPath);
      setProgress(id, { stage: 'Complete', percent: 100, done: true });

      const sharedHeaders: Record<string, string> = {
        'X-Compression-Mode': effectiveCompressionMode,
        'X-Job-Id': id,
        'Content-Length': String(stats.size),
        ...(fellBackFromJson ? { 'X-Compression-Fallback': 'true' } : {}),
      };

      if (isBinary || password) {
        return streamFileAsResponse(finalPath, {
          ...sharedHeaders,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${finalFilename}"`,
        });
      } else {
        return streamFileAsResponse(finalPath, {
          ...sharedHeaders,
          'Content-Type': 'application/json',
        });
      }
    } else {
      // Decode — peek just the magic bytes instead of reading the whole
      // (potentially multi-GB) compressed file into memory.
      let decodeType = 'decode-json';
      const handle = await open(currentInputPath, 'r');
      try {
        const magicBuf = Buffer.alloc(4);
        await handle.read(magicBuf, 0, 4, 0);
        const magic = magicBuf.toString('ascii');
        if (magic === 'VCEO') decodeType = 'decode-bin';
        else if (magic === 'VCTX') decodeType = 'decode-context';
      } finally {
        await handle.close();
      }

      const videoPath = `${outputPath}.mp4`;
      setProgress(id, { stage: 'Decoding', percent: 0, done: false });
      await runCommand(RUST_BINARY, [decodeType, currentInputPath, videoPath], (pct) =>
        setProgress(id, { stage: 'Decoding', percent: pct, done: false })
      );

      // The decoded plaintext might be a packed folder/batch archive rather
      // than a single video — peek its magic bytes to tell which.
      const peekBuf = Buffer.alloc(4);
      const peekHandle = await open(videoPath, 'r');
      try {
        await peekHandle.read(peekBuf, 0, 4, 0);
      } finally {
        await peekHandle.close();
      }

      if (isPackFile(peekBuf)) {
        setProgress(id, { stage: 'Unpacking archive', percent: 0, done: false });
        const extractDir = `${outputPath}_extracted`;
        await mkdir(extractDir, { recursive: true });
        await unpackFile(videoPath, extractDir);

        setProgress(id, { stage: 'Zipping archive', percent: 0, done: false });
        const zipPath = `${outputPath}.zip`;
        await zipDirectory(extractDir, zipPath);

        setProgress(id, { stage: 'Complete', percent: 100, done: true });
        return streamFileAsResponse(zipPath, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="decoded_archive.zip"`,
          'X-Job-Id': id,
        });
      }

      let filename = 'decoded_video.mp4';
      if (decodeType === 'decode-json') {
        // Only the json container needs a full read — inherent to the format
        // (base64+JSON can't be scanned for a header the way the binary ones can).
        try {
          const inputBuffer = await readFile(currentInputPath);
          const parsed = JSON.parse(inputBuffer.toString('utf-8'));
          filename = parsed.metadata?.filename || parsed.filename || filename;
        } catch {}
      }

      setProgress(id, { stage: 'Complete', percent: 100, done: true });

      return streamFileAsResponse(videoPath, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Job-Id': id,
      });
    }
  } catch (error: unknown) {
    const error_obj = error instanceof Error ? error : new Error(String(error));
    console.error('Conversion error:', error_obj);
    setProgress(id, { stage: 'Error', percent: 0, done: true, error: error_obj.message });
    return NextResponse.json(
      { error: 'Engine conversion failed', details: error_obj.message },
      { status: 500 }
    );
  } finally {
    // Guaranteed Session-Wide Cleanup — deferred to the stream's own close/error
    // handler on the success paths so we don't delete a file mid-download.
    if (!cleanupHandledByStream) {
      await hardenedCleanup();
    }
    setTimeout(() => clearProgress(id), 5000);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
