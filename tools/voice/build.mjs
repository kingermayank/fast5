// The game's recorded dialogue (see src/voice.ts).
//
//   node tools/voice/build.mjs plan
//     Lists every take to record: its file name, who says it (CREW lines once for DOM and once
//     for BRIAN) and the text to send to ElevenLabs (with its audio tags).
//   node tools/voice/build.mjs build <dir of recordings named <file>.mp3>
//     Trims the silence off each recording, makes it a small mono mp3 in public/voice/, and
//     writes public/voice/lines.json ("WHO|text" -> file), which the game loads.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { lines } = JSON.parse(fs.readFileSync(path.join(root, 'tools/voice/script.json'), 'utf8'));

function slug(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-');
}

/** Every take: one per line, two for a CREW line. File names are unique and stable for a given script. */
function takes() {
  const out = [];
  const used = new Set();
  for (const line of lines) {
    for (const who of line.who === 'CREW' ? ['DOM', 'BRIAN'] : [line.who]) {
      let file = `${who.toLowerCase()}-${slug(line.text)}`;
      for (let n = 2; used.has(file); n++) file = `${who.toLowerCase()}-${slug(line.text)}-${n}`;
      used.add(file);
      out.push({ file, who, text: line.text, say: line.say ?? line.text });
    }
  }
  return out;
}

const [cmd, dir] = process.argv.slice(2);
if (cmd === 'plan') {
  const all = takes();
  for (const t of all) console.log(JSON.stringify(t));
  const chars = all.reduce((n, t) => n + t.say.length, 0);
  console.error(`${all.length} takes, ${chars} characters`);
} else if (cmd === 'build' && dir) {
  const out = path.join(root, 'public/voice');
  fs.mkdirSync(out, { recursive: true });
  const manifest = {};
  let missing = 0;
  for (const t of takes()) {
    const src = path.join(dir, `${t.file}.mp3`);
    if (!fs.existsSync(src)) {
      console.error('missing', t.file);
      missing++;
      continue;
    }
    // Trim the silence at either end (keeping a breath of it), mono, 64 kb/s: small and quick to start.
    const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,areverse';
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-af', trim, '-ac', '1', '-ar', '44100', '-b:a', '64k', path.join(out, `${t.file}.mp3`)]);
    manifest[`${t.who}|${t.text}`] = `${t.file}.mp3`;
  }
  fs.writeFileSync(path.join(out, 'lines.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log(`${Object.keys(manifest).length} lines in public/voice/lines.json${missing ? `, ${missing} missing` : ''}`);
} else {
  console.error('usage: node tools/voice/build.mjs plan | build <dir>');
  process.exit(1);
}
