const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard, desktopCapturer, powerSaveBlocker, shell, session, dialog, nativeImage, Tray, Menu } = require('electron');
const voice = require('./voice.cjs');
const { createPeer } = require('./phone.cjs');
const { createKde } = require('./kde.cjs');
const { createShare } = require('./share.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// The heavy parts (PDF and picture tools, the password vault, the AI library) are
// only loaded the first time they are used, so they cost no memory until then.
const lazy = (load) => { let got = null; return () => got || (got = load()); };
const filetoolsOf = lazy(() => require('./filetools.cjs'));
const aiOf = lazy(() => require('./ai.cjs'));
let vaultLoaded = null;
const vaultOf = () => {
  if (!vaultLoaded) {
    vaultLoaded = require('./vault.cjs');
    // Kept in the app's own data folder. Documents can live in OneDrive, where creating
    // a folder may hang for ever, which once froze the whole island when a vault was made.
    vaultLoaded.init(path.join(app.getPath('userData'), 'vault.kdbx'));
  }
  return vaultLoaded;
};
// So the rest of the file can keep saying filetools.x and vault.x.
const filetools = new Proxy({}, { get: (_t, k) => filetoolsOf()[k] });
const vault = new Proxy({}, { get: (_t, k) => vaultOf()[k] });

// The island: one transparent window at the top centre of the screen.
const WIN_W = 460;
const WIN_H = 360;
// The sticky notes: one transparent window down the right edge.
const STICKY_W = 284;

// Weather comes from Open-Meteo (free, no account). Only the coordinates are sent.
// This is the starting place; Settings can change it to any city.
const DEFAULT_PLACE = { city: 'Surat', lat: 21.1702, lon: 72.8311 };
const WEATHER_EVERY_MS = 15 * 60 * 1000;

// On this laptop's mixed graphics setup, a see-through window drawn on the GPU
// turns solid black whenever it repaints. Drawing on the CPU avoids that.
if (!process.env.ISLAND_GPU) app.disableHardwareAcceleration();

let win = null;       // the island
let stickyWin = null; // sticky notes
let drawWin = null;   // draw-on-screen overlay, only while in use
let stageWin = null;  // full-screen single-subject view, only while in use
let helper = null;
let weather = null;
let media = null;

const alive = (w) => w && !w.isDestroyed();
const send = (channel, payload) => {
  if (alive(win)) win.webContents.send(channel, payload);
  if (alive(stageWin)) stageWin.webContents.send(channel, payload);
};
const log = (text) => { if (process.env.ISLAND_LOG) fs.appendFileSync(process.env.ISLAND_LOG, `${Date.now()} ${text}\n`); };
const page = (query) => [path.join(__dirname, '..', 'dist', 'index.html'), { query }];

// ---------- saved data (stickies, clocks, clipboard history...) ----------

let store = {};
let storeFile = '';
let storeTimer = null;

function loadStore() {
  storeFile = path.join(app.getPath('userData'), 'island-data.json');
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^﻿/, '')) || {}; } catch { store = {}; }
}
function saveStoreSoon() {
  if (storeTimer) return;
  storeTimer = setTimeout(() => {
    storeTimer = null;
    try { fs.writeFileSync(storeFile, JSON.stringify(store)); } catch { /* disk full or locked: try again on the next change */ }
  }, 400);
}

// ---------- settings ----------
// Everything the Settings panel can change lives in store.settings. Anything missing
// falls back to these.
const SETTING_DEFAULTS = {
  theme: 'black',      // black | graphite | midnight | light
  scale: 1,            // 0.9 | 1 | 1.15 | 1.3
  clock24: false,
  unit: 'c',           // c | f
  place: null,         // { city, lat, lon }; null means DEFAULT_PLACE
  peek: true,          // drop down briefly when the song changes or charging starts
  sounds: true,        // beep for reminders, timers and calls
  lyrics: true,
  clipHistory: true,
  winNotes: true,      // show other Windows apps' notifications
  phoneNotes: true,    // show the paired phone's notifications
  hidden: [],          // ids of tool tiles that are switched off
};
const settings = () => ({ ...SETTING_DEFAULTS, ...(store.settings && typeof store.settings === 'object' ? store.settings : {}) });
const scaleNow = () => { const s = Number(settings().scale); return [0.9, 1, 1.15, 1.3].includes(s) ? s : 1; };
const placeNow = () => { const p = settings().place; return p && typeof p.lat === 'number' && typeof p.lon === 'number' ? { city: String(p.city || 'Here').slice(0, 40), lat: p.lat, lon: p.lon } : DEFAULT_PLACE; };

// ---------- pointer ----------
// Each see-through window tells us which part of itself is "solid". We watch the
// real pointer and switch click-through on and off ourselves, because mouse
// events stop arriving the moment the pointer leaves a window.

const watched = new Map(); // window id -> { win, zone, inside }
let picking = false; // true while one of our file pickers is open

function watchPointer(w) {
  const id = w.id;
  watched.set(id, { win: w, zone: null, inside: false });
  w.setIgnoreMouseEvents(true);
  // A file picker takes focus away; that must not count as "clicked outside".
  w.on('blur', () => { if (alive(w) && !picking) w.webContents.send('blur'); });
  w.on('closed', () => watched.delete(id));
  const moved = () => { const entry = watched.get(id); if (entry) entry.bounds = null; };
  w.on('move', moved);
  w.on('resize', moved);
}

function checkPointer() {
  const p = screen.getCursorScreenPoint();
  let any = false;
  for (const entry of watched.values()) {
    const w = entry.win;
    if (!alive(w) || !w.isVisible() || !entry.zone) continue;
    const b = entry.bounds || (entry.bounds = w.getBounds()); // our windows never move by themselves
    const x = p.x - b.x, y = p.y - b.y, z = entry.zone;
    const inside = x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h;
    if (inside) any = true;
    if (inside === entry.inside) continue;
    entry.inside = inside;
    w.setIgnoreMouseEvents(!inside);
    w.webContents.send('hover', inside);
    if (w === win) log(`hover=${inside} cursor=${p.x},${p.y}`);
  }
  return any;
}

// Looks often while the pointer is on the island, and lazily the rest of the time.
function pointerLoop() {
  const any = checkPointer();
  setTimeout(pointerLoop, any ? 25 : 70);
}

// ---------- windows ----------

function baseOptions(extra) {
  return {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, spellcheck: false },
    ...extra,
  };
}

/** Where the island window sits: top centre, sized for the chosen scale. */
function islandBounds() {
  const d = screen.getPrimaryDisplay().bounds;
  const k = scaleNow();
  const w = Math.round(WIN_W * k), h = Math.round(WIN_H * k);
  return { width: w, height: h, x: Math.round(d.x + (d.width - w) / 2), y: d.y };
}

function createIsland() {
  win = new BrowserWindow(baseOptions(islandBounds()));
  win.setAlwaysOnTop(true, 'screen-saver');
  watchPointer(win);
  const query = { view: 'island' };
  if (process.env.ISLAND_FORCE_OPEN) query.open = '1';
  if (process.env.ISLAND_PANEL) query.panel = process.env.ISLAND_PANEL;
  if (process.env.ISLAND_THEME) query.theme = process.env.ISLAND_THEME; // for trying a colour without saving it
  win.loadFile(...page(query));
  win.once('ready-to-show', () => win.showInactive());
}

