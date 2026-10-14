// Reading the first or last lines of a (large) file without loading all of it.

import { open } from "node:fs/promises";

const CHUNK = 1 << 20;
const NEWLINE = 10;

export interface Excerpt {
  text: string;
  /** 0-based line number of the excerpt's first line in the file. */
  firstLine: number;
}

/** The first `maxLines` lines of a file. */
export async function readHead(path: string, maxLines: number): Promise<Excerpt> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let lines = 0;
    let position = 0;
    for (;;) {
      const buffer = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === NEWLINE && ++lines === maxLines) {
          chunks.push(chunk.subarray(0, i + 1));
          return { text: decode(chunks), firstLine: 0 };
        }
      }
      chunks.push(chunk);
      position += bytesRead;
    }
    return { text: decode(chunks), firstLine: 0 };
  } finally {
    await handle.close();
  }
}

/** The last `maxLines` lines of a file, with the line number they start at. */
export async function readTail(path: string, maxLines: number): Promise<Excerpt> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const chunks: Buffer[] = [];
    let position = size;
    let lines = 0;
    let start = 0;
    search: while (position > 0) {
      const length = Math.min(CHUNK, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      chunks.unshift(buffer);
      for (let i = length - 1; i >= 0; i--) {
        // A newline at the very end does not start another line.
        if (buffer[i] === NEWLINE && position + i !== size - 1 && ++lines === maxLines) {
          start = position + i + 1;
          break search;
        }
      }
    }
    const text = Buffer.concat(chunks).subarray(start - position).toString("utf8");
    return { text, firstLine: start > 0 ? await countLines(handle, start) : 0 };
  } finally {
    await handle.close();
  }
}

/** Number of newlines in the first `end` bytes. */
async function countLines(handle: Awaited<ReturnType<typeof open>>, end: number): Promise<number> {
  let count = 0;
  const buffer = Buffer.alloc(CHUNK);
  for (let position = 0; position < end; ) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, end - position), position);
    if (bytesRead === 0) break;
    for (let i = 0; i < bytesRead; i++) if (buffer[i] === NEWLINE) count++;
    position += bytesRead;
  }
  return count;
}

function decode(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

/** The first or last `maxLines` lines of a text already in memory. */
export function excerpt(text: string, mode: "head" | "tail", maxLines: number): Excerpt {
  if (mode === "head") {
    let index = -1;
    for (let lines = 0; lines < maxLines; lines++) {
      index = text.indexOf("\n", index + 1);
      if (index < 0) return { text, firstLine: 0 };
    }
    return { text: text.slice(0, index + 1), firstLine: 0 };
  }
  let index = text.endsWith("\n") ? text.length - 1 : text.length;
  for (let lines = 0; lines < maxLines; lines++) {
    index = text.lastIndexOf("\n", index - 1);
    if (index < 0) return { text, firstLine: 0 };
  }
  let firstLine = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i <= index; i = text.indexOf("\n", i + 1)) firstLine++;
  return { text: text.slice(index + 1), firstLine };
}
