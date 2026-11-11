import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ToolResult } from './types';
import { Panel } from './panels';

type PickKind = 'pdf' | 'image' | 'archive' | 'video' | 'audio' | 'any';

/** Runs one job at a time and remembers how it went, for the line at the bottom of a panel. */
function useJob() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);
  const run = async (kind: PickKind, multi: boolean, work: (files: string[]) => Promise<ToolResult | undefined>) => {
    if (busy) return;
    const files = (await window.island?.pick(kind, multi)) ?? [];
    if (!files.length) return;
    setBusy(true);
    setResult(null);
    try { setResult((await work(files)) ?? { ok: false, message: 'That did not work' }); }
    finally { setBusy(false); }
  };
  return { busy, result, run };
}

function Outcome({ busy, result }: { busy: boolean; result: ToolResult | null }) {
  if (busy) return <p className="outcome">Working…</p>;
  if (!result) return null;
  return (
    <p className={`outcome ${result.ok ? 'outcome-ok' : 'outcome-bad'}`}>
      <span>{result.message}</span>
      {result.ok && result.file && <button className="pillbtn" onClick={() => window.island?.reveal(result.file!)}>Show</button>}
    </p>
  );
}

// ---------- PDF ----------

export function PdfPanel({ onClose }: { onClose: () => void }) {
  const { busy, result, run } = useJob();
  const [pages, setPages] = useState('');
  const [margin, setMargin] = useState('10');
  const api = window.island;
  return (
    <Panel title="PDF" onClose={onClose}>
      <div className="actions">
        <button className="pillbtn" disabled={busy} onClick={() => run('pdf', true, (f) => api!.pdf('merge', f))}>Merge PDFs</button>
        <button className="pillbtn" disabled={busy} onClick={() => run('pdf', false, (f) => api!.pdf('split', f))}>Split into pages</button>
        <button className="pillbtn" disabled={busy} onClick={() => run('pdf', false, (f) => api!.pdf('rotate', f))}>Rotate</button>
        <button className="pillbtn" disabled={busy} onClick={() => run('image', true, (f) => api!.pdf('images', f))}>Images to PDF</button>
      </div>
      <div className="add">
        <input className="field grow" placeholder="Pages, like 1-3, 5" aria-label="Page numbers" value={pages} onChange={(e) => setPages(e.target.value)} />
        <button className="pillbtn" disabled={busy || !pages.trim()} onClick={() => run('pdf', false, (f) => api!.pdf('keep', f, { pages }))}>Keep these</button>
        <button className="pillbtn" disabled={busy || !pages.trim()} onClick={() => run('pdf', false, (f) => api!.pdf('remove', f, { pages }))}>Remove these</button>
      </div>
      <div className="add">
        <input className="field grow" inputMode="decimal" placeholder="Margin to trim, in mm" aria-label="Crop margin in millimetres" value={margin} onChange={(e) => setMargin(e.target.value.replace(/[^0-9.]/g, ''))} />
        <button className="pillbtn" disabled={busy || !margin} onClick={() => run('pdf', false, (f) => api!.pdf('crop', f, { margin }))}>Crop margins</button>
      </div>
      <p className="hint">Each button asks for the file, then saves a new copy next to it. Your original is not changed.</p>
      <Outcome busy={busy} result={result} />
    </Panel>
  );
}

// ---------- images ----------

export function ImagePanel({ onClose }: { onClose: () => void }) {
  const { busy, result, run } = useJob();
  const [format, setFormat] = useState('jpg');
  const [quality, setQuality] = useState('80');
  const [scale, setScale] = useState('100');
  return (
    <Panel title="Image" onClose={onClose}>
      <div className="form">
        <label>Save as
          <select className="field" value={format} onChange={(e) => setFormat(e.target.value)}><option value="jpg">JPG</option><option value="png">PNG</option></select>
        </label>
        <label>Quality %
          <input className="field" inputMode="numeric" value={quality} disabled={format === 'png'} onChange={(e) => setQuality(e.target.value.replace(/\D/g, '').slice(0, 3))} />
        </label>
        <label>Size %
          <input className="field" inputMode="numeric" value={scale} onChange={(e) => setScale(e.target.value.replace(/\D/g, '').slice(0, 3))} />
        </label>
      </div>
      <div className="actions">
        <button className="pillbtn solid" disabled={busy} onClick={() => run('image', true, (f) => window.island!.image(f, { format, quality, scale }))}>Choose images</button>
      </div>
      <p className="hint">Converts, shrinks or resizes in one go. Lower quality or size makes a smaller file. Copies are saved next to the originals.</p>
      <Outcome busy={busy} result={result} />
    </Panel>
  );
}

