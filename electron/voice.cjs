// Voice dictation, fully on this computer: FFmpeg streams the microphone, and
// whisper.cpp turns it into text again and again while you are still speaking,
// so words come out as you go. Nothing is uploaded.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const VENDOR = path.join(__dirname, '..', 'vendor');
const FFMPEG = path.join(VENDOR, 'ffmpeg.exe');
const WHISPER = path.join(VENDOR, 'whisper', 'whisper-cli.exe');
const MODEL = path.join(VENDOR, 'models', 'ggml-small.bin');
const WAV = path.join(os.tmpdir(), 'island-dictation.wav');
const LANGS = new Set(['auto', 'en', 'hi', 'gu']);

const RATE = 16000;            // samples a second, what the speech model expects
const SECOND = RATE * 2;       // bytes a second (16-bit mono)
const FRAME = RATE / 50;       // samples in 20 ms, the unit loudness is measured in
const STEP = 0.9;              // seconds of new sound before listening again
const PAUSE_MS = 700;          // this much quiet ends a sentence
const LONGEST = 22;            // seconds; a longer run-on is cut here
const THREADS = String(Math.max(2, Math.min(10, os.cpus().length - 2)));

let live = null; // the dictation in progress

function ready() {
  if (!fs.existsSync(FFMPEG)) return 'FFmpeg is missing';
  if (!fs.existsSync(WHISPER)) return 'The speech program is missing';
  if (!fs.existsSync(MODEL)) return 'The speech model is missing';
  return '';
}

/** Names of the microphones Windows offers, as FFmpeg sees them. */
function microphones() {
  return new Promise((resolve) => {
    if (!fs.existsSync(FFMPEG)) { resolve([]); return; }
    // FFmpeg prints the device list as an "error" and exits non-zero; that is expected.
    execFile(FFMPEG, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true }, (_err, _out, stderr) => {
      const names = [];
      for (const line of String(stderr).split('\n')) {
        const m = line.match(/"([^"]+)"\s+\(audio\)/);
        if (m && !names.includes(m[1])) names.push(m[1]);
      }
      resolve(names);
    });
  });
}

function wavHeader(bytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(SECOND, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

/** Turns a stretch of raw sound into a list of words. */
function hear(pcm, language) {
  return new Promise((resolve) => {
    const lang = LANGS.has(language) ? language : 'auto';
    const seconds = pcm.length / SECOND;
    // The model normally studies a full 30 seconds; telling it how little there
    // really is makes a short phrase several times quicker.
    const span = String(Math.max(192, Math.min(1500, Math.ceil(seconds * 62) + 48)));
    try { fs.writeFileSync(WAV, Buffer.concat([wavHeader(pcm.length), pcm])); } catch { resolve({ words: [], lang: '' }); return; }
    execFile(WHISPER, ['-m', MODEL, '-f', WAV, '-l', lang, '-t', THREADS, '-nt', '-bs', '1', '-bo', '1', '-nf', '-ac', span],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, cwd: path.dirname(WHISPER) }, (err, stdout, stderr) => {
        if (err) { resolve({ words: [], lang: '' }); return; }
        const found = String(stderr).match(/auto-detected language: ([a-z]+)/);
        const heardIn = found && LANGS.has(found[1]) ? found[1] : '';
        // Drop the model's markers for silence and noise, and tidy the spacing.
        const text = String(stdout).replace(/\[[^\]]*\]|\([a-z ]+\)/gi, ' ').replace(/\s+/g, ' ').trim();
        // On near-silence the model tends to invent one of these; treat them as nothing said.
        if (!text || /^(you|thank you[.!]?|thanks for watching[.!]?)$/i.test(text)) { resolve({ words: [], lang: '' }); return; }
        resolve({ words: text.split(' '), lang: heardIn });
      });
  });
}

const plain = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * A dictation session you feed raw sound into (16 kHz, 16-bit, mono).
 * onWords(text) gets words once they are settled; onPartial(text) gets the
 * running guess of everything said so far, for showing on screen.
 */
