import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const uploadsDir = process.env.UPLOADS_DIR ?? '/tmp/document-intelligence/uploads';

export async function saveFile(stream: Readable, filename: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(uploadsDir, date);

  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, filename);
  const buffer = await streamToBuffer(stream);
  await fs.writeFile(filePath, buffer);

  return filePath;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
