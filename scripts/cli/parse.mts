// Decode the fig-kiwi binary into queryable JSON.
// Usage: node parse.mts <canvas.fig> <out-message.json>
// (canvas.fig is the file extracted from the .fig zip — see SKILL.md §1)
// Requires: kiwi-schema (install with npm / pnpm / yarn / bun); zstd needs Node >= 22.15 or Bun.
import * as fs from "fs";
import * as zlib from "zlib";
import { decodeBinarySchema, compileSchema } from "kiwi-schema";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) throw new Error("usage: parse.mts <canvas.fig> <out-message.json>");

const buf = fs.readFileSync(inPath);
const magic = buf.subarray(0, 8).toString("utf8");
if (magic !== "fig-kiwi")
  throw new Error("bad magic: " + magic + " (did you unzip the .fig first?)");
console.error("format version:", buf.readUInt32LE(8));

let offset = 12;
const chunks: Buffer[] = [];
while (offset < buf.length) {
  const size = buf.readUInt32LE(offset);
  offset += 4;
  chunks.push(buf.subarray(offset, offset + size));
  offset += size;
}
console.error(
  "chunk sizes:",
  chunks.map((c) => c.length),
);

// chunk 0 = kiwi schema (raw deflate); chunk 1 = document (zstd in modern files,
// raw deflate in older ones — detect by zstd magic 28 B5 2F FD)
const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(chunks[0])));
const isZstd = chunks[1][0] === 0x28 && chunks[1][1] === 0xb5;
const dataBuf = isZstd ? zlib.zstdDecompressSync(chunks[1]) : zlib.inflateRawSync(chunks[1]);
const message = compileSchema(schema).decodeMessage(new Uint8Array(dataBuf));

fs.writeFileSync(
  outPath,
  JSON.stringify(
    message,
    (k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v),
    1,
  ),
);
console.error("nodeChanges:", message.nodeChanges?.length, "blobs:", message.blobs?.length);
console.error("wrote", outPath);