// The notes window is a whole extra page, so it only exists while notes are docked on the screen edge.
function createStickies() {
  if (alive(stickyWin) || store.stickyDock === false) return;
  const d = screen.getPrimaryDisplay().workArea;
  const h = Math.min(620, d.height - 120);
  stickyWin = new BrowserWindow(baseOptions({ width: STICKY_W, height: h, x: d.x + d.width - STICKY_W, y: d.y + Math.round((d.height - h) / 2) }));
  stickyWin.setAlwaysOnTop(true, 'floating');
  watchPointer(stickyWin);
  const query = { view: 'stickies' };
  if (process.env.ISLAND_STICKY_OPEN) query.open = '1';
  stickyWin.loadFile(...page(query));
  const w = stickyWin;
  w.once('ready-to-show', () => { if (store.stickyDock !== false && !hiddenByUser) w.showInactive(); });
  w.on('closed', () => { if (stickyWin === w) stickyWin = null; });
}

let snipWin = null; // the dim sheet for choosing an area, only while in use

function openSnip() {
  if (alive(snipWin)) { snipWin.focus(); return; }
  const d = screen.getPrimaryDisplay().bounds;
  snipWin = new BrowserWindow(baseOptions({ x: d.x, y: d.y, width: d.width, height: d.height, skipTaskbar: false }));
  snipWin.setAlwaysOnTop(true, 'screen-saver');
  snipWin.loadFile(...page({ view: 'snip' }));
  const w = snipWin;
  w.once('ready-to-show', () => { w.show(); w.focus(); });
  w.on('closed', () => { if (snipWin === w) snipWin = null; });
}

function openDraw() {
  if (alive(drawWin)) { drawWin.focus(); return; }
  const d = screen.getPrimaryDisplay().bounds;
  drawWin = new BrowserWindow(baseOptions({ x: d.x, y: d.y, width: d.width, height: d.height, skipTaskbar: false }));
  drawWin.setAlwaysOnTop(true, 'screen-saver');
  drawWin.loadFile(...page({ view: 'draw' }));
  drawWin.once('ready-to-show', () => { drawWin.show(); drawWin.focus(); });
  drawWin.on('closed', () => { drawWin = null; });
}

function openStage(mode) {
  const safe = ['clock', 'music', 'power', 'claude', 'timer'].includes(mode) ? mode : 'clock';
  if (alive(stageWin)) { stageWin.close(); }
  const d = screen.getPrimaryDisplay().bounds;
  // A plain black window: nothing see-through, so it draws fast at full size.
  stageWin = new BrowserWindow(baseOptions({ x: d.x, y: d.y, width: d.width, height: d.height, transparent: false, backgroundColor: '#000000', skipTaskbar: false }));
  stageWin.setAlwaysOnTop(true, 'screen-saver');
  stageWin.loadFile(...page({ view: 'stage', mode: safe }));
  const w = stageWin;
  w.once('ready-to-show', () => { w.show(); w.focus(); });
  w.on('closed', () => { if (stageWin === w) stageWin = null; });
}

// ---------- helper (media) ----------

function startHelper() {
  const exe = path.join(__dirname, '..', 'helper', 'bin', 'Release', 'net9.0-windows10.0.19041.0', 'IslandHelper.exe');
  if (!fs.existsSync(exe)) return;
  helper = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.blur !== undefined) continue;
      if (msg.hold !== undefined) { voiceKeys(!!msg.hold); continue; }
      if (msg.clip !== undefined) { readClipboard(); continue; }
      if (msg.notes !== undefined) { winNotesState = String(msg.notes); continue; }
      if (msg.note) { if (settings().winNotes) send('win-note', { app: String(msg.note.app || ''), title: String(msg.note.title || ''), text: String(msg.note.text || '').slice(0, 300) }); continue; }
      if (msg.radio !== undefined) { const done = radioWaiting.get(msg.radio); if (done) { radioWaiting.delete(msg.radio); done({ ok: !!msg.ok, on: !!msg.on, why: msg.why || '' }); } continue; }
      if (msg.ocr !== undefined) { const done = ocrWaiting.get(msg.ocr); if (done) { ocrWaiting.delete(msg.ocr); done({ ok: !!msg.ok, text: msg.text || '' }); } continue; }
      // The laptop's main volume rides along with every report.
      if (typeof msg.vol === 'number' && msg.vol >= 0) {
        const next = { level: Math.round(msg.vol * 100) / 100, muted: !!msg.muted };
        if (next.level !== volume.level || next.muted !== volume.muted) { volume = next; send('volume', volume); }
      }
      if (msg.none) media = null;
      else {
        // The cover picture is only sent when the track changes; keep the last one.
        const art = msg.artChanged ? (msg.art || null) : (media ? media.art : null);
        media = { title: msg.title || '', artist: msg.artist || '', app: msg.app || '', site: msg.site || '', playing: !!msg.playing, pos: Number(msg.pos) || 0, dur: Number(msg.dur) || 0, art };
      }
      // While the island is tucked away nobody can see the seconds tick, so only real
      // changes (a new song, play or pause) are passed on then.
      const key = media ? media.title + '|' + media.artist + '|' + media.playing + '|' + (media.art ? media.art.length : 0) : '';
      if (presence.visible || alive(stageWin) || key !== mediaKey) send('media', media);
      mediaKey = key;
      wantLyrics();
    }
  });
  helper.on('exit', () => { helper = null; });
  if (settings().winNotes) helper.stdin.write('notes on\n');
}

let mediaKey = '';
let presence = { open: false, visible: false }; // what the island says about itself
let winNotesState = ''; // 'allowed', 'denied' or 'failed', as Windows answered

/** Night light: same question-and-answer route as the radios. */
function nightLight(action) {
  return new Promise((resolve) => {
    if (!helper) { resolve({ ok: false, on: false, why: 'failed' }); return; }
    const id = 'n' + Date.now() + Math.random().toString(36).slice(2, 6);
    radioWaiting.set(id, resolve);
    helper.stdin.write('night ' + id + ' ' + (action === 'toggle' ? 'toggle' : 'state') + '\n');
    setTimeout(() => { if (radioWaiting.delete(id)) resolve({ ok: false, on: false, why: 'failed' }); }, 4000);
  });
}

// ---------- text from a picture ----------

const ocrWaiting = new Map(); // request id -> callback
const radioWaiting = new Map();

/** Switches Wi-Fi or Bluetooth (action 'toggle'), or only asks whether it is on ('state'). */
function radio(kind, action) {
  return new Promise((resolve) => {
    if (!helper || !['wifi', 'bluetooth'].includes(kind)) { resolve({ ok: false, on: false, why: 'failed' }); return; }
    const id = 'r' + Date.now() + Math.random().toString(36).slice(2, 6);
    radioWaiting.set(id, resolve);
    helper.stdin.write('radio ' + id + ' ' + kind + ' ' + (action === 'toggle' ? 'toggle' : 'state') + '\n');
    setTimeout(() => { if (radioWaiting.delete(id)) resolve({ ok: false, on: false, why: 'failed' }); }, 8000);
  });
}
let ocrSeq = 0;

function readText(file) {
  return new Promise((resolve) => {
    if (!helper) { resolve({ ok: false, text: '' }); return; }
    const id = String(++ocrSeq);
    ocrWaiting.set(id, resolve);
    helper.stdin.write('ocr ' + id + ' ' + Buffer.from(file, 'utf8').toString('base64') + '\n');
    setTimeout(() => { if (ocrWaiting.delete(id)) resolve({ ok: false, text: '' }); }, 20000);
  });
}

// ---------- voice dictation ----------

let voiceState = { state: 'idle', since: 0 }; // idle | listening | working

function setVoice(state) {
  voiceState = { state, since: Date.now() };
  send('voice', voiceState);
}

let voiceTyping = false; // this dictation types into the app that has the cursor
let typeQueue = '';      // settled words waiting to be typed

