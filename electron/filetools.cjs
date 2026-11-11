// File tools: PDF, image, archive and rename work. Everything runs on this
// computer; originals are never changed, results are written next to them.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { nativeImage } = require('electron');
const { PDFDocument, degrees } = require('pdf-lib');

/** A path that does not exist yet: "name.ext", then "name (2).ext", and so on. */
function fresh(dir, name, ext) {
  let candidate = path.join(dir, name + ext);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${name} (${i})${ext}`);
  return candidate;
}

const stem = (file) => path.basename(file, path.extname(file));

/** "1-3, 5, 8-" -> zero-based page indexes, in order, each once. */
function parsePages(text, count) {
  const picked = new Set();
  for (const part of String(text).split(',')) {
    const m = part.trim().match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!m || (!m[1] && !m[3])) continue;
    let from = m[1] ? Number(m[1]) : 1;
    let to = m[2] ? (m[3] ? Number(m[3]) : count) : from;
    if (from > to) [from, to] = [to, from];
    for (let p = Math.max(1, from); p <= Math.min(count, to); p++) picked.add(p - 1);
  }
  return [...picked].sort((a, b) => a - b);
}

const loadPdf = (file) => PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });

async function pdf(op, files, options) {
  if (!files.length) return { ok: false, message: 'No file chosen' };
  const first = files[0];
  const dir = path.dirname(first);

  if (op === 'merge') {
    if (files.length < 2) return { ok: false, message: 'Choose two or more PDFs to merge' };
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await loadPdf(f);
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    }
    const file = fresh(dir, stem(first) + ' (merged)', '.pdf');
    fs.writeFileSync(file, await out.save());
    return { ok: true, file, message: `Merged ${files.length} PDFs, ${out.getPageCount()} pages` };
  }

  if (op === 'images') {
    const out = await PDFDocument.create();
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      // Anything that is not already JPG or PNG is converted to PNG first.
      let bytes = fs.readFileSync(f);
      let isJpg = ext === '.jpg' || ext === '.jpeg';
      if (!isJpg && ext !== '.png') {
        const img = nativeImage.createFromPath(f);
        if (img.isEmpty()) continue;
        bytes = img.toPNG();
      }
      const img = isJpg ? await out.embedJpg(bytes) : await out.embedPng(bytes);
      out.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    if (out.getPageCount() === 0) return { ok: false, message: 'None of those images could be read' };
    const file = fresh(dir, stem(first), '.pdf');
    fs.writeFileSync(file, await out.save());
    return { ok: true, file, message: `Made a ${out.getPageCount()}-page PDF` };
  }

  const src = await loadPdf(first);
  const count = src.getPageCount();

  if (op === 'split') {
    const folder = fresh(dir, stem(first) + ' pages', '');
    fs.mkdirSync(folder);
    for (let i = 0; i < count; i++) {
      const one = await PDFDocument.create();
      one.addPage((await one.copyPages(src, [i]))[0]);
      fs.writeFileSync(path.join(folder, `${stem(first)} - page ${i + 1}.pdf`), await one.save());
    }
    return { ok: true, file: folder, message: `Split into ${count} files` };
  }

  if (op === 'keep' || op === 'remove') {
    const chosen = parsePages(options.pages, count);
    if (!chosen.length) return { ok: false, message: `Type page numbers between 1 and ${count}, like 1-3, 5` };
    const keep = op === 'keep' ? chosen : src.getPageIndices().filter((i) => !chosen.includes(i));
    if (!keep.length) return { ok: false, message: 'That would remove every page' };
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(src, keep)) out.addPage(page);
    const file = fresh(dir, stem(first) + (op === 'keep' ? ' (pages)' : ' (trimmed)'), '.pdf');
    fs.writeFileSync(file, await out.save());
    return { ok: true, file, message: `${keep.length} of ${count} pages kept` };
  }

  if (op === 'rotate') {
    for (const page of src.getPages()) page.setRotation(degrees((page.getRotation().angle + 90) % 360));
    const file = fresh(dir, stem(first) + ' (rotated)', '.pdf');
    fs.writeFileSync(file, await src.save());
    return { ok: true, file, message: `Rotated ${count} pages a quarter turn` };
  }

  if (op === 'crop') {
    // Trim the same margin off every side, given in millimetres.
    const mm = Number(options.margin);
    if (!(mm > 0)) return { ok: false, message: 'Type a margin in millimetres' };
    const pt = mm * 72 / 25.4;
    for (const page of src.getPages()) {
      const { width, height } = page.getSize();
      if (width - pt * 2 < 20 || height - pt * 2 < 20) return { ok: false, message: 'That margin is larger than the page' };
      page.setCropBox(pt, pt, width - pt * 2, height - pt * 2);
    }
    const file = fresh(dir, stem(first) + ' (cropped)', '.pdf');
    fs.writeFileSync(file, await src.save());
    return { ok: true, file, message: `Cropped ${mm} mm off each side` };
  }

  return { ok: false, message: 'Unknown PDF action' };
}

function image(files, options) {
  const format = options.format === 'png' ? 'png' : 'jpg';
  const scale = Math.min(100, Math.max(5, Number(options.scale) || 100)) / 100;
  const quality = Math.min(100, Math.max(10, Number(options.quality) || 85));
  let done = 0, before = 0, after = 0, last = '';
  for (const f of files) {
    const img = nativeImage.createFromPath(f);
    if (img.isEmpty()) continue;
    const size = img.getSize();
    const sized = scale < 1 ? img.resize({ width: Math.max(1, Math.round(size.width * scale)), quality: 'best' }) : img;
    const bytes = format === 'png' ? sized.toPNG() : sized.toJPEG(quality);
    const file = fresh(path.dirname(f), stem(f) + ' (island)', '.' + format);
    fs.writeFileSync(file, bytes);
    before += fs.statSync(f).size; after += bytes.length; done++; last = file;
  }
  if (!done) return { ok: false, message: 'None of those images could be read' };
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
  return { ok: true, file: last, message: `${done} image${done > 1 ? 's' : ''}: ${kb(before)} to ${kb(after)}` };
}

const run = (cmd, args, cwd) => new Promise((resolve) => execFile(cmd, args, { cwd, windowsHide: true }, (err) => resolve(!err)));

async function archive(op, files) {
  if (!files.length) return { ok: false, message: 'No file chosen' };
  const first = files[0];
  const dir = path.dirname(first);
  // Windows ships a tar that reads and writes zip, and reads 7z and rar.
  if (op === 'zip') {
    const name = files.length === 1 ? stem(first) : path.basename(dir) || 'Archive';
    const file = fresh(dir, name, '.zip');
    const ok = await run('tar.exe', ['-a', '-c', '-f', file, ...files.map((f) => path.basename(f))], dir);
    return ok ? { ok: true, file, message: `Zipped ${files.length} item${files.length > 1 ? 's' : ''}` } : { ok: false, message: 'Could not make the zip' };
  }
  const folder = fresh(dir, stem(first), '');
  fs.mkdirSync(folder);
  const ok = await run('tar.exe', ['-x', '-f', first, '-C', folder], dir);
  if (!ok) { try { fs.rmdirSync(folder); } catch { /* something was extracted; leave it */ } return { ok: false, message: 'Could not open that archive' }; }
  return { ok: true, file: folder, message: 'Unpacked into a new folder' };
}

function rename(files, options) {
  const ext = String(options.ext || '').trim().replace(/^\./, '');
  const base = String(options.name || '').trim();
  if (!ext && !base) return { ok: false, message: 'Type a new name, a new extension, or both' };
  if (/[\\/:*?"<>|]/.test(ext + base)) return { ok: false, message: 'Names cannot contain \\ / : * ? " < > |' };
  let done = 0, last = '';
  files.forEach((f, i) => {
    const dir = path.dirname(f);
    const newStem = base ? (files.length > 1 ? `${base} ${i + 1}` : base) : stem(f);
    const newExt = ext ? '.' + ext : path.extname(f);
    const target = path.join(dir, newStem + newExt);
    if (target === f) return;
    const safe = fs.existsSync(target) ? fresh(dir, newStem, newExt) : target;
    fs.renameSync(f, safe);
    done++; last = safe;
  });
  return done ? { ok: true, file: last, message: `Renamed ${done} file${done > 1 ? 's' : ''}` } : { ok: false, message: 'Nothing needed renaming' };
}

// ---------- video and audio (FFmpeg) ----------

const VENDOR = path.join(__dirname, '..', 'vendor');
const FFMPEG = path.join(VENDOR, 'ffmpeg.exe');
const MODEL = path.join(VENDOR, 'models', 'isnet-general-use.onnx');

const ffmpeg = (args) => new Promise((resolve) => {
  if (!fs.existsSync(FFMPEG)) { resolve(false); return; }
  execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err) => resolve(!err));
});

async function each(files, label, work) {
  if (!fs.existsSync(FFMPEG)) return { ok: false, message: 'FFmpeg is missing from the vendor folder' };
  let done = 0, last = '';
  for (const f of files) {
    const out = await work(f);
    if (out) { done++; last = out; }
  }
  if (!done) return { ok: false, message: 'Could not convert ' + (files.length > 1 ? 'those files' : 'that file') };
  return { ok: true, file: last, message: `${label} ${done} file${done > 1 ? 's' : ''}` + (done < files.length ? `, ${files.length - done} failed` : '') };
}

function video(files, options) {
  const op = String(options.op || 'convert');
  const dirOf = (f) => path.dirname(f);
  if (op === 'audio') {
    return each(files, 'Pulled the sound out of', async (f) => {
      const out = fresh(dirOf(f), stem(f), '.mp3');
      return (await ffmpeg(['-i', f, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', out])) ? out : null;
    });
  }
  if (op === 'mute') {
    return each(files, 'Removed the sound from', async (f) => {
      const out = fresh(dirOf(f), stem(f) + ' (silent)', path.extname(f) || '.mp4');
      return (await ffmpeg(['-i', f, '-an', '-c:v', 'copy', out])) ? out : null;
    });
  }
  const format = ['mp4', 'mkv', 'mov', 'webm', 'gif'].includes(options.format) ? options.format : 'mp4';
  // Smaller number = better picture and a bigger file.
  const level = { high: 20, medium: 26, small: 32 }[options.quality] || 26;
  return each(files, 'Converted', async (f) => {
    const out = fresh(dirOf(f), stem(f) + ' (island)', '.' + format);
    let args;
    if (format === 'gif') args = ['-i', f, '-vf', 'fps=12,scale=480:-1:flags=lanczos', out];
    else if (format === 'webm') args = ['-i', f, '-c:v', 'libvpx-vp9', '-crf', String(level + 10), '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k', out];
    else args = ['-i', f, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(level), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', out];
    return (await ffmpeg(args)) ? out : null;
  });
}

function audio(files, options) {
  const format = ['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(options.format) ? options.format : 'mp3';
  const rate = ['96', '128', '192', '256', '320'].includes(String(options.bitrate)) ? String(options.bitrate) : '192';
  const codec = {
    mp3: ['-c:a', 'libmp3lame', '-b:a', rate + 'k'],
    wav: ['-c:a', 'pcm_s16le'],
    flac: ['-c:a', 'flac'],
    m4a: ['-c:a', 'aac', '-b:a', rate + 'k'],
    ogg: ['-c:a', 'libvorbis', '-b:a', rate + 'k'],
  }[format];
  return each(files, 'Converted', async (f) => {
    const out = fresh(path.dirname(f), stem(f) + ' (island)', '.' + format);
    return (await ffmpeg(['-i', f, '-vn', ...codec, out])) ? out : null;
  });
}

// ---------- background removal (runs a small neural network on this computer) ----------

const SIDE = 1024; // the model looks at a 1024 x 1024 copy of the picture
let session = null;

async function cutBackground(files) {
  if (!fs.existsSync(MODEL)) return { ok: false, message: 'The background model is missing from the vendor folder' };
  const ort = require('onnxruntime-node');
  if (!session) session = await ort.InferenceSession.create(MODEL);

  let done = 0, last = '';
  for (const f of files) {
    const img = nativeImage.createFromPath(f);
    if (img.isEmpty()) continue;
    const { width: W, height: H } = img.getSize();

    // Model input: red, green, blue planes, each value scaled to roughly -0.5..0.5.
    const small = img.resize({ width: SIDE, height: SIDE, quality: 'best' }).toBitmap(); // BGRA
    const n = SIDE * SIDE;
    let peak = 1;
    for (let i = 0; i < n * 4; i += 4) peak = Math.max(peak, small[i], small[i + 1], small[i + 2]);
    const input = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      input[i] = small[i * 4 + 2] / peak - 0.5;
      input[n + i] = small[i * 4 + 1] / peak - 0.5;
      input[n * 2 + i] = small[i * 4] / peak - 0.5;
    }
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]) });
    const mask = result[session.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (mask[i] < lo) lo = mask[i]; if (mask[i] > hi) hi = mask[i]; }
    const span = hi - lo || 1;

    // Stretch the mask back to the picture's own size and use it as transparency.
    const px = img.toBitmap(); // BGRA, colours already multiplied by any existing transparency
    const sx = (SIDE - 1) / Math.max(1, W - 1), sy = (SIDE - 1) / Math.max(1, H - 1);
    for (let y = 0; y < H; y++) {
      const fy = y * sy, y0 = Math.floor(fy), y1 = Math.min(SIDE - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = x * sx, x0 = Math.floor(fx), x1 = Math.min(SIDE - 1, x0 + 1), tx = fx - x0;
        const top = mask[y0 * SIDE + x0] * (1 - tx) + mask[y0 * SIDE + x1] * tx;
        const bottom = mask[y1 * SIDE + x0] * (1 - tx) + mask[y1 * SIDE + x1] * tx;
        const a = Math.min(1, Math.max(0, ((top * (1 - ty) + bottom * ty) - lo) / span));
        const i = (y * W + x) * 4;
        px[i] = px[i] * a; px[i + 1] = px[i + 1] * a; px[i + 2] = px[i + 2] * a; px[i + 3] = px[i + 3] * a;
      }
    }
    const out = fresh(path.dirname(f), stem(f) + ' (no background)', '.png');
    fs.writeFileSync(out, nativeImage.createFromBitmap(px, { width: W, height: H }).toPNG());
    done++; last = out;
  }
  if (!done) return { ok: false, message: 'None of those images could be read' };
  return { ok: true, file: last, message: `Removed the background from ${done} image${done > 1 ? 's' : ''}` };
}

module.exports = { pdf, image, archive, rename, video, audio, cutBackground, fresh };
