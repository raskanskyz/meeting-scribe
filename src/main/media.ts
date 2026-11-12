import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Serves a recording file for media:// with HTTP range support. Chromium seeks
 * by asking for `Range: bytes=N-`; net.fetch(file://) ignores that and answers
 * 200 from byte 0, which kills the player on the first seek past the buffer.
 * Only paths inside `base` are served.
 */
export function serveMedia(base: string, rel: string, range: string | null): Response {
  const root = path.normalize(base);
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root + path.sep)) {
    return new Response("forbidden", { status: 403 });
  }
  let size: number;
  try {
    size = fs.statSync(full).size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const headers = { "Content-Type": "video/webm", "Accept-Ranges": "bytes" };

  const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
  if (!m || (!m[1] && !m[2])) {
    return new Response(body(full), {
      headers: { ...headers, "Content-Length": String(size) },
    });
  }
  // "bytes=-N" is the last N bytes
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  return new Response(body(full, start, end), {
    status: 206,
    headers: {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

const body = (full: string, start?: number, end?: number) =>
  Readable.toWeb(fs.createReadStream(full, { start, end })) as ReadableStream;