/** Types what is waiting, unless the shortcut keys are still held (they would turn letters into shortcuts). */
function flushTyping() {
  if (!typeQueue || keysDown || !helper) return;
  helper.stdin.write('type ' + Buffer.from(typeQueue, 'utf8').toString('base64') + '\n');
  typeQueue = '';
}

async function voiceStart(typeIt) {
  if (voiceState.state !== 'idle') return { ok: false, message: 'Already busy' };
  voiceTyping = !!(typeIt && helper);
  typeQueue = '';
  const r = await voice.start(store.voiceMic, {
    language: store.voiceLang || 'auto',
    onWords: (words) => { if (voiceTyping) { typeQueue += words + ' '; flushTyping(); } },
    onPartial: (text) => send('voice-partial', text),
  });
  if (r.ok) { send('voice-partial', ''); setVoice('listening'); }
  else send('voice-result', { ok: false, message: r.message, typed: false });
  return r;
}

/** Stops listening. The last few words are typed (or shown) once they are worked out. */
async function voiceStop() {
  if (voiceState.state !== 'listening') return { ok: false, message: 'Not listening' };
  setVoice('working');
  const r = await voice.stop();
  setVoice('idle');
  flushTyping();
  if (r.ok) {
    lastClip = r.text; // dictation is not clipboard history
    clipboard.writeText(r.text);
    store.voiceHistory = [{ text: r.text, at: Date.now() }, ...(Array.isArray(store.voiceHistory) ? store.voiceHistory : [])].slice(0, 20);
    saveStoreSoon();
  }
  send('voice-result', { ...r, typed: voiceTyping && r.ok });
  return r;
}
// Ctrl+Alt+Space works two ways. Hold it while you speak and let go: the words
// are typed. Or tap it to start and tap again to stop.
const HOLD_MS = 600; // shorter than this counts as a tap
let keysDown = false;
let keysAt = 0;
let tapEnded = false; // this press stopped a recording that an earlier tap started

function voiceHotkey() {
  if (keysDown) return; // the key repeating while held
  keysDown = true;
  keysAt = Date.now();
  tapEnded = false;
  if (helper) helper.stdin.write('hold\n'); // ask to be told when the keys come up
  if (voiceState.state === 'listening') { tapEnded = true; voiceStop(); }
  else if (voiceState.state === 'idle') voiceStart(true);
  // Without the helper nothing reports the release, so stop treating it as held after a moment.
  if (!helper) setTimeout(() => { keysDown = false; }, 800);
}

function voiceKeys(down) {
  if (down || !keysDown) return;
  keysDown = false;
  flushTyping();
  if (!tapEnded && voiceState.state === 'listening' && Date.now() - keysAt >= HOLD_MS) voiceStop();
}

// ---------- phone link ----------

let peer = null;
let phoneError = '';
let phoneRequests = []; // transfers waiting for Accept or Decline

function phoneAlias() { return String(store.phoneAlias || os.hostname() || 'Island').slice(0, 40); }

// Phones seen before are kept, so yours stays in the list even while its app is closed.
function rememberPhones(devices) {
  const known = store.phoneKnown && typeof store.phoneKnown === 'object' ? store.phoneKnown : {};
  for (const d of devices) known[d.fingerprint] = { fingerprint: d.fingerprint, alias: d.alias, ip: d.ip, port: d.port, protocol: d.protocol, type: d.type };
  store.phoneKnown = known;
  saveStoreSoon();
}

function phoneList() {
  const live = peer ? peer.list() : [];
  const seen = new Set(live.map((d) => d.fingerprint));
  const known = store.phoneKnown && typeof store.phoneKnown === 'object' ? Object.values(store.phoneKnown) : [];
  return [...live, ...known.filter((d) => !seen.has(d.fingerprint)).map((d) => ({ ...d, seen: 0 }))];
}

/** Sends to a phone. If it does not answer where it was last seen, looks for it again first. */
async function phoneSend(fingerprint, files, text) {
  if (!peer) return { ok: false, message: 'The phone link is not running' };
  let d = phoneList().find((x) => x.fingerprint === fingerprint);
  if (!d) return { ok: false, message: 'That device is not known any more' };
  let r = await peer.send(d, files, text);
  if (!r.ok && r.message === 'Could not reach the device') {
    await peer.scan();
    d = peer.list().find((x) => x.fingerprint === fingerprint);
    if (d) r = await peer.send(d, files, text);
    if (!r.ok && r.message === 'Could not reach the device') r = { ok: false, message: 'Your phone is not answering. Open the LocalSend app on it, keep it on screen, and try again.' };
  }
  return r;
}

function startPhone() {
  peer = createPeer({
    alias: phoneAlias(),
    saveDir: path.join(app.getPath('downloads'), 'Island'),
    certFile: path.join(app.getPath('userData'), 'phone-identity.json'),
    isTrusted: (fingerprint) => Array.isArray(store.phoneTrusted) && store.phoneTrusted.includes(fingerprint),
    onEvent: (name, p) => {
      if (name === 'devices') { rememberPhones(p); send('phone-devices', phoneList()); }
      else if (name === 'request') { phoneRequests.push(p); send('phone-requests', phoneRequests); }
      else if (name === 'request-gone') { phoneRequests = phoneRequests.filter((r) => r.id !== p); send('phone-requests', phoneRequests); }
      else if (name === 'text') { clipboard.writeText(p.text); send('phone-event', { kind: 'text', from: p.from, text: p.text }); }
      else if (name === 'received') {
        for (const f of p.files) ourFiles.add(f);
        store.phoneReceived = [...p.files.map((f) => ({ file: f, from: p.from, at: Date.now() })).reverse(), ...(Array.isArray(store.phoneReceived) ? store.phoneReceived : [])].slice(0, 12);
        saveStoreSoon();
        send('phone-event', { kind: 'files', from: p.from, files: p.files });
      }
    },
  });
  peer.start().catch((e) => {
    phoneError = e && e.code === 'EADDRINUSE' ? 'Another app is already using the phone link port.' : 'The phone link could not start.';
    peer = null;
  });
}

// ---------- phone companion (notifications, calls, battery, clipboard) ----------

let kde = null;
let kdeError = '';
const clipSync = () => store.kdeClipboard !== false;

function startKde() {
  if (!store.kdePaired || typeof store.kdePaired !== 'object') store.kdePaired = {};
  kde = createKde({
    name: phoneAlias(),
    identityFile: path.join(app.getPath('userData'), 'companion-identity.json'),
    paired: store.kdePaired,
    onPairedChange: (p) => { store.kdePaired = p; saveStoreSoon(); },
    onEvent: (name, p) => {
      if (name === 'devices') send('companion-devices', p);
      else if (name === 'pair-request') send('companion-pair', p);
      else if (name === 'notification') { if (settings().phoneNotes) send('companion-note', p); }
      else if (name === 'call') send('companion-call', p);
      else if (name === 'clipboard' && clipSync()) { lastClip = p.text; clipboard.writeText(p.text); }
    },
  });
  kde.start().catch((e) => {
    kdeError = e && e.code === 'EADDRINUSE' ? 'Another app (perhaps KDE Connect for Windows) is already using the companion port.' : 'The phone companion link could not start.';
    kde = null;
  });
}

// ---------- file pickers ----------

const FILTERS = {
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }],
  archive: [{ name: 'Archives', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz'] }],
  video: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'm4v', 'gif'] }],
  audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] }],
  any: [{ name: 'All files', extensions: ['*'] }],
};
const ourFiles = new Set(); // results we produced, which "Show in folder" may open

async function pick(kind, multi) {
  picking = true;
  try {
    const r = await dialog.showOpenDialog({ properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: FILTERS[kind] || FILTERS.any });
    return r.canceled ? [] : r.filePaths;
  } finally {
    picking = false;
    if (alive(win)) win.focus();
  }
}

