// Converts a .glb into a single self-contained glTF JSON file (binary data as a
// base64 data URI), for hosts that serve JSON but not .glb:
//   node tools/assets/to-json.mjs <in.glb> <out.gltf.json>
import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
const b = await readFile(input);
const jsonLength = b.readUInt32LE(12);
const json = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8'));
const binStart = 20 + jsonLength;
const bin = binStart < b.length ? b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart)) : null;
// In a GLB, the buffer without a uri is the binary chunk.
for (const buffer of json.buffers ?? []) {
  if (buffer.uri === undefined && bin && !buffer.extensions?.EXT_meshopt_compression?.fallback) {
    buffer.uri = `data:application/octet-stream;base64,${bin.subarray(0, buffer.byteLength).toString('base64')}`;
  }
}
await writeFile(output, JSON.stringify(json));