// ---------- video ----------

export function VideoPanel({ onClose }: { onClose: () => void }) {
  const { busy, result, run } = useJob();
  const [format, setFormat] = useState('mp4');
  const [quality, setQuality] = useState('medium');
  return (
    <Panel title="Video" onClose={onClose}>
      <div className="form">
        <label>Convert to
          <select className="field" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="mp4">MP4</option><option value="mkv">MKV</option><option value="mov">MOV</option><option value="webm">WebM</option><option value="gif">GIF</option>
          </select>
        </label>
        <label>Size
          <select className="field" value={quality} disabled={format === 'gif'} onChange={(e) => setQuality(e.target.value)}>
            <option value="high">Best picture</option><option value="medium">Balanced</option><option value="small">Smallest file</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="pillbtn solid" disabled={busy} onClick={() => run('video', true, (f) => window.island!.video(f, { op: 'convert', format, quality }))}>Convert videos</button>
        <button className="pillbtn" disabled={busy} onClick={() => run('video', true, (f) => window.island!.video(f, { op: 'audio' }))}>Save sound as MP3</button>
        <button className="pillbtn" disabled={busy} onClick={() => run('video', true, (f) => window.island!.video(f, { op: 'mute' }))}>Remove sound</button>
      </div>
      <p className="hint">A long video can take a few minutes; the island stays usable meanwhile. Copies are saved next to the originals.</p>
      <Outcome busy={busy} result={result} />
    </Panel>
  );
}

// ---------- audio ----------

export function AudioPanel({ onClose }: { onClose: () => void }) {
  const { busy, result, run } = useJob();
  const [format, setFormat] = useState('mp3');
  const [bitrate, setBitrate] = useState('192');
  const lossless = format === 'wav' || format === 'flac';
  return (
    <Panel title="Audio" onClose={onClose}>
      <div className="form">
        <label>Convert to
          <select className="field" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="mp3">MP3</option><option value="m4a">M4A</option><option value="ogg">OGG</option><option value="wav">WAV</option><option value="flac">FLAC</option>
          </select>
        </label>
        <label>Quality
          <select className="field" value={bitrate} disabled={lossless} onChange={(e) => setBitrate(e.target.value)}>
            <option value="96">96 kbps, small</option><option value="128">128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps, best</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="pillbtn solid" disabled={busy} onClick={() => run('audio', true, (f) => window.island!.audio(f, { format, bitrate }))}>Convert audio</button>
      </div>
      <p className="hint">WAV and FLAC keep full quality, so the quality setting does not apply to them.</p>
      <Outcome busy={busy} result={result} />
    </Panel>
  );
}

// ---------- background removal ----------

export function CutBgPanel({ onClose }: { onClose: () => void }) {
  const { busy, result, run } = useJob();
  return (
    <Panel title="Remove background" onClose={onClose}>
      <div className="actions">
        <button className="pillbtn solid" disabled={busy} onClick={() => run('image', true, (f) => window.island!.cutBackground(f))}>Choose images</button>
      </div>
      <p className="hint">Finds the main subject and makes everything else see-through, saved as a PNG beside the original. It runs on your laptop, nothing is uploaded. Expect a few seconds per picture.</p>
      <Outcome busy={busy} result={result} />
    </Panel>
  );
}

// ---------- zip ----------

export function ZipPanel({ onClose }: { onClose: () => void }) {
  const { busy, result, run } = useJob();
  return (
    <Panel title="Zip" onClose={onClose}>
      <div className="actions">
        <button className="pillbtn solid" disabled={busy} onClick={() => run('any', true, (f) => window.island!.archive('zip', f))}>Zip files</button>
        <button className="pillbtn" disabled={busy} onClick={() => run('archive', false, (f) => window.island!.archive('unzip', f))}>Unpack an archive</button>
      </div>
      <p className="hint">Zipping makes one .zip from the files you choose. Unpacking opens zip, 7z, rar and tar into a new folder beside the archive.</p>
      <Outcome busy={busy} result={result} />
    </Panel>
  );
}

// ---------- rename / change extension ----------