async function guarded(work) {
  try {
    const r = await work();
    if (r && r.ok && r.file) ourFiles.add(r.file);
    return r;
  } catch (e) {
    return { ok: false, message: 'That did not work: ' + (e && e.message ? String(e.message).slice(0, 120) : 'unknown error') };
  }
}

// ---------- volume and lyrics ----------

let volume = { level: -1, muted: false };
let lyrics = { key: '', lines: [] }; // lines: [{ t: seconds, text }]

function parseLrc(text) {
  const lines = [];
  for (const row of String(text || '').split('\n')) {
    const m = row.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** Looks up time-synced lyrics for the current song on lrclib.net. Only the title, artist and length are sent. */
async function wantLyrics() {
  const key = media && media.title ? media.title + '|' + media.artist : '';
  if (key === lyrics.key) return;
  lyrics = { key, lines: [] };
  send('lyrics', lyrics);
  if (!key || store.lyricsOff || !settings().lyrics) return;
  const title = media.title, artist = media.artist, dur = Math.round(media.dur || 0);
  try {
    const q = 'track_name=' + encodeURIComponent(title) + '&artist_name=' + encodeURIComponent(artist);
    const headers = { 'User-Agent': 'IslandDesktop/0.1' };
    let found = '';
    let res = await fetch('https://lrclib.net/api/get?' + q + (dur ? '&duration=' + dur : ''), { headers });
    if (res.ok) found = (await res.json()).syncedLyrics || '';
    if (!found) {
      res = await fetch('https://lrclib.net/api/search?' + q, { headers });
      if (res.ok) { const hit = (await res.json()).find((r) => r.syncedLyrics); if (hit) found = hit.syncedLyrics; }
    }
    if (lyrics.key !== key) return; // the song changed while we were asking
    lyrics = { key, lines: parseLrc(found) };
    send('lyrics', lyrics);
  } catch { /* offline, or no lyrics for this one */ }
}

// ---------- weather ----------

async function refreshWeather() {
  const place = placeNow();
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + place.lat
      + '&longitude=' + place.lon
      + '&current=temperature_2m,weather_code,is_day,relative_humidity_2m,wind_speed_10m,apparent_temperature'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5'
      + (settings().unit === 'f' ? '&temperature_unit=fahrenheit' : '');
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const cur = data.current;
    if (!cur || typeof cur.temperature_2m !== 'number') return;
    const days = [];
    const dl = data.daily;
    if (dl && Array.isArray(dl.time)) {
      for (let i = 0; i < dl.time.length; i++) {
        days.push({ date: String(dl.time[i]), code: Number(dl.weather_code[i]) || 0, max: Math.round(dl.temperature_2m_max[i]), min: Math.round(dl.temperature_2m_min[i]) });
      }
    }
    weather = {
      city: place.city,
      unit: settings().unit === 'f' ? 'F' : 'C',
      temp: Math.round(cur.temperature_2m),
      feels: Math.round(cur.apparent_temperature),
      humidity: Math.round(cur.relative_humidity_2m),
      wind: Math.round(cur.wind_speed_10m),
      code: Number(cur.weather_code) || 0,
      day: cur.is_day === 1,
      days,
    };
    send('weather', weather);
  } catch { /* offline: keep the last reading */ }
}

// ---------- clipboard history ----------

const CLIP_MAX = 30;
let clips = [];
let lastClip = '';

// A clip is either copied text (a string) or a copied picture:
// { image: path of the saved PNG, thumb: small preview, w, h, id }.
const CLIP_PICTURES = 8; // pictures are big, so only the newest few are kept
let lastPicture = '';
const clipDir = () => path.join(app.getPath('userData'), 'clips');
const isPicture = (c) => c && typeof c === 'object' && typeof c.image === 'string';

function setClips(next) {
  // Drop the oldest pictures beyond the limit, and delete the files of any that fell off.
  let pictures = 0;
  const kept = next.filter((c) => !isPicture(c) || ++pictures <= CLIP_PICTURES).slice(0, CLIP_MAX);
  for (const c of clips) if (isPicture(c) && !kept.includes(c)) fs.rm(c.image, { force: true }, () => {});
  clips = kept;
  store.clips = clips;
  saveStoreSoon();
  send('clips', clips);
}

function readClipboard() {
  if (!settings().clipHistory) return;
  let text = '';
  try { text = clipboard.readText(); } catch { return; }
  if (text) {
    if (text === lastClip) return;
    lastClip = text;
    if (text.length > 20000 || !text.trim()) return;
    // Copy on the laptop, paste on the phone.
    if (kde && clipSync()) kde.sendClipboard(text);
    setClips([text, ...clips.filter((c) => c !== text)]);
    return;
  }
  // No text: perhaps a picture (a screenshot, or "Copy image" in a browser).
  let img = null;
  try { if (clipboard.availableFormats().some((f) => f.startsWith('image/'))) img = clipboard.readImage(); } catch { return; }
  if (!img || img.isEmpty()) return;
  const size = img.getSize();
  if (size.width * size.height > 40e6) return; // enormous: not worth keeping
  const png = img.toPNG();
  const id = crypto.createHash('sha1').update(png).digest('hex').slice(0, 16);
  if (id === lastPicture) return;
  lastPicture = id;
  try {
    fs.mkdirSync(clipDir(), { recursive: true });
    const file = path.join(clipDir(), id + '.png');
    fs.writeFileSync(file, png);
    const thumb = img.resize({ height: 56, quality: 'good' }).toJPEG(70).toString('base64');
    setClips([{ image: file, thumb: 'data:image/jpeg;base64,' + thumb, w: size.width, h: size.height, id }, ...clips.filter((c) => !isPicture(c) || c.id !== id)]);
  } catch { /* disk trouble: skip this one */ }
}

function watchClipboard() {
  clips = Array.isArray(store.clips) ? store.clips.filter((c) => typeof c === 'string' || (isPicture(c) && fs.existsSync(c.image))).slice(0, CLIP_MAX) : [];
  try { lastClip = clipboard.readText(); } catch { /* clipboard busy */ }
  // The helper says when something was copied. Without it, look for ourselves now and then.
  if (!helper) setInterval(readClipboard, 1500);
}

// ---------- screenshot and recording ----------

// Local date and time for file names, like 2026-11-11 23-43-32.
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };

let hiddenByUser = false; // switched off from the tray or Ctrl+Alt+I, until switched back on
function hideOurs() { for (const w of [win, stickyWin]) if (alive(w)) w.hide(); }
function showOurs() {
  if (hiddenByUser) return;
  if (alive(win)) win.showInactive();
  if (alive(stickyWin) && store.stickyDock !== false) stickyWin.showInactive();
}
function setHidden(hide) {
  hiddenByUser = hide;
  if (hide) hideOurs(); else showOurs();
  refreshTray();
}

// ---------- the icon by the clock ----------

let tray = null;

/** A small black pill with a white edge, drawn here so the project needs no picture file. */
function trayPicture() {
  const n = 32, buf = Buffer.alloc(n * n * 4);
  const x0 = 2, x1 = 30, y0 = 10, y1 = 22, r = 6;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // How far this pixel is inside the rounded bar (negative: outside).
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r), cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const inside = r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (inside <= 0) continue;
      const v = inside < 1.6 ? 255 : 0;
      const i = (y * n + x) * 4;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = Math.round(255 * Math.min(1, inside));
    }
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n });
}

