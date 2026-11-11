// Password vault. The file is a standard KeePass database (KDBX 4), so it also
// opens in KeePassXC and other KeePass apps. Encryption and key stretching come
// from the kdbxweb and hash-wasm libraries; nothing here invents its own crypto.
// The vault lives only on this computer and is never sent anywhere.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kdbxweb = require('kdbxweb');
const { argon2d, argon2id } = require('hash-wasm');

// KeePass 4 stretches the master password with Argon2; kdbxweb needs to be handed an implementation.
kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type) => {
  const run = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
  return run({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory, // KiB
    iterations,
    hashLength: length,
    parallelism,
    outputType: 'binary',
  }).then((bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
});

const LOCK_AFTER_MS = 5 * 60 * 1000;
const MIN_MASTER = 8;

let file = '';
let db = null;         // the open database while unlocked
let lockTimer = null;

function init(vaultFile) { file = vaultFile; }

function touch() {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(lock, LOCK_AFTER_MS);
}

function lock() {
  db = null;
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}

const status = () => ({ exists: fs.existsSync(file), unlocked: db !== null, file });

const credentials = (master) => new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(master));

async function write() {
  const data = Buffer.from(await db.save());
  // Write beside the real file first, so a crash mid-save cannot destroy the vault.
  const temp = file + '.saving';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

async function create(master) {
  if (fs.existsSync(file)) return { ok: false, message: 'A vault already exists' };
  if (typeof master !== 'string' || master.length < MIN_MASTER) return { ok: false, message: `Use at least ${MIN_MASTER} characters` };
  const fresh = kdbxweb.Kdbx.create(credentials(master), 'Island');
  fresh.meta.recycleBinEnabled = false;
  // Make guessing the master password slow: 64 MB of memory, 3 passes, per attempt.
  const kdf = fresh.header.kdfParameters;
  const T = kdbxweb.VarDictionary.ValueType;
  kdf.set('M', T.UInt64, kdbxweb.Int64.from(64 * 1024 * 1024));
  kdf.set('I', T.UInt64, kdbxweb.Int64.from(3));
  db = fresh;
  await write();
  touch();
  return { ok: true };
}

async function unlock(master) {
  if (!fs.existsSync(file)) return { ok: false, message: 'No vault yet' };
  try {
    const bytes = fs.readFileSync(file);
    db = await kdbxweb.Kdbx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), credentials(String(master)));
    touch();
    return { ok: true };
  } catch (e) {
    db = null;
    const wrong = e && e.code === kdbxweb.Consts.ErrorCodes.InvalidKey;
    return { ok: false, message: wrong ? 'Wrong master password' : 'Could not open the vault file' };
  }
}

function entries() {
  const bin = db.meta.recycleBinUuid;
  const out = [];
  for (const e of db.getDefaultGroup().allEntries()) {
    if (bin && e.parentGroup && e.parentGroup.uuid.equals(bin)) continue;
    out.push(e);
  }
  return out;
}

const text = (e, field) => {
  const v = e.fields.get(field);
  return v instanceof kdbxweb.ProtectedValue ? v.getText() : (v || '');
};
const find = (id) => entries().find((e) => e.uuid.id === id);

/** Titles, usernames and sites only. Passwords stay in here until one is asked for. */
function list() {
  if (!db) return { ok: false, locked: true, items: [] };
  touch();
  const items = entries()
    .map((e) => ({ id: e.uuid.id, title: text(e, 'Title'), user: text(e, 'UserName'), url: text(e, 'URL') }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { ok: true, items };
}

function secret(id) {
  if (!db) return { ok: false, locked: true };
  touch();
  const e = find(id);
  return e ? { ok: true, password: text(e, 'Password'), user: text(e, 'UserName'), notes: text(e, 'Notes') } : { ok: false };
}

async function save(item) {
  if (!db) return { ok: false, locked: true };
  touch();
  const title = String(item.title || '').trim();
  if (!title) return { ok: false, message: 'Give it a name' };
  const e = (item.id && find(item.id)) || db.createEntry(db.getDefaultGroup());
  e.fields.set('Title', title);
  e.fields.set('UserName', String(item.user || ''));
  e.fields.set('URL', String(item.url || ''));
  e.fields.set('Notes', String(item.notes || ''));
  // An empty password while editing means "leave it as it is".
  if (item.password || !item.id) e.fields.set('Password', kdbxweb.ProtectedValue.fromString(String(item.password || '')));
  e.times.update();
  await write();
  return { ok: true, id: e.uuid.id };
}

async function remove(id) {
  if (!db) return { ok: false, locked: true };
  touch();
  const e = find(id);
  if (!e) return { ok: false };
  db.remove(e);
  await write();
  return { ok: true };
}

/** A random password, drawn with the operating system's secure random source. */
function generate(length, symbols) {
  const n = Math.min(64, Math.max(8, Number(length) || 20));
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
  if (symbols) sets.push('!@#$%^&*-_=+?');
  const all = sets.join('');
  // One from each kind first, so every kind is always present, then shuffle.
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < n) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

module.exports = { init, status, create, unlock, lock, list, secret, save, remove, generate };
