// Phone companion link: speaks the KDE Connect protocol (version 7), so the
// free KDE Connect app on a phone can pair with this laptop and pass along its
// notifications, calls, battery level and clipboard. Everything is encrypted
// and stays on the local Wi-Fi.
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');

const PORT = 1716; // KDE Connect's standard port for both discovery and connections
const RECEIVES = ['kdeconnect.notification', 'kdeconnect.telephony', 'kdeconnect.battery', 'kdeconnect.clipboard', 'kdeconnect.clipboard.connect', 'kdeconnect.ping'];
const SENDS = ['kdeconnect.notification.request', 'kdeconnect.notification.reply', 'kdeconnect.telephony.request_mute', 'kdeconnect.clipboard', 'kdeconnect.clipboard.connect', 'kdeconnect.findmyphone.request', 'kdeconnect.battery.request', 'kdeconnect.ping'];

const packet = (type, body) => JSON.stringify({ id: Date.now(), type, body: body || {} }) + '\n';

/** Calls onLine for each complete line arriving on a socket. */
function lines(socket, onLine) {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(line); }
    if (buf.length > 4 * 1024 * 1024) buf = ''; // never let a bad peer grow this without limit
  };
  socket.on('data', onData);
  return () => socket.off('data', onData);
}

/**
 * Options: name (shown on the phone), identityFile, paired (object the caller keeps:
 * deviceId -> { name, fingerprint }), onPairedChange(paired), onEvent(name, payload),
 * and for tests: port, host, discovery:false.
 */