const login = () => ({ path: process.execPath, args: [app.getAppPath()] });

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: hiddenByUser ? 'Show the island' : 'Hide the island', click: () => setHidden(!hiddenByUser) },
    { type: 'separator' },
    { label: 'Sticky notes on the screen edge', type: 'checkbox', checked: store.stickyDock !== false, click: (item) => setDock(item.checked) },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings(login()).openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, ...login() }) },
    { type: 'separator' },
    { label: 'Switch off (quit)', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(trayPicture());
  tray.setToolTip('Island');
  tray.on('click', () => setHidden(!hiddenByUser));
  refreshTray();
}

// Stickies can live on the screen edge, or only inside the island.
function setDock(on) {
  store.stickyDock = !!on;
  saveStoreSoon();
  if (on) createStickies();
  else if (alive(stickyWin)) stickyWin.close();
  for (const w of BrowserWindow.getAllWindows()) if (alive(w)) w.webContents.send('store-changed', { key: 'stickyDock', value: !!on });
  refreshTray();
}

// ---------- the shelf: a place to park files for a while ----------

function shelfList() {
  const files = (Array.isArray(store.shelf) ? store.shelf : []).filter((f) => typeof f === 'string' && fs.existsSync(f));
  return files.map((f) => { let size = 0, dir = false; try { const s = fs.statSync(f); size = s.size; dir = s.isDirectory(); } catch { /* vanished */ } return { file: f, name: path.basename(f), size, dir }; });
}
function shelfSet(files) {
  store.shelf = [...new Set(files)].slice(0, 60);
  saveStoreSoon();
  const list = shelfList();
  send('shelf', list);
  return list;
}

// ---------- quick share ----------

let share = null;
const shareOf = () => share || (share = createShare({
  saveDir: path.join(app.getPath('downloads'), 'Island'),
  onReceived: (file) => { ourFiles.add(file); send('phone-event', { kind: 'files', from: 'Quick Share', files: [file] }); },
  onChange: (info) => send('share', info),
}));

// Windows' own screen copy, run through PowerShell. Electron's built-in screen
// capture never answers on this laptop (it needs the graphics card, which the
// island cannot use), and once left the island hidden for good.
function grabScreen(file, bounds) {
  return new Promise((resolve) => {
    const script = "Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap " + bounds.w + ", " + bounds.h
      + "; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(" + bounds.x + ", " + bounds.y + ", 0, 0, $b.Size); $g.Dispose();"
      + " $b.Save($env:ISLAND_SHOT, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, env: { ...process.env, ISLAND_SHOT: file } },
      (err, _out, stderr) => { if (err) log('capture: powershell failed: ' + String(stderr || err.message).slice(0, 300)); resolve(!err && fs.existsSync(file)); });
  });
}

/** Takes a screenshot. region (in screen points) limits it to an area; otherwise the whole screen. */
async function captureScreen(region) {
  const d = screen.getPrimaryDisplay();
  const k = d.scaleFactor || 1;
  const r = region || { x: 0, y: 0, w: d.size.width, h: d.size.height };
  const bounds = { x: Math.round((d.bounds.x + r.x) * k), y: Math.round((d.bounds.y + r.y) * k), w: Math.max(1, Math.round(r.w * k)), h: Math.max(1, Math.round(r.h * k)) };
  // Not the Pictures folder: on this laptop it lives in OneDrive, where creating a folder hangs for ever.
  const dir = path.join(app.getPath('downloads'), 'Island', 'Screenshots');
  const file = path.join(dir, `Screenshot ${stamp()}.png`);
  log('capture: start ' + JSON.stringify(bounds) + ' -> ' + file);
  hideOurs(); // step out of the picture first
  // Whatever happens next, the island comes back.
  const back = setTimeout(showOurs, 10000);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await new Promise((r) => setTimeout(r, 220));
    const grabbed = await grabScreen(file, bounds);
    log('capture: grabbed=' + grabbed);
    if (!grabbed) return { ok: false };
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) clipboard.writeImage(img);
    return { ok: true, file };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(back);
    showOurs();
  }
}
// Screen recording runs in FFmpeg, outside the island's own window. Recording
// inside the window froze it, because the island has to draw without the graphics card.
let recProc = null;
let recInfo = { on: false, since: 0 };

function recordStart() {
  const exe = path.join(__dirname, '..', 'vendor', 'ffmpeg.exe');
  if (recProc || !fs.existsSync(exe)) return { ok: false, message: fs.existsSync(exe) ? 'Already recording' : 'FFmpeg is missing' };
  const dir = path.join(app.getPath('downloads'), 'Island', 'Recordings');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `Recording ${stamp()}.mp4`);
  // gdigrab is Windows' plain screen copy. The even-size filter keeps the video encoder happy on any screen size.
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-framerate', '24', '-draw_mouse', '1', '-i', 'desktop',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', file];
  const proc = spawn(exe, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  recProc = proc;
  recInfo = { on: true, since: Date.now() };
  send('recording', recInfo);
  proc.on('exit', () => {
    if (recProc === proc) recProc = null;
    recInfo = { on: false, since: 0 };
    send('recording', recInfo);
    const ok = fs.existsSync(file) && fs.statSync(file).size > 2000;
    if (ok) ourFiles.add(file);
    send('recording-done', ok ? { ok: true, file } : { ok: false });
  });
  return { ok: true };
}

function recordStop() {
  const proc = recProc;
  if (!proc) return;
  try { proc.stdin.write('q\n'); } catch { /* already gone */ }
  setTimeout(() => { if (recProc === proc) { try { proc.kill(); } catch { /* gone */ } } }, 5000);
}

// ---------- how busy the laptop is ----------

let lastCpu = null;
function systemLoad() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  let cpu = 0;
  if (lastCpu && total > lastCpu.total) cpu = 1 - (idle - lastCpu.idle) / (total - lastCpu.total);
  lastCpu = { idle, total };
  return { cpu: Math.min(1, Math.max(0, cpu)), mem: 1 - os.freemem() / os.totalmem(), memGb: os.totalmem() / 1073741824 };
}

// ---------- exchange rates (open.er-api.com, free, nothing about you is sent) ----------

let rates = { at: 0, values: null };
async function exchangeRates() {
  if (rates.values && Date.now() - rates.at < 6 * 3600 * 1000) return rates.values;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = res.ok ? await res.json() : null;
    if (data && data.rates && typeof data.rates.INR === 'number') rates = { at: Date.now(), values: data.rates };
  } catch { /* offline: use what we have, if anything */ }
  return rates.values;
}

