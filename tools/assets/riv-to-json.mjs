// Wraps the built Rive UI as a JSON string (base64), for hosts that serve JSON
// but not .riv; src/riveui.ts falls back to it:
//   node tools/assets/riv-to-json.mjs <in.riv> <out.riv.json>
import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
await writeFile(output, JSON.stringify((await readFile(input)).toString('base64')));
