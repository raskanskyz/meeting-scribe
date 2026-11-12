// node tests/media.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveMedia } from "../src/main/media.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
fs.mkdirSync(path.join(base, "rec1"));
fs.writeFileSync(path.join(base, "rec1", "mic.webm"), "0123456789");

const get = async (range: string | null, rel = "/rec1/mic.webm") => {
  const r = serveMedia(base, rel, range);
  return { status: r.status, cr: r.headers.get("content-range"), body: await r.text() };
};

assert.deepEqual(await get(null), { status: 200, cr: null, body: "0123456789" });
assert.deepEqual(await get("bytes=0-"), { status: 206, cr: "bytes 0-9/10", body: "0123456789" });
assert.deepEqual(await get("bytes=4-"), { status: 206, cr: "bytes 4-9/10", body: "456789" });
assert.deepEqual(await get("bytes=2-4"), { status: 206, cr: "bytes 2-4/10", body: "234" });
assert.deepEqual(await get("bytes=-3"), { status: 206, cr: "bytes 7-9/10", body: "789" });
assert.deepEqual(await get("bytes=5-99"), { status: 206, cr: "bytes 5-9/10", body: "56789" });
assert.equal((await get("bytes=10-")).status, 416);
assert.equal((await get(null, "/../etc/passwd")).status, 403);
assert.equal((await get(null, "/rec1/nope.webm")).status, 404);

fs.rmSync(base, { recursive: true });
console.log("media ok");