function createLive(options) {
  const s = {
    lang: options.language, chunks: [], bytes: 0, passed: 0, carry: null,
    speechMs: 0, quietMs: 0, floor: Infinity,
    prev: [], committed: 0, said: [], running: null, ended: false,
  };
  const give = (words) => {
    if (!words.length) return;
    s.said.push(...words);
    if (options.onWords) options.onWords(words.join(' '));
  };

  async function pass(closing) {
    const pcm = Buffer.concat(s.chunks);
    s.passed = s.bytes;
    if (closing) s.speechMs = 0; // sound arriving from here on belongs to the next sentence
    const heard = await hear(pcm, s.lang);
    const words = heard.words;
    // On Auto, working out the language costs time on every listen; settle it once per dictation.
    if (heard.lang && words.length >= 3 && !LANGS.has(s.lang === 'auto' ? '' : s.lang)) s.lang = heard.lang;
    if (closing) {
      give(words.slice(s.committed));
      // Start the next sentence with whatever arrived while this was being worked out.
      const rest = Buffer.concat(s.chunks).subarray(pcm.length);
      s.chunks = rest.length ? [rest] : [];
      s.bytes = rest.length; s.passed = 0; s.prev = []; s.committed = 0;
    } else {
      // A word is settled once two listens in a row agree on it.
      let same = 0;
      while (same < words.length && same < s.prev.length && plain(words[same]) === plain(s.prev[same])) same++;
      if (same > s.committed) { give(words.slice(s.committed, same)); s.committed = same; }
      s.prev = words;
    }
    if (options.onPartial) options.onPartial([...s.said, ...(closing ? [] : words.slice(s.committed))].join(' '));
  }

  function tick() {
    if (s.running || s.ended) return;
    const seconds = s.bytes / SECOND;
    if (s.speechMs < 200) {
      // Nothing but quiet so far: keep only a short lead-in so the first word is not clipped.
      if (seconds > 1) { const all = Buffer.concat(s.chunks); const keep = all.subarray(all.length - Math.floor(SECOND * 0.4)); s.chunks = [keep]; s.bytes = keep.length; s.passed = 0; }
      return;
    }
    const closing = s.quietMs >= PAUSE_MS || seconds >= LONGEST;
    if (!closing && s.bytes - s.passed < SECOND * STEP) return;
    s.running = pass(closing).catch(() => {}).then(() => { s.running = null; tick(); });
  }

  function feed(data) {
    let buf = s.carry ? Buffer.concat([s.carry, data]) : data;
    s.carry = null;
    if (buf.length % 2) { s.carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
    if (!buf.length || s.ended) return;
    s.chunks.push(buf); s.bytes += buf.length;
    // Loudness, 20 ms at a time, against the quietest the room has been.
    for (let at = 0; at + FRAME * 2 <= buf.length; at += FRAME * 2) {
      let sum = 0;
      for (let i = 0; i < FRAME; i++) { const v = buf.readInt16LE(at + i * 2); sum += v * v; }
      const rms = Math.sqrt(sum / FRAME);
      s.floor = Math.min(rms, s.floor === Infinity ? rms : s.floor + 0.4);
      if (rms > Math.max(s.floor * 3, 220)) { s.speechMs += 20; s.quietMs = 0; } else s.quietMs += 20;
    }
    tick();
  }

  async function finish() {
    s.ended = true;
    if (s.running) await s.running;
    if (s.bytes > SECOND * 0.2 && (s.speechMs >= 200 || s.prev.length > s.committed)) await pass(true);
    return s.said.join(' ');
  }

  return { feed, finish };
}

/** Starts listening. options: language, onWords(text), onPartial(text). */
async function start(mic, options) {
  const problem = ready();
  if (problem) return { ok: false, message: problem };
  if (live) return { ok: true };
  const mics = await microphones();
  const name = mics.includes(mic) ? mic : mics[0];
  if (!name) return { ok: false, message: 'No microphone found' };
  // Raw sound straight down the pipe, in small pieces so there is little delay.
  const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '50', '-i', 'audio=' + name, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const session = createLive(options || {});
  const mine = { proc, session, exited: false, heard: 0 };
  live = mine;
  proc.stdout.on('data', (d) => { mine.heard += d.length; session.feed(d); });
  proc.on('error', () => { mine.exited = true; });
  proc.on('exit', () => { mine.exited = true; });
  return { ok: true, mic: name };
}

/** Stops listening and returns everything that was said. */
async function stop() {
  const mine = live;
  if (!mine) return { ok: false, message: 'Not recording' };
  live = null;
  if (!mine.exited) {
    await new Promise((resolve) => {
      mine.proc.once('exit', resolve);
      // "q" asks FFmpeg to hand over what it still holds; kill it only if it does not listen.
      try { mine.proc.stdin.write('q\n'); } catch { /* already gone */ }
      setTimeout(() => { try { mine.proc.kill(); } catch { /* gone */ } resolve(); }, 1200);
    });
  }
  if (mine.heard < 2000) return { ok: false, message: 'Nothing was recorded' };
  const text = await mine.session.finish();
  return text ? { ok: true, text } : { ok: false, message: 'No speech heard' };
}

function cancel() {
  if (live) { try { live.proc.kill(); } catch { /* gone */ } live = null; }
}

module.exports = { ready, microphones, start, stop, cancel, createLive, isRecording: () => live !== null };
