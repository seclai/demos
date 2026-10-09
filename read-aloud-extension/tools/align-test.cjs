// Accuracy test for the read-aloud word timing in extension/align.js.
// Synthesises each sentence with macOS `say`, joins them with known pauses,
// then compares predicted sentence-start times to the truth.
//
// usage (macOS only): node tools/align-test.cjs

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// align.js exports via module.exports under CommonJS, or a global otherwise.
const loaded = require(path.join(__dirname, '..', 'extension', 'align.js'));
const { findGaps, alignWords } = loaded.findGaps ? loaded : globalThis.__seclaiAlign;

const SR = 22050;
const DIR = path.join(os.tmpdir(), 'read-aloud-align-test');
fs.mkdirSync(DIR, { recursive: true });

const PARAS = [
  "a16z's Olivia Moore on the state of consumer AI",
  "I wrote this week about the bleak economics of consumer AI, but where some see a crisis, others see an opportunity.",
  "Olivia Moore covers consumer AI as a partner at Andreessen Horowitz, and on Monday, she released a report on the top 100 consumer AI apps. ChatGPT is still the biggest player by a mile, but smaller players like Suno and ElevenLabs are showing real staying power. Even more interesting is what we don't see, as Moore's report details half a dozen consumer categories that seem to be completely untouched by AI.",
  "Moore sees a huge opportunity in consumer AI, particularly if the industry can tap into revenue streams beyond just subscriptions and API charges. On a call this week, I talked with her about the unusual economics of consumer AI and why it's still early days for the category.",
  "How can consumer AI products change that revenue problem? The State of Markets report reminded us that just 2.2% of U.S. households are paying for AI. Do we need that number to rise before the market becomes attractive?",
  "I actually don't know if I want to see that user number increase. I'm more interested in getting back to a world where the consumer is monetized in a way that isn't subscription dollars out of their own pocket.",
  "Yeah, I think we're seeing improvements there. Even ChatGPT now has a Go plan, which is just $8 a month, and I'm assuming it runs on cheaper models. We don't necessarily need frontier intelligence for every task, and so that could mean cheaper models, especially for some consumer use cases.",
];

function readWav(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = size / 4;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(off + 8 + i * 4);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function synth(text, i, voice) {
  const file = path.join(DIR, `${voice}_${i}.wav`);
  if (!fs.existsSync(file)) execFileSync('say', ['-v', voice, '-o', file, `--data-format=LEF32@${SR}`, text]);
  return readWav(file);
}

// Seeded random so runs are repeatable.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function build(voice) {
  const pieces = [];
  const truth = []; // start time of each sentence's first word
  const words = [];
  let t = 0.15;
  pieces.push(new Float32Array(Math.round(0.15 * SR)));
  let idx = 0;
  PARAS.forEach((para, p) => {
    const sentences = para.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g).map((s) => s.trim()).filter(Boolean);
    sentences.forEach((s, si) => {
      const audio = synth(s, idx++, voice);
      let on = 0;
      while (on < audio.length && Math.abs(audio[on]) < 0.01) on++;
      truth.push(t + on / SR);
      const ws = s.match(/\S+/g).map((text) => ({ text }));
      ws[0].sentenceStart = truth.length - 1;
      words.push(...ws);
      pieces.push(audio);
      t += audio.length / SR;
      const lastInPara = si === sentences.length - 1;
      if (lastInPara) ws[ws.length - 1].blockEnd = true;
      // Inter-sentence pauses vary like real TTS; paragraph breaks are longer.
      const pause = lastInPara ? 0.45 + rand() * 0.5 : 0.2 + rand() * 0.35;
      pieces.push(new Float32Array(Math.round(pause * SR)));
      t += pause;
    });
  });
  const total = pieces.reduce((a, p) => a + p.length, 0);
  const data = new Float32Array(total);
  let o = 0;
  for (const p of pieces) {
    data.set(p, o);
    o += p.length;
  }
  return { data, truth, words };
}

function score(words, truth) {
  const errs = words.filter((w) => w.sentenceStart !== undefined).map((w) => w.t - truth[w.sentenceStart]);
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  return {
    meanAbs: (abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(3),
    median: abs[Math.floor(abs.length / 2)].toFixed(3),
    max: abs[abs.length - 1].toFixed(3),
    bias: mean.toFixed(3), // + = highlight late, - = highlight early
  };
}

function evenly(words, duration) {
  const total = words.reduce((s, w) => s + w.text.length + 1, 0);
  let acc = 0;
  for (const w of words) {
    w.t = (acc / total) * duration;
    acc += w.text.length + 1;
  }
}

for (const voice of ['Samantha', 'Daniel']) {
  const { data, truth, words } = build(voice);
  const analysis = findGaps(data, SR);
  const clone = () => words.map((w) => ({ ...w }));
  const results = {};

  const e = clone();
  evenly(e, analysis.duration);
  results['even spread (no alignment)'] = score(e, truth);


  const d = clone();
  const info = alignWords(d, analysis);
  results['pause matching'] = score(d, truth);

  console.log(`\n${voice}: ${truth.length} sentences, ${analysis.gaps.length} pauses found, ${info.matched}/${info.boundaries} sentence ends matched, ${analysis.duration.toFixed(1)}s`);
  console.table(results);
}

