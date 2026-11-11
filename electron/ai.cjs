// Ask AI and Translate.
// Ask AI talks to Claude through Anthropic's own library, with an API key the
// user types in themselves. The key is kept encrypted by Windows (DPAPI, via
// Electron's safeStorage) and is never written to disk in the clear.
// Translate uses MyMemory's free public service and needs no key.
const { safeStorage } = require('electron');

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
];
const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = 'You are answering from a small pop-up panel on the user\'s Windows desktop. '
  + 'The panel is narrow and shows plain text, so answer directly and briefly, without Markdown formatting, '
  + 'unless the user asks for something longer.';

let Anthropic = null; // loaded on first use, so it costs nothing until then
let running = null;   // the reply being streamed right now

function sdk() {
  if (!Anthropic) { const m = require('@anthropic-ai/sdk'); Anthropic = m.default || m; }
  return Anthropic;
}

/** store is the island's saved data; the encrypted key lives in store.aiKey. */
function hasKey(store) { return typeof store.aiKey === 'string' && store.aiKey.length > 0; }

function setKey(store, key) {
  const text = String(key || '').trim();
  if (!text) { delete store.aiKey; return { ok: true }; }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'Windows cannot encrypt the key on this account, so it was not saved' };
  store.aiKey = safeStorage.encryptString(text).toString('base64');
  return { ok: true };
}

function readKey(store) {
  try { return safeStorage.decryptString(Buffer.from(store.aiKey, 'base64')); } catch { return ''; }
}

/**
 * Sends the conversation and streams the reply. messages is [{ role: 'user' | 'assistant', content: string }].
 * onText is called with each piece of text as it arrives.
 */
async function ask(store, messages, model, onText) {
  const apiKey = hasKey(store) ? readKey(store) : '';
  if (!apiKey) return { ok: false, message: 'Add your Anthropic API key first' };
  const A = sdk();
  const client = new A({ apiKey });
  const chosen = MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
  const request = {
    model: chosen,
    max_tokens: 64000,
    system: SYSTEM,
    output_config: { effort: 'low' }, // quick questions: answer fast
    messages: messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content).slice(-40),
  };
  try {
    // If the model declines a request, Anthropic can pass it to another model in the same call.
    // Haiku has no such fallback.
    const stream = chosen === 'claude-haiku-5-5'
      ? client.messages.stream(request)
      : client.beta.messages.stream({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    running = stream;
    stream.on('text', (piece) => onText(piece));
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') return { ok: false, message: 'Claude declined to answer that' };
    const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { ok: true, text, cut: final.stop_reason === 'max_tokens' };
  } catch (e) {
    if (e instanceof A.APIUserAbortError) return { ok: false, message: 'Stopped' };
    if (e instanceof A.AuthenticationError) return { ok: false, message: 'That API key was not accepted' };
    if (e instanceof A.PermissionDeniedError) return { ok: false, message: 'This API key is not allowed to use that model' };
    if (e instanceof A.RateLimitError) return { ok: false, message: 'Too many requests just now. Try again in a moment' };
    if (e instanceof A.APIConnectionError) return { ok: false, message: 'Could not reach Anthropic. Check your internet connection' };
    if (e instanceof A.APIError) return { ok: false, message: 'Anthropic answered with an error (' + e.status + ')' };
    return { ok: false, message: 'That did not work' };
  } finally {
    running = null;
  }
}

function stop() { if (running) { try { running.abort(); } catch { /* already finished */ } } }

// ---------- translate ----------

const LANGS = [
  ['en', 'English'], ['hi', 'Hindi'], ['gu', 'Gujarati'], ['mr', 'Marathi'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'],
  ['ur', 'Urdu'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'],
  ['ar', 'Arabic'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-CN', 'Chinese'],
];
const PIECE_BYTES = 450; // the service takes at most 500 bytes at a time
const MOST_PIECES = 12;

/** Cuts text into pieces small enough for the service, at sentence or word ends where it can. */
function pieces(text) {
  const out = [];
  let cur = '';
  for (const word of text.split(/(?<=[\s.!?।])/)) {
    if (Buffer.byteLength(cur + word) > PIECE_BYTES && cur) { out.push(cur); cur = ''; }
    cur += word;
    while (Buffer.byteLength(cur) > PIECE_BYTES) { out.push(cur.slice(0, 140)); cur = cur.slice(140); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

async function translate(text, from, to) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, message: 'Nothing to translate' };
  const codes = LANGS.map((l) => l[0]);
  if (!codes.includes(to) || (from !== 'auto' && !codes.includes(from))) return { ok: false, message: 'Unknown language' };
  const parts = pieces(clean);
  if (parts.length > MOST_PIECES) return { ok: false, message: 'That is too long to translate in one go. Try a shorter passage' };
  const done = [];
  try {
    for (const part of parts) {
      const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(part) + '&langpair=' + encodeURIComponent((from === 'auto' ? 'Autodetect' : from) + '|' + to);
      const res = await fetch(url);
      const data = res.ok ? await res.json() : null;
      const got = data && data.responseData && data.responseData.translatedText;
      if (!got || Number(data.responseStatus) !== 200) return { ok: false, message: Number(data && data.responseStatus) === 429 ? 'The free translation limit for today is used up' : 'The translation service did not answer properly' };
      done.push(got);
    }
  } catch {
    return { ok: false, message: 'Could not reach the translation service' };
  }
  return { ok: true, text: done.join(' ') };
}

module.exports = { MODELS, DEFAULT_MODEL, LANGS, hasKey, setKey, ask, stop, translate };