function saveRecording(data) {
  try {
    const dir = path.join(app.getPath('downloads'), 'Island', 'Recordings');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Recording ${stamp()}.webm`);
    fs.writeFileSync(file, Buffer.from(data));
    return { ok: true, file };
  } catch {
    return { ok: false };
  }
}

// ---------- Claude Code activity ----------
// A Claude Code session writes to its transcript file while it works, so a
// transcript touched in the last few seconds means that session is busy.
// From each transcript we read only the project folder name and, for the usage
// panel, the token counts. Nothing leaves this computer.

const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const projectNames = new Map(); // transcript path -> project folder name
let claude = { active: 0, sessions: [] };
let claudeKey = '';

function projectOf(file, fallback) {
  if (projectNames.has(file)) return projectNames.get(file);
  let name = fallback;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, read).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (m) name = path.basename(JSON.parse('"' + m[1] + '"')) || fallback;
  } catch { /* unreadable: keep the fallback */ }
  projectNames.set(file, name);
  return name;
}

function recentTranscripts(sinceMs) {
  const found = [];
  try {
    for (const dir of fs.readdirSync(CLAUDE_ROOT, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const full = path.join(CLAUDE_ROOT, dir.name);
      try { if (fs.statSync(full).mtimeMs < sinceMs) continue; } catch { continue; }
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(full, f);
        try { const m = fs.statSync(file).mtimeMs; if (m >= sinceMs) found.push({ file, mtime: m, dir: dir.name }); } catch { /* file vanished */ }
      }
    }
  } catch { /* Claude Code not installed */ }
  return found.sort((a, b) => b.mtime - a.mtime);
}

function scanClaude() {
  const now = Date.now();
  const sessions = recentTranscripts(now - 6 * 3600 * 1000).slice(0, 8).map((t) => ({
    project: projectOf(t.file, t.dir.split('-').pop() || 'project'),
    // Claude often goes quiet for a while mid-task (thinking, or waiting on a command),
    // so a session counts as working until it has been silent for 90 seconds.
    active: t.mtime > now - 90000,
    mtime: Math.round(t.mtime),
  }));
  const next = { active: sessions.filter((s) => s.active).length, sessions };
  // Only tell the island when something it would show has changed.
  const key = sessions.map((s) => s.project + (s.active ? '*' : '') + Math.floor((now - s.mtime) / 60000)).join('|');
  if (key === claudeKey) return;
  claudeKey = key;
  claude = next;
  send('claude', claude);
}

/** Adds up the tokens Claude Code used today, from today's transcripts. */
async function claudeUsage() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, replies: 0, sessions: 0 };
  const seen = new Set();
  for (const t of recentTranscripts(start.getTime())) {
    let text;
    try { text = await fs.promises.readFile(t.file, 'utf8'); } catch { continue; }
    let counted = false;
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const u = row && row.message && row.message.usage;
      if (!u || !row.timestamp || new Date(row.timestamp).getTime() < start.getTime()) continue;
      // The same reply can be written more than once; count each only once.
      const id = row.message.id || row.uuid;
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      total.input += u.input_tokens || 0;
      total.output += u.output_tokens || 0;
      total.cacheRead += u.cache_read_input_tokens || 0;
      total.cacheWrite += u.cache_creation_input_tokens || 0;
      total.replies++;
      counted = true;
    }
    if (counted) total.sessions++;
  }
  return total;
}
// ---------- app ----------

let awakeId = null;
const SETTINGS_PAGES = new Set(['ms-settings:network-wifi', 'ms-settings:bluetooth', 'ms-settings:nightlight', 'ms-settings:sound', 'ms-settings:apps-volume', 'ms-settings:display', 'ms-settings:notifications']);

/** Called when Settings changes something the app itself (not just the island's page) must act on. */
function settingsChanged(before, after) {
  if (before.scale !== after.scale && alive(win)) win.setBounds(islandBounds());
  if (before.unit !== after.unit || JSON.stringify(before.place) !== JSON.stringify(after.place)) refreshWeather();
  if (before.winNotes !== after.winNotes && helper) helper.stdin.write(after.winNotes ? 'notes on\n' : 'notes off\n');
  if (before.lyrics !== after.lyrics) { lyrics = { key: '', lines: [] }; send('lyrics', lyrics); wantLyrics(); }
}

// A second copy would fight the first one over the phone ports and the shortcuts.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => setHidden(false));

app.whenReady().then(() => {
  loadStore();

  // Screen recording asks for "the display"; hand it the main screen plus system sound.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const d = screen.getPrimaryDisplay();
      const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
      callback(request.audioRequested ? { video: src, audio: 'loopback' } : { video: src });
    }).catch(() => callback({}));
  });

  ipcMain.on('zone', (e, z) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const entry = w && watched.get(w.id);
    if (!entry || !z) return;
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
    entry.zone = { x: n(z.x), y: n(z.y), w: n(z.w), h: n(z.h) };
    checkPointer();
  });
  // The island says whether it is open or showing, so work nobody can see is skipped.
  ipcMain.on('presence', (e, p) => {
    if (!alive(win) || e.sender !== win.webContents || !p) return;
    const was = presence;
    presence = { open: !!p.open, visible: !!p.visible };
    if (presence.visible && !was.visible) send('media', media); // catch up on the song position
    if (presence.open && !was.open) send('system', systemLoad());
  });
  ipcMain.on('log', (_e, text) => log(String(text).slice(0, 200)));
  ipcMain.on('media-cmd', (_e, cmd) => {
    if (helper && typeof cmd === 'string' && /^[a-z]+$/.test(cmd)) helper.stdin.write(cmd + '\n');
  });
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('media-seek', (_e, seconds) => { if (helper && typeof seconds === 'number' && isFinite(seconds)) helper.stdin.write('seek ' + Math.max(0, seconds).toFixed(2) + '\n'); });
  ipcMain.on('volume-set', (_e, level) => { if (helper && typeof level === 'number' && isFinite(level)) helper.stdin.write('volume ' + Math.min(1, Math.max(0, level)).toFixed(3) + '\n'); });
  ipcMain.on('volume-mute', () => { if (helper) helper.stdin.write('mute\n'); });
  // Brings up the app the music is coming from, where there is a way to.
  ipcMain.on('media-open', () => { if (media && media.site === 'spotify') shell.openExternal('spotify:'); });
  ipcMain.handle('state', () => ({ media, weather, clips, claude, awake: awakeId !== null, voice: voiceState, volume, lyrics, recording: recInfo }));
  ipcMain.handle('claude-usage', () => claudeUsage());

  ipcMain.handle('store-get', (_e, key) => (typeof key === 'string' && key !== 'aiKey' ? store[key] ?? null : null));
  ipcMain.on('store-set', (e, key, value) => {
    // Some things are the app's own to keep: the page may not overwrite them.
    if (typeof key !== 'string' || ['clips', 'aiKey', 'shelf', 'phoneTrusted', 'kdePaired'].includes(key)) return;
    const before = key === 'settings' ? settings() : null;
    store[key] = value;
    saveStoreSoon();
    if (before) settingsChanged(before, settings());
    // Keep the other windows in step (the island reads reminders out of the stickies).
    for (const w of BrowserWindow.getAllWindows()) {
      if (alive(w) && w.webContents !== e.sender) w.webContents.send('store-changed', { key, value });
    }
  });

  ipcMain.on('clip-copy', (_e, text) => { if (typeof text === 'string') { lastClip = text; clipboard.writeText(text); } });
  // Puts a kept picture back on the clipboard. Only pictures the history itself saved can be asked for.
  ipcMain.on('clip-copy-picture', (_e, id) => {
    const c = clips.find((x) => isPicture(x) && x.id === id);
    if (!c) return;
    const img = nativeImage.createFromPath(c.image);
    if (!img.isEmpty()) { lastPicture = c.id; clipboard.writeImage(img); }
  });
  ipcMain.on('clip-clear', () => setClips([]));

  // ---- shelf ----
  const realPaths = (v) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && path.isAbsolute(f) && fs.existsSync(f)) : []);
  ipcMain.handle('shelf-list', () => shelfList());
  ipcMain.handle('shelf-add', (_e, files) => shelfSet([...realPaths(files), ...(Array.isArray(store.shelf) ? store.shelf : [])]));
  ipcMain.handle('shelf-pick', async () => { const files = await pick('any', true); return shelfSet([...files, ...(Array.isArray(store.shelf) ? store.shelf : [])]); });
  ipcMain.handle('shelf-remove', (_e, file) => shelfSet((Array.isArray(store.shelf) ? store.shelf : []).filter((f) => f !== file)));
  ipcMain.handle('shelf-clear', () => shelfSet([]));
  ipcMain.on('shelf-reveal', (_e, file) => { if (shelfList().some((f) => f.file === file)) shell.showItemInFolder(file); });
  // Dragging a shelf row out of the island drops the real file wherever you let go.
  ipcMain.on('shelf-drag', async (e, file) => {
    const all = shelfList().map((f) => f.file);
    const files = file === '*' ? all : all.filter((f) => f === file);
    if (!files.length) return;
    let icon = null;
    try { icon = await app.getFileIcon(files[0], { size: 'normal' }); } catch { /* fall back below */ }
    if (!icon || icon.isEmpty()) icon = trayPicture();
    try { e.sender.startDrag({ file: files[0], files, icon }); } catch { /* the drag ended before it began */ }
  });
  ipcMain.handle('shelf-zip', () => guarded(() => filetools.archive('zip', shelfList().filter((f) => !f.dir).map((f) => f.file))));
  ipcMain.handle('shelf-phone', async () => {
    const files = shelfList().filter((f) => !f.dir).map((f) => f.file);
    if (!files.length) return { ok: false, message: 'The shelf has no files to send' };
    const device = phoneList()[0];
    if (!device) return { ok: false, message: 'No phone is known yet. Open Phone first' };
    return phoneSend(device.fingerprint, files);
  });

  // ---- quick share ----
  ipcMain.handle('share-info', () => shareOf().info());
  ipcMain.handle('share-start', async (_e, source) => {
    const files = source === 'shelf' ? shelfList().filter((f) => !f.dir).map((f) => f.file) : source === 'pick' ? await pick('any', true) : [];
    if (source === 'pick' && !files.length) return { ok: false, message: 'cancelled' };
    return shareOf().start(files);
  });
  ipcMain.on('share-stop', () => shareOf().stop());
  ipcMain.handle('share-to-phone', () => {
    const info = shareOf().info();
    if (!info) return { ok: false, message: 'Nothing is being shared' };
    if (!kde) return { ok: false, message: 'The phone companion link is not running' };
    lastClip = info.url;
    clipboard.writeText(info.url);
    kde.sendClipboard(info.url);
    return { ok: true, message: 'Link copied here and sent to your phone\'s clipboard' };
  });

  // ---- ask AI and translate ----
  ipcMain.handle('ai-info', () => ({ hasKey: aiOf().hasKey(store), models: aiOf().MODELS, model: typeof store.aiModel === 'string' ? store.aiModel : aiOf().DEFAULT_MODEL }));
  ipcMain.handle('ai-key', (_e, key) => { const r = aiOf().setKey(store, key); saveStoreSoon(); return r; });
  ipcMain.on('ai-model', (_e, model) => { if (aiOf().MODELS.some((m) => m.id === model)) { store.aiModel = model; saveStoreSoon(); } });
  ipcMain.handle('ai-ask', (e, messages) => aiOf().ask(store, Array.isArray(messages) ? messages : [], store.aiModel, (piece) => { if (!e.sender.isDestroyed()) e.sender.send('ai-text', piece); }));
  ipcMain.on('ai-stop', () => aiOf().stop());
  ipcMain.handle('translate-langs', () => aiOf().LANGS);
  ipcMain.handle('translate', (_e, text, from, to) => aiOf().translate(String(text || '').slice(0, 6000), String(from), String(to)));

  // ---- settings ----
  ipcMain.handle('settings-info', () => ({ winNotes: winNotesState }));
  // Finds a city for the weather (Open-Meteo's place search; only the name typed is sent).
  ipcMain.handle('place-search', async (_e, name) => {
    const q = String(name || '').trim().slice(0, 60);
    if (q.length < 2) return [];
    try {
      const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=' + encodeURIComponent(q));
      const data = res.ok ? await res.json() : null;
      return (data && Array.isArray(data.results) ? data.results : []).map((r) => ({ city: String(r.name), where: [r.admin1, r.country].filter(Boolean).join(', '), lat: Number(r.latitude), lon: Number(r.longitude) }));
    } catch { return []; }
  });
  ipcMain.handle('night', (_e, action) => nightLight(action));
  // Every screenshot reports back the same way, so the island can announce it.
  const shot = async (region) => { const r = await captureScreen(region); send('capture-result', r); return r; };
  ipcMain.handle('capture', () => shot());
  ipcMain.on('snip-open', () => openSnip());
  ipcMain.on('snip-done', async (_e, box) => {
    if (alive(snipWin)) snipWin.close();
    if (!box || !(box.w > 0) || !(box.h > 0)) return;
    await new Promise((r) => setTimeout(r, 160)); // let the dim sheet leave the screen first
    shot({ x: Number(box.x) || 0, y: Number(box.y) || 0, w: Number(box.w), h: Number(box.h) });
  });
  ipcMain.handle('save-recording', (_e, data) => saveRecording(data));
  ipcMain.handle('record-toggle', () => { if (recProc) { recordStop(); return { ok: true }; } return recordStart(); });
  ipcMain.handle('rates', () => exchangeRates());
  setInterval(() => { if (presence.open || alive(stageWin)) send('system', systemLoad()); }, 2000);
  ipcMain.on('reveal', (_e, file) => {
    if (typeof file !== 'string') return;
    if (ourFiles.has(file) || file.startsWith(path.join(app.getPath('downloads'), 'Island'))) shell.showItemInFolder(file);
  });

  const list = (v) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && fs.existsSync(f)) : []);
  ipcMain.handle('pick', (_e, kind, multi) => pick(String(kind), !!multi));
  ipcMain.handle('pdf-run', (_e, op, files, options) => guarded(() => filetools.pdf(String(op), list(files), options || {})));
  ipcMain.handle('image-run', (_e, files, options) => guarded(async () => filetools.image(list(files), options || {})));
  ipcMain.handle('archive-run', (_e, op, files) => guarded(() => filetools.archive(String(op), list(files))));
  ipcMain.handle('video-run', (_e, files, options) => guarded(() => filetools.video(list(files), options || {})));
  ipcMain.handle('audio-run', (_e, files, options) => guarded(() => filetools.audio(list(files), options || {})));
  ipcMain.handle('cutbg-run', (_e, files) => guarded(() => filetools.cutBackground(list(files))));
  ipcMain.handle('rename-run', (_e, files, options) => guarded(async () => filetools.rename(list(files), options || {})));
  ipcMain.handle('read-text', (_e, file) => (typeof file === 'string' && fs.existsSync(file) ? readText(file) : { ok: false, text: '' }));
  ipcMain.handle('save-picture', (_e, dataUrl, name) => guarded(async () => {
    const img = nativeImage.createFromDataURL(String(dataUrl));
    if (img.isEmpty()) return { ok: false, message: 'Nothing to save' };
    const dir = path.join(app.getPath('downloads'), 'Island', 'Pictures');
    fs.mkdirSync(dir, { recursive: true });
    const file = filetools.fresh(dir, String(name || 'Picture').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'Picture', '.png');
    fs.writeFileSync(file, img.toPNG());
    clipboard.writeImage(img);
    return { ok: true, file, message: 'Saved to Downloads and copied' };
  }));
  ipcMain.handle('voice-info', async () => ({
    problem: voice.ready(),
    mics: await voice.microphones(),
    mic: store.voiceMic || '',
    lang: store.voiceLang || 'auto',
    history: Array.isArray(store.voiceHistory) ? store.voiceHistory : [],
    state: voiceState,
  }));
  ipcMain.handle('voice-start', () => voiceStart(false));
  ipcMain.handle('voice-stop', () => voiceStop());
  ipcMain.on('voice-set', (_e, mic, lang) => {
    if (typeof mic === 'string') store.voiceMic = mic;
    if (typeof lang === 'string') store.voiceLang = lang;
    saveStoreSoon();
  });
  // ---- phone link ----
  ipcMain.handle('phone-info', () => ({
    ok: !!peer && !phoneError, error: phoneError, alias: phoneAlias(),
    devices: phoneList(), requests: phoneRequests,
    received: (Array.isArray(store.phoneReceived) ? store.phoneReceived : []).filter((r) => fs.existsSync(r.file)),
    trusted: Array.isArray(store.phoneTrusted) ? store.phoneTrusted : [],
  }));
  ipcMain.handle('phone-scan', async () => { if (peer) await peer.scan(); return phoneList(); });
  ipcMain.on('phone-folder', () => { const dir = path.join(app.getPath('downloads'), 'Island'); fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); });
  ipcMain.on('phone-answer', (_e, id, accept, always) => {
    const req = phoneRequests.find((r) => r.id === id);
    if (!req || !peer) return;
    if (accept && always) { store.phoneTrusted = [...new Set([...(store.phoneTrusted || []), req.fingerprint])]; saveStoreSoon(); }
    phoneRequests = phoneRequests.filter((r) => r.id !== id);
    send('phone-requests', phoneRequests);
    peer.answer(id, !!accept);
  });
  ipcMain.handle('phone-send-files', async (_e, fingerprint) => {
    const files = await pick('any', true);
    if (!files.length) return { ok: false, message: 'cancelled' };
    return phoneSend(String(fingerprint), files);
  });
  ipcMain.handle('phone-send-text', async (_e, fingerprint) => {
    const text = clipboard.readText();
    if (!text.trim()) return { ok: false, message: 'The clipboard has no text to send' };
    return phoneSend(String(fingerprint), [], text);
  });

  // ---- phone companion ----
  ipcMain.handle('companion-info', () => ({ ok: !!kde && !kdeError, error: kdeError, devices: kde ? kde.list() : [], clipboard: clipSync() }));
  ipcMain.on('companion-find', () => { if (kde) kde.broadcast(); });
  ipcMain.on('companion-pair', (_e, id) => { if (kde) kde.requestPair(String(id)); });
  ipcMain.on('companion-answer', (_e, id, accept) => { if (kde) kde.answerPair(String(id), !!accept); });
  ipcMain.on('companion-unpair', (_e, id) => { if (kde) kde.unpair(String(id)); });
  ipcMain.on('companion-ring', (_e, id) => { if (kde) kde.ring(String(id)); });
  ipcMain.on('companion-mute', (_e, id) => { if (kde) kde.muteRinger(String(id)); });
  ipcMain.handle('companion-reply', (_e, id, replyId, message) => !!(kde && kde.reply(String(id), String(replyId), String(message).slice(0, 2000))));
  ipcMain.on('companion-clipboard', (_e, on) => { store.kdeClipboard = !!on; saveStoreSoon(); });

  // ---- password vault ----
  ipcMain.handle('vault-status', () => { const s = vault.status(); return { exists: s.exists, unlocked: s.unlocked }; });
  ipcMain.on('vault-reveal', () => { const s = vault.status(); if (s.exists) shell.showItemInFolder(s.file); });
  ipcMain.handle('vault-create', (_e, master) => vault.create(master));
  ipcMain.handle('vault-unlock', (_e, master) => vault.unlock(master));
  ipcMain.handle('vault-lock', () => { vault.lock(); return { ok: true }; });
  ipcMain.handle('vault-list', () => vault.list());
  ipcMain.handle('vault-save', (_e, item) => vault.save(item || {}));
  ipcMain.handle('vault-remove', (_e, id) => vault.remove(String(id)));
  ipcMain.handle('vault-generate', (_e, length, symbols) => vault.generate(length, !!symbols));
  ipcMain.handle('vault-show', (_e, id) => { const s = vault.secret(String(id)); return s.ok ? { ok: true, password: s.password } : s; });
  ipcMain.handle('vault-copy', (_e, id, what) => {
    const s = vault.secret(String(id));
    if (!s.ok) return s;
    const value = what === 'user' ? s.user : s.password;
    lastClip = value; // keeps it out of clipboard history
    clipboard.writeText(value);
    // A copied password is wiped again shortly, unless something else was copied meanwhile.
    if (what !== 'user') setTimeout(() => { try { if (clipboard.readText() === value) clipboard.clear(); } catch { /* clipboard busy */ } }, 20000);
    return { ok: true };
  });

  ipcMain.on('copy-text', (_e, text) => { if (typeof text === 'string') { lastClip = text; clipboard.writeText(text); } });

  ipcMain.on('sticky-dock', (_e, on) => setDock(!!on));

  ipcMain.on('stickies-show', () => { if (alive(stickyWin)) { stickyWin.webContents.send('show'); stickyWin.focus(); } });
  screen.on('display-metrics-changed', () => { if (alive(win)) win.setBounds(islandBounds()); });
  ipcMain.on('draw-open', () => openDraw());
  ipcMain.on('stage-open', (_e, mode) => openStage(String(mode)));
  ipcMain.on('stage-close', () => { if (alive(stageWin)) stageWin.close(); });
  ipcMain.on('draw-close', () => { if (alive(drawWin)) drawWin.close(); });

  ipcMain.handle('awake-toggle', () => {
    if (awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
    else { powerSaveBlocker.stop(awakeId); awakeId = null; }
    return awakeId !== null;
  });
  ipcMain.on('lock', () => execFile('rundll32.exe', ['user32.dll,LockWorkStation'], () => {}));
  ipcMain.handle('radio', (_e, kind, action) => radio(kind, action));
  ipcMain.on('open-settings', (_e, uri) => { if (SETTINGS_PAGES.has(uri)) shell.openExternal(uri); });

  ipcMain.handle('startup-get', () => app.getLoginItemSettings(login()).openAtLogin);
  ipcMain.handle('startup-set', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on, ...login() });
    refreshTray();
    return app.getLoginItemSettings(login()).openAtLogin;
  });

  startHelper();
  createIsland();
  createStickies();
  createTray();
  startPhone();
  startKde();
  if (process.env.ISLAND_DRAW) openDraw(); // for testing the drawing sheet
  if (process.env.ISLAND_STAGE) openStage(process.env.ISLAND_STAGE); // for testing the full-screen views
  if (process.env.ISLAND_TEST_CAPTURE) setTimeout(async () => { const q = (process.env.ISLAND_TEST_REGION || '').split(',').map(Number); const r = await captureScreen(q.length === 4 ? { x: q[0], y: q[1], w: q[2], h: q[3] } : undefined); send('capture-result', r); fs.writeFileSync(process.env.ISLAND_TEST_CAPTURE, JSON.stringify({ ...r, visibleAfter: alive(win) && win.isVisible() })); }, 4000); // for testing screenshots
  pointerLoop();
  refreshWeather();
  setInterval(refreshWeather, WEATHER_EVERY_MS);
  watchClipboard();
  // Claude's sessions are checked often while one is working, and lazily otherwise.
  const claudeLoop = () => { scanClaude(); setTimeout(claudeLoop, claude.active > 0 ? 3000 : 8000); };
  claudeLoop();

  globalShortcut.register('Control+Alt+I', () => setHidden(!hiddenByUser));
  globalShortcut.register('Control+Alt+Q', () => app.quit());
  // Dictate anywhere: hold while speaking, or tap to start and tap again to stop.
  globalShortcut.register('Control+Alt+Space', voiceHotkey);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  voice.cancel();
  recordStop();
  if (vaultLoaded) vaultLoaded.lock();
  if (share) share.stop();
  if (tray) tray.destroy();
  if (peer) peer.stop();
  if (kde) kde.stop();
  if (helper) helper.kill();
  if (storeTimer) { clearTimeout(storeTimer); try { fs.writeFileSync(storeFile, JSON.stringify(store)); } catch { /* nothing more we can do while quitting */ } }
});
app.on('window-all-closed', () => app.quit());