export function RenamePanel({ onClose }: { onClose: () => void }) {
  const { busy, result, run } = useJob();
  const [name, setName] = useState('');
  const [ext, setExt] = useState('');
  return (
    <Panel title="Rename" onClose={onClose}>
      <div className="form">
        <label>New name
          <input className="field" placeholder="Leave empty to keep" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>New extension
          <input className="field" placeholder="like txt" value={ext} onChange={(e) => setExt(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 10))} />
        </label>
      </div>
      <div className="actions">
        <button className="pillbtn solid" disabled={busy || (!name.trim() && !ext)} onClick={() => run('any', true, (f) => window.island!.rename(f, { name, ext }))}>Choose files</button>
      </div>
      <p className="hint">With several files, a number is added after the name. Changing an extension only renames the file; it does not convert what is inside.</p>
      <Outcome busy={busy} result={result} />
    </Panel>
  );
}

// ---------- text from a picture ----------

export function OcrPanel({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const go = async () => {
    const files = (await window.island?.pick('image', false)) ?? [];
    if (!files.length) return;
    setBusy(true); setFailed(false); setText(null);
    const r = await window.island?.readText(files[0]);
    setBusy(false);
    if (r?.ok) setText(r.text); else setFailed(true);
  };
  return (
    <Panel title="Text from picture" onClose={onClose} action={
      <>
        {text ? <button className="pillbtn" onClick={() => { window.island?.copyText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{copied ? 'Copied' : 'Copy'}</button> : null}
        <button className="pillbtn solid" disabled={busy} onClick={go}>Choose picture</button>
      </>
    }>
      {busy && <p className="outcome">Reading…</p>}
      {failed && <p className="outcome outcome-bad">Could not read that picture.</p>}
      {text !== null && (text.trim() ? <textarea className="field area" aria-label="Recognised text" value={text} onChange={(e) => setText(e.target.value)} /> : <p className="empty">No text found in that picture.</p>)}
      {text === null && !busy && !failed && <p className="empty">Choose a screenshot or photo and the words in it appear here, ready to copy. This runs on your laptop.</p>}
    </Panel>
  );
}

// ---------- QR code ----------

export function QrPanel({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    let live = true;
    if (!text.trim()) { setUrl(''); return; }
    QRCode.toDataURL(text, { margin: 2, width: 480, color: { dark: '#000000', light: '#ffffff' } })
      .then((u) => { if (live) setUrl(u); })
      .catch(() => { if (live) setUrl(''); });
    return () => { live = false; };
  }, [text]);
  return (
    <Panel title="QR code" onClose={onClose} action={url ? <button className="pillbtn solid" onClick={async () => { const r = await window.island?.savePicture(url, 'QR code'); setNote(r?.ok ? 'Saved to Downloads and copied' : 'Could not save'); }}>Save</button> : null}>
      <div className="qr">
        <div className="qr-side">
          <textarea className="field area" placeholder="Type or paste a link or any text" aria-label="Text for the QR code" value={text} onChange={(e) => { setText(e.target.value); setNote(''); }} />
          {note && <p className="outcome outcome-ok">{note}</p>}
        </div>
        <div className="qr-box">{url ? <img src={url} alt="QR code for the text" /> : <span className="row-sub">QR appears here</span>}</div>
      </div>
    </Panel>
  );
}

// ---------- colour picker ----------

export function ColourPanel({ onClose }: { onClose: () => void }) {
  const [hex, setHex] = useState('');
  const [copied, setCopied] = useState('');
  const supported = typeof (window as any).EyeDropper === 'function';
  const pick = async () => {
    try {
      const r = await new (window as any).EyeDropper().open();
      setHex(String(r.sRGBHex).toUpperCase());
    } catch { /* cancelled with Esc */ }
  };
  const n = hex ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : [0, 0, 0];
  const rgb = `rgb(${n[0]}, ${n[1]}, ${n[2]})`;
  const copy = (v: string) => { window.island?.copyText(v); setCopied(v); window.setTimeout(() => setCopied(''), 1200); };
  return (
    <Panel title="Colour" onClose={onClose} action={<button className="pillbtn solid" disabled={!supported} onClick={pick}>Pick from screen</button>}>
      {!supported && <p className="outcome outcome-bad">The colour picker is not available in this build.</p>}
      {hex ? (
        <div className="colour">
          <span className="swatch" style={{ background: hex }} />
          <div className="rows grow">
            <button className="row row-button" onClick={() => copy(hex)}><span className="row-main">{hex}</span><span className="row-sub">{copied === hex ? 'Copied' : 'Copy'}</span></button>
            <button className="row row-button" onClick={() => copy(rgb)}><span className="row-main">{rgb}</span><span className="row-sub">{copied === rgb ? 'Copied' : 'Copy'}</span></button>
          </div>
        </div>
      ) : supported && <p className="empty">Press the button, then click anywhere on your screen to grab that colour.</p>}
    </Panel>
  );
}
