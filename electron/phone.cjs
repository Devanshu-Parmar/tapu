// Phone link: speaks the LocalSend protocol (v2), so a phone running the free
// LocalSend app sees this laptop as a nearby device and can send files and text
// to it, and the laptop can send to the phone. Everything travels directly over
// the local Wi-Fi, encrypted, and nothing goes through the internet.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');

const GROUP = '224.0.0.167'; // LocalSend's discovery address
const DEFAULT_PORT = 53317;
const API = '/api/localsend/v2';
const ASK_TIMEOUT_MS = 45000;

const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.zip': 'application/zip', '.apk': 'application/vnd.android.package-archive',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/** A file name that is safe to create and does not overwrite anything. */
function landing(dir, name) {
  const clean = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'file';
  const ext = path.extname(clean), stem = path.basename(clean, ext);
  let target = path.join(dir, clean);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
  return target;
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * One LocalSend device. Options:
 *   alias      name shown on the other device
 *   saveDir    where received files go
 *   certFile   where this device's identity (key + certificate) is kept
 *   port       listening port (the standard one unless testing)
 *   discovery  false to skip multicast and scanning (for tests)
 *   isTrusted  (fingerprint) => true to accept from that device without asking
 *   onEvent    (name, payload) => void
 */
function createPeer(options) {
  const port = options.port || DEFAULT_PORT;
  const emit = options.onEvent || (() => {});
  const devices = new Map();  // fingerprint -> { fingerprint, alias, ip, port, protocol, type, seen }
  const sessions = new Map(); // sessionId -> { files: Map(fileId -> { token, name, path, done }), from, left }
  const asking = new Map();   // requestId -> { resolve, timer }
  let identity = null;        // { key, cert, fingerprint }
  let server = null;
  let socket = null;

  const info = () => ({
    alias: options.alias, version: '2.1', deviceModel: 'Windows', deviceType: 'desktop',
    fingerprint: identity.fingerprint, port, protocol: 'https', download: false,
  });

  async function loadIdentity() {
    try {
      const saved = JSON.parse(fs.readFileSync(options.certFile, 'utf8'));
      if (saved.key && saved.cert && saved.fingerprint) { identity = saved; return; }
    } catch { /* first run */ }
    const selfsigned = require('selfsigned');
    const pem = await Promise.resolve(selfsigned.generate([{ name: 'commonName', value: 'Island' }], { days: 3650, keySize: 2048, algorithm: 'sha256' }));
    // LocalSend identifies a device by the SHA-256 of its certificate.
    const fingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(pem.cert).raw).digest('hex');
    identity = { key: pem.private, cert: pem.cert, fingerprint };
    fs.mkdirSync(path.dirname(options.certFile), { recursive: true });
    fs.writeFileSync(options.certFile, JSON.stringify(identity));
  }

  function remember(d, ip) {
    if (!d || !d.fingerprint || d.fingerprint === identity.fingerprint) return;
    const known = devices.get(d.fingerprint);
    const entry = {
      fingerprint: String(d.fingerprint), alias: String(d.alias || 'Device').slice(0, 60), ip,
      port: Number(d.port) || DEFAULT_PORT, protocol: d.protocol === 'http' ? 'http' : 'https',
      type: String(d.deviceType || ''), seen: Date.now(),
    };
    devices.set(entry.fingerprint, entry);
    if (!known || known.ip !== ip || known.alias !== entry.alias) emit('devices', list());
  }

  const list = () => [...devices.values()].sort((a, b) => a.alias.localeCompare(b.alias));

  // ---------- talking to another device ----------

  function call(target, method, route, body, timeout) {
    return new Promise((resolve) => {
      const lib = target.protocol === 'http' ? http : https;
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = lib.request({
        host: target.ip, port: target.port, path: API + route, method, timeout: timeout || 8000,
        rejectUnauthorized: false, // every device uses its own self-made certificate
        // LocalSend devices insist the caller shows its own certificate too; that is how they know who is calling.
        key: identity.key, cert: identity.cert,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty or not JSON */ }
          resolve({ status: res.statusCode, json });
        });
      });
      let timedOut = false;
      req.on('timeout', () => { timedOut = true; req.destroy(); });
      // "sent" tells a request that went out and then got no answer apart from one that never connected.
      req.on('error', (e) => resolve({ status: 0, json: null, timedOut, sent: req.reusedSocket || !!(req.socket && req.socket.bytesWritten > 0), code: e && e.code }));
      if (data) req.write(data);
      req.end();
    });
  }

  function upload(target, query, file) {
    return new Promise((resolve) => {
      const lib = target.protocol === 'http' ? http : https;
      const size = fs.statSync(file).size;
      const req = lib.request({
        host: target.ip, port: target.port, path: `${API}/upload?${query}`, method: 'POST',
        rejectUnauthorized: false, key: identity.key, cert: identity.cert,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
      req.on('error', () => resolve(false));
      fs.createReadStream(file).on('error', () => { req.destroy(); resolve(false); }).pipe(req);
    });
  }

  /** Sends files, and optionally a text message, to a device. */
  async function send(target, files, text) {
    const entries = {};
    const paths = {};
    for (const f of files || []) {
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      const id = crypto.randomUUID();
      entries[id] = { id, fileName: path.basename(f), size: fs.statSync(f).size, fileType: typeOf(f) };
      paths[id] = f;
    }
    if (typeof text === 'string' && text) {
      const id = crypto.randomUUID();
      // LocalSend carries a text message as a "file" whose content rides along as the preview.
      entries[id] = { id, fileName: 'message.txt', size: Buffer.byteLength(text), fileType: 'text/plain', preview: text };
    }
    if (!Object.keys(entries).length) return { ok: false, message: 'Nothing to send' };

    const r = await call(target, 'POST', '/prepare-upload', { info: info(), files: entries }, 60000);
    if (r.status === 204) return { ok: true, message: 'Sent' }; // a message needs no upload
    // A text message is delivered by the request itself. Phones show it and often never answer,
    // so a message that went out and then met silence has arrived.
    const textOnly = !Object.keys(paths).length;
    if (textOnly && r.status === 0 && r.sent) return { ok: true, message: 'Sent' };
    if (process.env.ISLAND_PHONE_DEBUG) console.log('prepare-upload reply:', JSON.stringify({ status: r.status, timedOut: r.timedOut, sent: r.sent, code: r.code, json: r.json }));
    if (r.status === 403) return { ok: false, message: 'The other device declined' };
    if (r.status === 409) return { ok: false, message: 'The other device is busy with another transfer' };
    if (r.status !== 200 || !r.json || !r.json.sessionId) return { ok: false, message: r.status ? 'The other device refused the transfer' : 'Could not reach the device' };

    let sent = 0;
    for (const [id, token] of Object.entries(r.json.files || {})) {
      if (!paths[id]) continue;
      const q = `sessionId=${encodeURIComponent(r.json.sessionId)}&fileId=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
      if (await upload(target, q, paths[id])) sent++;
    }
    const wanted = Object.keys(paths).length;
    if (wanted && !sent) return { ok: false, message: 'The transfer failed' };
    return { ok: true, message: wanted ? `Sent ${sent} of ${wanted} file${wanted > 1 ? 's' : ''}` : 'Sent' };
  }

  // ---------- being talked to ----------

  const reply = (res, status, body) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, data ? { 'Content-Type': 'application/json' } : {});
    res.end(data);
  };

  function readJson(req, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); resolve(null); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  /** Asks the person at this laptop whether to accept, unless the sender is already trusted. */
  function ask(from, files) {
    if (options.isTrusted && options.isTrusted(from.fingerprint)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { asking.delete(id); emit('request-gone', id); resolve(false); }, ASK_TIMEOUT_MS);
      asking.set(id, { resolve, timer });
      emit('request', {
        id, alias: from.alias, fingerprint: from.fingerprint, count: files.length,
        size: files.reduce((n, f) => n + (Number(f.size) || 0), 0),
        names: files.slice(0, 3).map((f) => String(f.fileName || 'file')),
      });
    });
  }

  function answer(id, accept) {
    const waiting = asking.get(id);
    if (!waiting) return false;
    clearTimeout(waiting.timer);
    asking.delete(id);
    waiting.resolve(!!accept);
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'https://island');
    const route = url.pathname;
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

    if (req.method === 'GET' && route === API + '/info') { reply(res, 200, info()); return; }

    if (req.method === 'POST' && route === API + '/register') {
      remember(await readJson(req, 65536), ip);
      reply(res, 200, info());
      return;
    }

    if (req.method === 'POST' && route === API + '/prepare-upload') {
      const body = await readJson(req, 8 * 1024 * 1024);
      const files = body && body.files && typeof body.files === 'object' ? Object.values(body.files) : [];
      if (!body || !body.info || !files.length) { reply(res, 400, { message: 'Bad request' }); return; }
      remember({ ...body.info, port: body.info.port, protocol: body.info.protocol }, ip);
      const from = { alias: String(body.info.alias || 'Device').slice(0, 60), fingerprint: String(body.info.fingerprint || ip) };
      if (!(await ask(from, files))) { reply(res, 403, { message: 'Declined' }); return; }

      // Text arrives inside the request itself; only real files need an upload afterwards.
      const texts = files.filter((f) => typeof f.preview === 'string' && String(f.fileType || '').startsWith('text/')).map((f) => f.preview);
      const real = files.filter((f) => !(typeof f.preview === 'string' && String(f.fileType || '').startsWith('text/')));
      if (texts.length) emit('text', { from: from.alias, text: texts.join('\n') });
      if (!real.length) { reply(res, 204); return; }

      fs.mkdirSync(options.saveDir, { recursive: true });
      const sessionId = crypto.randomUUID();
      const map = new Map();
      const tokens = {};
      for (const f of real) {
        const token = crypto.randomUUID();
        map.set(String(f.id), { token, name: String(f.fileName || 'file'), path: '', done: false });
        tokens[String(f.id)] = token;
      }
      sessions.set(sessionId, { files: map, from: from.alias, left: map.size, saved: [], ip });
      // A session that never finishes should not linger for ever.
      setTimeout(() => finish(sessionId), 30 * 60 * 1000).unref?.();
      reply(res, 200, { sessionId, files: tokens });
      return;
    }

    if (req.method === 'POST' && route === API + '/upload') {
      const session = sessions.get(url.searchParams.get('sessionId') || '');
      const file = session && session.files.get(url.searchParams.get('fileId') || '');
      if (!session || !file || file.token !== url.searchParams.get('token') || session.ip !== ip) { req.resume(); reply(res, 403, { message: 'Invalid token' }); return; }
      if (file.done) { req.resume(); reply(res, 409, { message: 'Already received' }); return; }
      const target = landing(options.saveDir, file.name);
      const out = fs.createWriteStream(target);
      req.pipe(out);
      out.on('finish', () => {
        file.done = true; file.path = target;
        session.saved.push(target); session.left--;
        reply(res, 200);
        if (session.left <= 0) finish(url.searchParams.get('sessionId'));
      });
      const fail = () => { try { out.destroy(); fs.rmSync(target, { force: true }); } catch { /* nothing to clean */ } if (!res.headersSent) reply(res, 500, { message: 'Write failed' }); };
      out.on('error', fail);
      req.on('aborted', fail);
      return;
    }

    if (req.method === 'POST' && route === API + '/cancel') { finish(url.searchParams.get('sessionId')); reply(res, 200); return; }

    reply(res, 404, { message: 'Not found' });
  }

  function finish(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.saved.length) emit('received', { from: session.from, files: session.saved });
  }

  // ---------- finding devices ----------

  function announce() {
    if (!socket) return;
    const msg = Buffer.from(JSON.stringify({ ...info(), announce: true }));
    for (const address of localAddresses()) {
      try { socket.setMulticastInterface(address); socket.send(msg, DEFAULT_PORT, GROUP); } catch { /* interface went away */ }
    }
  }

  /** Greets every address on the local network; devices that answer are LocalSend devices. */
  async function scan() {
    announce();
    const targets = [];
    for (const address of localAddresses()) {
      const base = address.split('.').slice(0, 3).join('.');
      for (let i = 1; i < 255; i++) { const ip = `${base}.${i}`; if (ip !== address) targets.push(ip); }
    }
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const ip = targets[next++];
        let r = await call({ ip, port: DEFAULT_PORT, protocol: 'https' }, 'POST', '/register', info(), 900);
        if (r.status !== 200) r = await call({ ip, port: DEFAULT_PORT, protocol: 'http' }, 'POST', '/register', info(), 600);
        if (r.status === 200 && r.json) remember({ ...r.json, port: r.json.port || DEFAULT_PORT, protocol: r.json.protocol }, ip);
      }
    };
    await Promise.all(Array.from({ length: 48 }, worker));
    return list();
  }

  async function start() {
    await loadIdentity();
    await new Promise((resolve, reject) => {
      server = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) => { handle(req, res).catch(() => { try { reply(res, 500, { message: 'Error' }); } catch { /* already answered */ } }); });
      server.once('error', reject);
      server.listen(port, options.host || '0.0.0.0', resolve);
    });
    if (options.discovery === false) return;
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => { /* discovery is best effort; scanning still works */ });
    socket.on('message', (raw, rinfo) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || msg.fingerprint === identity.fingerprint) return;
      remember(msg, rinfo.address);
      // Someone announced themselves: tell them we are here too.
      if (msg.announce) call({ ip: rinfo.address, port: Number(msg.port) || DEFAULT_PORT, protocol: msg.protocol === 'http' ? 'http' : 'https' }, 'POST', '/register', info(), 3000);
    });
    socket.bind(DEFAULT_PORT, () => {
      for (const address of localAddresses()) { try { socket.addMembership(GROUP, address); } catch { /* not a multicast interface */ } }
      announce();
    });
  }

  function stop() {
    for (const [id] of asking) answer(id, false);
    try { if (socket) socket.close(); } catch { /* already closed */ }
    try { if (server) server.close(); } catch { /* already closed */ }
    socket = null; server = null;
  }

  return { start, stop, scan, announce, send, answer, list, fingerprint: () => (identity ? identity.fingerprint : ''), addresses: localAddresses };
}

module.exports = { createPeer };
