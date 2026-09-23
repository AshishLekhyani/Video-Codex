import { createReadStream, createWriteStream } from 'fs';
import { mkdir, open, stat } from 'fs/promises';
import { dirname, join, normalize, sep } from 'path';
import { pipeline } from 'stream/promises';
import { ZipArchive } from 'archiver';

// A minimal archive format for bundling many files (a selected folder, or a
// multi-file selection) into the single blob that the existing single-file
// compress+seal pipeline already knows how to handle — no changes needed
// there. Layout:
//   magic "VPAK" (4 bytes)
//   version: u16 LE (1)
//   entry count: u32 LE
//   for each entry:
//     path length: u16 LE, path: utf8 bytes (forward-slash relative path)
//     content length: u64 LE (as two u32 LE — see writeU64LE), content bytes
export const PACK_MAGIC = 'VPAK';

export interface PackEntry {
  relativePath: string;
  sourcePath: string;
}

function writeU64LE(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(value >>> 0, 0);
  buf.writeUInt32LE(Math.floor(value / 2 ** 32), 4);
  return buf;
}

function readU64LE(buf: Buffer, offset: number): number {
  const low = buf.readUInt32LE(offset);
  const high = buf.readUInt32LE(offset + 4);
  return high * 2 ** 32 + low;
}

// Streams every entry's header + content into one file sequentially, so
// packing hundreds or thousands of files never holds more than one file's
// bytes in memory at a time.
export async function packFiles(entries: PackEntry[], outputPath: string, onProgress?: (pct: number) => void): Promise<void> {
  const out = createWriteStream(outputPath);
  try {
    const header = Buffer.alloc(4 + 2 + 4);
    header.write(PACK_MAGIC, 0, 'ascii');
    header.writeUInt16LE(1, 4);
    header.writeUInt32LE(entries.length, 6);
    await writeChunk(out, header);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const relPath = entry.relativePath.split(sep).join('/');
      const pathBuf = Buffer.from(relPath, 'utf-8');
      const size = (await stat(entry.sourcePath)).size;

      const entryHeader = Buffer.concat([
        u16le(pathBuf.length),
        pathBuf,
        writeU64LE(size),
      ]);
      await writeChunk(out, entryHeader);
      await pipeline(createReadStream(entry.sourcePath), out, { end: false });
      onProgress?.(Math.round(((i + 1) / entries.length) * 100));
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }
}

// Zips a reconstructed folder for delivery — a VPAK archive decodes back into
// a real directory tree, but a browser download has to be a single file.
export function zipDirectory(sourceDir: string, outputZipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function u16le(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

export function isPackFile(buf: Buffer): boolean {
  return buf.length >= 4 && buf.slice(0, 4).toString('ascii') === PACK_MAGIC;
}

export interface UnpackedEntry {
  relativePath: string;
  absolutePath: string;
}

// Reads a VPAK archive and writes each entry out under outputDir, streaming
// entry-by-entry so unpacking thousands of files stays memory-flat.
export async function unpackFile(packPath: string, outputDir: string): Promise<UnpackedEntry[]> {
  const handle = await open(packPath, 'r');
  const results: UnpackedEntry[] = [];
  try {
    const fixedHeader = Buffer.alloc(10);
    await handle.read(fixedHeader, 0, 10, 0);
    if (fixedHeader.slice(0, 4).toString('ascii') !== PACK_MAGIC) {
      throw new Error('Not a VPAK archive');
    }
    const entryCount = fixedHeader.readUInt32LE(6);

    let offset = 10;
    for (let i = 0; i < entryCount; i++) {
      const pathLenBuf = Buffer.alloc(2);
      await handle.read(pathLenBuf, 0, 2, offset);
      const pathLen = pathLenBuf.readUInt16LE(0);
      offset += 2;

      const pathBuf = Buffer.alloc(pathLen);
      await handle.read(pathBuf, 0, pathLen, offset);
      offset += pathLen;

      const sizeBuf = Buffer.alloc(8);
      await handle.read(sizeBuf, 0, 8, offset);
      const size = readU64LE(sizeBuf, 0);
      offset += 8;

      // Reject path traversal / absolute paths from a maliciously crafted archive
      const relPath = pathBuf.toString('utf-8');
      const safeRelPath = normalize(relPath).replace(/^([.][.][/\\])+/, '');
      if (safeRelPath.startsWith('..') || safeRelPath.startsWith(sep) || /^[a-zA-Z]:/.test(safeRelPath)) {
        throw new Error(`Unsafe path in archive: ${relPath}`);
      }

      const destPath = join(outputDir, safeRelPath);
      await mkdir(dirname(destPath), { recursive: true });

      const dest = createWriteStream(destPath);
      const entryStream = createReadStream(packPath, { start: offset, end: offset + size - 1 });
      await pipeline(entryStream, dest);

      results.push({ relativePath: safeRelPath, absolutePath: destPath });
      offset += size;
    }
  } finally {
    await handle.close();
  }
  return results;
}
