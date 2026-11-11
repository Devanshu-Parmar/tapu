// Quick Share: hands files to any phone or computer on the same Wi-Fi through
// its web browser, with no app on the other side. The island runs a small web
// server for a few minutes; the link holds a random code, and only someone with
// the link can fetch the files or send some back. Nothing leaves the local network.
// (This is not Google's Quick Share protocol; it only does the same job.)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const OPEN_FOR_MS = 15 * 60 * 1000;
const BIGGEST_UPLOAD = 8 * 1024 * 1024 * 1024;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sizeText = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');

/**
 * This computer's address on the home or office network: the one Windows would use to
 * reach the internet. (Asking for a route sends nothing.) A laptop often has other
 * addresses too, such as its own hotspot, which a phone on the Wi-Fi could not reach.
 */
function lanAddress() {
  return new Promise((resolve) => {
    const probe = require('dgram').createSocket('udp4');
    const done = (address) => { try { probe.close(); } catch { /* already closed */ } resolve(address || firstAddress()); };
    probe.on('error', () => done(''));
    try { probe.connect(53, '192.0.2.1', () => { let a = ''; try { a = probe.address().address; } catch { /* no route */ } done(a === '0.0.0.0' ? '' : a); }); } catch { done(''); }
  });
}

function firstAddress() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) found.push(a.address);
  }
  return found.find((a) => /^192\.168\./.test(a)) || found.find((a) => /^10\./.test(a)) || found.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) || found[0] || '';
}

function fresh(dir, name) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function createShare({ saveDir, onReceived, onChange }) {
  let server = null;
  let state = null; // { code, url, until, files }
  let timer = null;

  function pageHtml() {
    const rows = state.files.map((f, i) => `<a class="row" href="/${state.code}/f/${i}" download><b>${esc(f.name)}</b><span>${sizeText(f.size)}</span></a>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Island share</title>
<style>body{margin:0;background:#000;color:#fff;font:15px system-ui,sans-serif}main{max-width:520px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}p{color:#a1a1a6;margin:0 0 18px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 16px;margin-bottom:8px;border-radius:16px;background:#1c1c1e;color:#fff;text-decoration:none}.row b{font-weight:600;overflow-wrap:anywhere}.row span{color:#a1a1a6;flex:none}
label.row{justify-content:center;background:#fff;color:#000;font-weight:600;cursor:pointer}input{display:none}#log{color:#30d158;margin-top:10px;min-height:20px}</style></head><body><main>
<h1>Island share</h1><p>${state.files.length ? 'Tap a file to download it.' : 'Nothing is being offered right now.'}</p>${rows}
<h1 style="margin-top:26px">Send to the laptop</h1><p>Files you pick are saved in its Downloads\\Island folder.</p>
<label class="row">Choose files<input id="pick" type="file" multiple></label><div id="log"></div>
<script>const log=document.getElementById('log');document.getElementById('pick').onchange=async(e)=>{let n=0;for(const f of e.target.files){log.textContent='Sending '+f.name+'...';const r=await fetch(location.pathname.replace(/\\/$/,'')+'/up?name='+encodeURIComponent(f.name),{method:'PUT',body:f});if(r.ok)n++;}log.textContent=n+' sent';e.target.value='';};</script>
</main></body></html>`;
  }

  function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    // Without the right code there is nothing here at all.
    if (!state || parts[0] !== state.code) { res.writeHead(404).end(); return; }
    if (req.method === 'GET' && parts.length === 1) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(pageHtml());
      return;
    }
    if (req.method === 'GET' && parts[1] === 'f') {
      const f = state.files[Number(parts[2])];
      if (!f || !fs.existsSync(f.file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f.file).size, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(f.name) });
      fs.createReadStream(f.file).pipe(res);
      return;
    }
    if (req.method === 'PUT' && parts[1] === 'up') {
      // Only the last part of the name is used, so nothing can be written outside the folder.
      const name = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
      if (Number(req.headers['content-length'] || 0) > BIGGEST_UPLOAD) { res.writeHead(413).end(); return; }
      fs.mkdirSync(saveDir, { recursive: true });
      const file = fresh(saveDir, name);
      const out = fs.createWriteStream(file);
      let got = 0;
      req.on('data', (chunk) => { got += chunk.length; if (got > BIGGEST_UPLOAD) req.destroy(); });
      req.pipe(out);
      out.on('finish', () => { res.writeHead(200).end('ok'); onReceived(file); });
      const failed = () => { out.destroy(); fs.rm(file, { force: true }, () => {}); if (!res.headersSent) res.writeHead(500).end(); };
      req.on('error', failed);
      req.on('aborted', failed);
      out.on('error', failed);
      return;
    }
    res.writeHead(404).end();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (server) { try { server.closeAllConnections(); } catch { /* older runtime */ } server.close(); server = null; }
    if (state) { state = null; onChange(null); }
  }

  /** Starts sharing these files (possibly none, to only receive). Returns the link. */
  async function start(files) {
    stop();
    const address = await lanAddress();
    if (!address) return { ok: false, message: 'This laptop is not on a network' };
    return new Promise((resolve) => {
      const s = http.createServer(handle);
      s.on('error', () => resolve({ ok: false, message: 'Could not start sharing' }));
      s.listen(0, '0.0.0.0', () => {
        server = s;
        const code = crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10).toLowerCase();
        state = {
          code,
          url: `http://${address}:${s.address().port}/${code}`,
          until: Date.now() + OPEN_FOR_MS,
          files: files.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile()).map((f) => ({ file: f, name: path.basename(f), size: fs.statSync(f).size })),
        };
        timer = setTimeout(stop, OPEN_FOR_MS);
        onChange(info());
        resolve({ ok: true, ...info() });
      });
    });
  }

  function info() {
    return state ? { url: state.url, until: state.until, files: state.files.map((f) => ({ name: f.name, size: f.size })) } : null;
  }

  return { start, stop, info };
}

module.exports = { createShare };