function createKde(options) {
  const port = options.port || PORT;
  const emit = options.onEvent || (() => {});
  const paired = options.paired || {};
  const links = new Map(); // deviceId -> { id, name, type, socket, paired, pending, battery, charging, address }
  let identity = null;     // { deviceId, key, cert }
  let server = null;
  let udp = null;
  let beacon = null;

  const identityPacket = () => packet('kdeconnect.identity', {
    deviceId: identity.deviceId, deviceName: options.name, protocolVersion: 7, deviceType: 'laptop',
    tcpPort: port, incomingCapabilities: RECEIVES, outgoingCapabilities: SENDS,
  });

  async function loadIdentity() {
    try {
      const saved = JSON.parse(fs.readFileSync(options.identityFile, 'utf8'));
      if (saved.deviceId && saved.key && saved.cert) { identity = saved; return; }
    } catch { /* first run */ }
    const deviceId = crypto.randomUUID().replace(/-/g, '_');
    const selfsigned = require('selfsigned');
    // The certificate carries the device id as its name; that is how KDE Connect ties the two together.
    const pem = await Promise.resolve(selfsigned.generate(
      [{ name: 'commonName', value: deviceId }],
      { days: 3650, keySize: 2048, algorithm: 'sha256' }));
    identity = { deviceId, key: pem.private, cert: pem.cert };
    fs.mkdirSync(path.dirname(options.identityFile), { recursive: true });
    fs.writeFileSync(options.identityFile, JSON.stringify(identity));
  }

  const list = () => [...links.values()].map((l) => ({ id: l.id, name: l.name, type: l.type, paired: l.paired, pending: l.pending, battery: l.battery, charging: l.charging }));
  const changed = () => emit('devices', list());

  function send(link, type, body) {
    try { link.socket.write(packet(type, body)); return true; } catch { return false; }
  }

  // ---------- an encrypted link is up ----------

  function adopt(secure, info, address) {
    const id = String(info.deviceId || '');
    if (!id || id === identity.deviceId) { secure.destroy(); return; }
    const old = links.get(id);
    if (old) { try { old.socket.destroy(); } catch { /* already gone */ } }

    const cert = secure.getPeerCertificate();
    const fingerprint = cert && cert.fingerprint256 ? cert.fingerprint256 : '';
    // Paired only if this is the same certificate we paired with; a changed one must pair again.
    const known = paired[id];
    const link = {
      id, name: String(info.deviceName || 'Phone').slice(0, 60), type: String(info.deviceType || 'phone'),
      socket: secure, fingerprint, paired: !!(known && fingerprint && known.fingerprint === fingerprint),
      pending: '', battery: -1, charging: false, address,
    };
    links.set(id, link);
    changed();

    lines(secure, (line) => { let p; try { p = JSON.parse(line); } catch { return; } receive(link, p); });
    const gone = () => { if (links.get(id) === link) { links.delete(id); changed(); } };
    secure.on('close', gone);
    secure.on('error', gone);
    if (link.paired) send(link, 'kdeconnect.battery.request', { request: true });
  }

  function setPaired(link, on) {
    link.paired = on;
    link.pending = '';
    if (on) paired[link.id] = { name: link.name, fingerprint: link.fingerprint };
    else delete paired[link.id];
    if (options.onPairedChange) options.onPairedChange(paired);
    changed();
    if (on) send(link, 'kdeconnect.battery.request', { request: true });
  }

  function receive(link, p) {
    const body = p && p.body ? p.body : {};
    if (p.type === 'kdeconnect.pair') {
      if (body.pair) {
        if (link.pending === 'out' || link.paired) setPaired(link, true); // they said yes to us
        else { link.pending = 'in'; changed(); emit('pair-request', { id: link.id, name: link.name }); }
      } else if (link.paired || link.pending) setPaired(link, false);
      return;
    }
    if (!link.paired) return; // an unpaired device gets nothing but the pairing conversation

    if (p.type === 'kdeconnect.notification') {
      if (body.isCancel) { emit('notification-gone', { device: link.name, id: String(body.id || '') }); return; }
      // Skip the ever-present ones (media players, "running in background") and silent updates.
      if (body.silent || body.isClearable === false) return;
      const title = String(body.title || ''), text = String(body.text || '');
      if (!title && !text && !body.ticker) return;
      // requestReplyId is only present when the phone app lets you answer from the notification.
      emit('notification', { device: link.name, deviceId: link.id, id: String(body.id || ''), app: String(body.appName || ''), title, text: text || (title ? '' : String(body.ticker || '')), replyId: typeof body.requestReplyId === 'string' ? body.requestReplyId : '' });
    } else if (p.type === 'kdeconnect.telephony') {
      emit('call', { device: link.id, event: body.isCancel ? 'ended' : String(body.event || ''), name: String(body.contactName || ''), number: String(body.phoneNumber || '') });
    } else if (p.type === 'kdeconnect.battery') {
      link.battery = typeof body.currentCharge === 'number' ? body.currentCharge : link.battery;
      link.charging = !!body.isCharging;
      changed();
    } else if (p.type === 'kdeconnect.clipboard' || p.type === 'kdeconnect.clipboard.connect') {
      if (typeof body.content === 'string' && body.content) emit('clipboard', { device: link.name, text: body.content });
    }
  }

  // ---------- making and accepting connections ----------
  // KDE Connect's rule: whoever opens the TCP connection sends its identity in
  // the clear, then acts as the TLS *server*; the side that accepted is the TLS client.

  const secureContext = () => tls.createSecureContext({ key: identity.key, cert: identity.cert });

  /** We heard a device announce itself (or were told its address): go and connect to it. */
  function reach(address, tcpPort, info) {
    if (links.has(String(info.deviceId))) return;
    const raw = net.connect({ host: address, port: tcpPort || PORT, timeout: 5000 });
    raw.on('timeout', () => raw.destroy());
    raw.on('error', () => {});
    raw.once('connect', () => {
      raw.setTimeout(0);
      raw.write(identityPacket(), () => {
        const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: secureContext(), requestCert: true, rejectUnauthorized: false });
        secure.on('error', () => secure.destroy());
        secure.once('secure', () => adopt(secure, info, address));
      });
    });
  }

  /** A device connected to us: it speaks first with its identity, then we start TLS as the client. */
  function accept(raw) {
    raw.on('error', () => {});
    raw.setTimeout(8000, () => raw.destroy());
    const stop = lines(raw, (line) => {
      stop();
      let p;
      try { p = JSON.parse(line); } catch { raw.destroy(); return; }
      if (!p || p.type !== 'kdeconnect.identity' || !p.body) { raw.destroy(); return; }
      raw.setTimeout(0);
      const secure = tls.connect({ socket: raw, key: identity.key, cert: identity.cert, rejectUnauthorized: false });
      secure.on('error', () => secure.destroy());
      secure.once('secureConnect', () => adopt(secure, p.body, (raw.remoteAddress || '').replace(/^::ffff:/, '')));
    });
  }

  function broadcast() {
    if (!udp) return;
    const msg = Buffer.from(identityPacket());
    const targets = new Set(['255.255.255.255']);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        // The subnet's own broadcast address reaches phones on networks that drop the global one.
        const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
        targets.add(ip.map((n, i) => (n | (~mask[i] & 255))).join('.'));
      }
    }
    for (const t of targets) { try { udp.send(msg, PORT, t); } catch { /* interface went away */ } }
  }

  async function start() {
    await loadIdentity();
    await new Promise((resolve, reject) => {
      server = net.createServer(accept);
      server.once('error', reject);
      server.listen(port, options.host || '0.0.0.0', resolve);
    });
    if (options.discovery === false) return;
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', () => { /* discovery is best effort */ });
    udp.on('message', (raw, rinfo) => {
      let p;
      try { p = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!p || p.type !== 'kdeconnect.identity' || !p.body || p.body.deviceId === identity.deviceId) return;
      reach(rinfo.address, Number(p.body.tcpPort) || PORT, p.body);
    });
    udp.bind(PORT, () => { try { udp.setBroadcast(true); } catch { /* not allowed on this network */ } broadcast(); });
    beacon = setInterval(broadcast, 20000);
  }

  function stop() {
    if (beacon) clearInterval(beacon);
    for (const l of links.values()) { try { l.socket.destroy(); } catch { /* gone */ } }
    links.clear();
    try { if (udp) udp.close(); } catch { /* closed */ }
    try { if (server) server.close(); } catch { /* closed */ }
    udp = null; server = null;
  }

  const each = (work) => { let n = 0; for (const l of links.values()) if (l.paired && work(l)) n++; return n; };

  return {
    start, stop, list, broadcast, reach,
    _links: () => links.values(), // for tests
    id: () => (identity ? identity.deviceId : ''),
    requestPair(id) { const l = links.get(id); if (!l) return false; l.pending = 'out'; changed(); return send(l, 'kdeconnect.pair', { pair: true }); },
    answerPair(id, accept) { const l = links.get(id); if (!l) return false; send(l, 'kdeconnect.pair', { pair: !!accept }); setPaired(l, !!accept); return true; },
    unpair(id) { const l = links.get(id); if (l) { send(l, 'kdeconnect.pair', { pair: false }); setPaired(l, false); } else { delete paired[id]; if (options.onPairedChange) options.onPairedChange(paired); } },
    reply: (id, replyId, message) => { const l = links.get(id); return !!(l && l.paired && replyId && message && send(l, 'kdeconnect.notification.reply', { requestReplyId: replyId, message })); },
    sendClipboard: (text) => each((l) => send(l, 'kdeconnect.clipboard', { content: text })),
    ring: (id) => { const l = links.get(id); return !!(l && l.paired && send(l, 'kdeconnect.findmyphone.request', {})); },
    muteRinger: (id) => { const l = links.get(id); return !!(l && l.paired && send(l, 'kdeconnect.telephony.request_mute', {})); },
  };
}

module.exports = { createKde };
