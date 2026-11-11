import { useEffect, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { ChatTurn, Place, Settings, ShareInfo, ShelfItem, ToolResult } from './types';
import { PAGES } from './tools';
import { Icon } from './ui';
import { Panel } from './panels';

const sizeText = (n: number) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const CLOSE = 'M6 6l12 12M18 6L6 18';
const FOLDER = 'M3 6h6l2 2h10v11H3z';

function Result({ r }: { r: ToolResult | null }) {
  if (!r || r.message === 'cancelled') return null;
  return (
    <p className={`outcome ${r.ok ? 'outcome-ok' : 'outcome-bad'}`}>
      <span>{r.message ?? (r.ok ? 'Done' : 'That did not work')}</span>
      {r.ok && r.file && <button className="pillbtn" onClick={() => window.island?.reveal(r.file!)}>Show</button>}
    </p>
  );
}

// ---------- shelf ----------

export function ShelfPanel({ onClose, openShare }: { onClose: () => void; openShare: () => void }) {
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);
  useEffect(() => {
    window.island?.shelf.list().then(setItems).catch(() => {});
    window.island?.shelf.onChange(setItems);
  }, []);
  const run = async (work?: Promise<ToolResult>) => { if (!work) return; setBusy(true); setResult(null); setResult(await work.catch(() => ({ ok: false }))); setBusy(false); };
  const files = items.filter((i) => !i.dir).length;
  return (
    <Panel title="Shelf" onClose={onClose} action={<button className="pillbtn solid" onClick={() => window.island?.shelf.pick().then(setItems)}>Add</button>}>
      {items.length === 0 && <p className="empty">Park files here while you work. Drag them onto the island from any folder, then drag them back out wherever you need them.</p>}
      <ul className="rows">
        {items.map((it) => (
          <li key={it.file} className="row shelf-row" draggable onDragStart={(e) => { e.preventDefault(); window.island?.shelf.drag(it.file); }}>
            <span className="shelf-icon"><Icon d={it.dir ? FOLDER : 'M7 3h7l4 4v14H7zM14 3v4h4'} size={14} width={2} /></span>
            <span className="row-main grow">{it.name}</span>
            <span className="row-sub">{it.dir ? 'Folder' : sizeText(it.size)}</span>
            <button className="round small" aria-label={`Show ${it.name} in its folder`} onClick={() => window.island?.shelf.reveal(it.file)}><Icon d={FOLDER} size={12} width={2} /></button>
            <button className="round small" aria-label={`Take ${it.name} off the shelf`} onClick={() => window.island?.shelf.remove(it.file).then(setItems)}><Icon d={CLOSE} size={12} width={2.2} /></button>
          </li>
        ))}
      </ul>
      {items.length > 0 && (
        <div className="actions shelf-actions">
          <button className="pillbtn" disabled={busy || files === 0} onClick={() => run(window.island?.shelf.zip())}>Zip</button>
          <button className="pillbtn" disabled={busy || files === 0} onClick={() => run(window.island?.shelf.toPhone())}>To phone</button>
          <button className="pillbtn" disabled={files === 0} onClick={() => { window.island?.share.start('shelf'); openShare(); }}>Share link</button>
          <span className="spacer" />
          <button className="pillbtn danger" onClick={() => window.island?.shelf.clear().then(setItems)}>Clear</button>
        </div>
      )}
      {busy && <p className="outcome">Working…</p>}
      <Result r={result} />
      {items.length > 0 && <p className="hint">Files stay where they are; the shelf only remembers them. Drag a row out to drop the file somewhere.</p>}
    </Panel>
  );
}

// ---------- quick share ----------

export function SharePanel({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [note, setNote] = useState<ToolResult | null>(null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    window.island?.share.info().then(setInfo).catch(() => {});
    window.island?.share.onChange(setInfo);
    const id = window.setInterval(() => tick((n) => n + 1), 20000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => { setQr(''); }, [info?.url]);
  const start = async (source: 'pick' | 'receive') => { setNote(null); const r = await window.island?.share.start(source); if (r && !r.ok) setNote(r); };
  const showQr = async () => { if (info) setQr(await QRCode.toDataURL(info.url, { margin: 1, width: 132 })); };

  if (!info) {
    return (
      <Panel title="Quick Share" onClose={onClose}>
        <div className="actions">
          <button className="pillbtn solid" onClick={() => start('pick')}>Share files</button>
          <button className="pillbtn" onClick={() => start('receive')}>Only receive</button>
        </div>
        <Result r={note} />
        <p className="hint">Makes a link that any phone or computer on the same Wi-Fi can open in its browser, to download your files or send some to this laptop. No app is needed on the other side. The link stops working after 15 minutes. (This is the island's own sharing, not Google's Quick Share.)</p>
      </Panel>
    );
  }
  const left = Math.max(1, Math.round((info.until - Date.now()) / 60000));
  return (
    <Panel title="Quick Share" onClose={onClose} action={<button className="pillbtn danger" onClick={() => window.island?.share.stop()}>Stop</button>}>
      <p className="link">{info.url}</p>
      <div className="actions">
        <button className="pillbtn solid" onClick={() => { window.island?.copyText(info.url); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{copied ? 'Copied' : 'Copy link'}</button>
        <button className="pillbtn" onClick={async () => setNote((await window.island?.share.toPhone()) ?? null)}>Send to phone</button>
        {!qr && <button className="pillbtn" onClick={showQr}>Show code</button>}
      </div>
      {qr && <img className="qr" src={qr} alt="QR code for the share link" width={132} height={132} />}
      <Result r={note} />
      <p className="hint">{info.files.length ? `${info.files.length} ${info.files.length === 1 ? 'file' : 'files'} on offer: ${info.files.slice(0, 3).map((f) => f.name).join(', ')}${info.files.length > 3 ? '…' : ''}. ` : 'Receiving only. '}Open the link on a device on this Wi-Fi. Works for {left} more {left === 1 ? 'minute' : 'minutes'}.</p>
    </Panel>
  );
}

// ---------- translate ----------

export function TranslatePanel({ onClose }: { onClose: () => void }) {
  const [langs, setLangs] = useState<[string, string][]>([['en', 'English'], ['hi', 'Hindi'], ['gu', 'Gujarati']]);
  const [from, setFrom] = useState('auto');
  const [to, setTo] = useState('hi');
  const [text, setText] = useState('');
  const [out, setOut] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    window.island?.translateLangs().then(setLangs).catch(() => {});
    window.island?.load('translatePair').then((v) => { const p = v as { from?: string; to?: string } | null; if (p?.from) setFrom(p.from); if (p?.to) setTo(p.to); }).catch(() => {});
  }, []);
  const pair = (f: string, t: string) => { setFrom(f); setTo(t); window.island?.save('translatePair', { from: f, to: t }); };
  const go = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setNote('');
    const r = await window.island?.translate(text, from, to).catch(() => null);
    setBusy(false);
    if (r?.ok) setOut(r.text ?? ''); else setNote(r?.message ?? 'That did not work');
  };
  return (
    <Panel title="Translate" onClose={onClose} action={<button className="pillbtn solid" disabled={busy || !text.trim()} onClick={go}>{busy ? 'Working…' : 'Translate'}</button>}>
      <div className="add">
        <select className="field grow" aria-label="From language" value={from} onChange={(e) => pair(e.target.value, to)}>
          <option value="auto">Detect language</option>
          {langs.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
        <button className="round" aria-label="Swap languages" disabled={from === 'auto'} onClick={() => { pair(to, from); setText(out); setOut(text); }}><Icon d="M4 8h14l-3-3M20 16H6l3 3" size={14} width={2} /></button>
        <select className="field grow" aria-label="To language" value={to} onChange={(e) => pair(from, e.target.value)}>
          {langs.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </div>
      <div className="twin">
        <textarea className="field area" placeholder="Type or paste text" aria-label="Text to translate" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) go(); }} />
        <textarea className="field area" placeholder="Translation" aria-label="Translation" readOnly value={out} />
      </div>
      {note && <p className="outcome outcome-bad">{note}</p>}
      <div className="actions">
        <span className="hint grow">Sent to MyMemory's free translation service. Ctrl+Enter translates.</span>
        {out && <button className="pillbtn" onClick={() => { window.island?.copyText(out); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{copied ? 'Copied' : 'Copy'}</button>}
      </div>
    </Panel>
  );
}

// ---------- ask AI ----------

export function AiPanel({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ hasKey: boolean; models: { id: string; label: string }[]; model: string } | null>(null);
  const [key, setKey] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState(''); // the reply as it streams in
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const load = () => window.island?.ai.info().then(setInfo).catch(() => {});
  useEffect(() => {
    load();
    window.island?.ai.onText((piece) => setDraft((d) => d + piece));
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns, draft]);

  const saveKey = async () => {
    const r = await window.island?.ai.setKey(key);
    setKey('');
    if (r && !r.ok) setNote(r.message ?? 'The key was not saved'); else setNote('');
    load();
  };
  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    const next: ChatTurn[] = [...turns, { role: 'user', content: q }];
    setTurns(next); setText(''); setDraft(''); setNote(''); setBusy(true);
    const r = await window.island?.ai.ask(next).catch(() => null);
    setBusy(false);
    if (r?.ok) setTurns([...next, { role: 'assistant', content: r.text ?? '' }]);
    else { setNote(r?.message ?? 'That did not work'); setTurns(turns); setText(q); }
    setDraft('');
  };

  if (info && !info.hasKey) {
    return (
      <Panel title="Ask AI" onClose={onClose}>
        <p className="empty">Ask AI uses Claude, and needs your own Anthropic API key. Make one at console.anthropic.com, then paste it here. It is kept encrypted by Windows on this laptop, and only ever sent to Anthropic.</p>
        <form className="add" onSubmit={(e) => { e.preventDefault(); saveKey(); }}>
          <input className="field grow" type="password" placeholder="sk-ant-…" aria-label="Anthropic API key" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="pillbtn solid" type="submit" disabled={!key.trim()}>Save</button>
        </form>
        {note && <p className="outcome outcome-bad">{note}</p>}
      </Panel>
    );
  }
  return (
    <Panel title="Ask AI" onClose={onClose} action={info && (
      <>
        {turns.length > 0 && <button className="pillbtn" onClick={() => { setTurns([]); setNote(''); }}>New</button>}
        <select className="field" aria-label="Model" value={info.model} onChange={(e) => { window.island?.ai.setModel(e.target.value); setInfo({ ...info, model: e.target.value }); }}>
          {info.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </>
    )}>
      <div className="chat">
        {turns.length === 0 && !busy && <p className="empty">Ask anything. Answers come from Claude and use your API key.</p>}
        {turns.map((t, i) => <p key={i} className={`bubble ${t.role === 'user' ? 'bubble-me' : ''}`}>{t.content}</p>)}
        {busy && <p className="bubble">{draft || 'Thinking…'}</p>}
        <div ref={end} />
      </div>
      {note && <p className="outcome outcome-bad">{note}</p>}
      <form className="add chat-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input className="field grow" autoFocus placeholder="Ask a question" aria-label="Your question" value={text} onChange={(e) => setText(e.target.value)} />
        {busy
          ? <button className="pillbtn" type="button" onClick={() => window.island?.ai.stop()}>Stop</button>
          : <button className="pillbtn solid" type="submit" disabled={!text.trim()}>Ask</button>}
      </form>
      {turns.length === 0 && !busy && <button className="textbtn" onClick={async () => { await window.island?.ai.setKey(''); load(); }}>Forget my API key</button>}
    </Panel>
  );
}

// ---------- settings ----------

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button className={`switch ${on ? 'switch-on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}><i /></button>;
}

function Row({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <li className="row">
      <div className="row-text"><span className="row-main">{title}</span>{sub && <span className="row-sub wrap">{sub}</span>}</div>
      {children}
    </li>
  );
}

const TOOLS = PAGES.flatMap((p) => p.items).filter((t) => t.id !== 'settings');

export function SettingsPanel({ settings, change, dock, setDock, onClose }: { settings: Settings; change: (part: Partial<Settings>) => void; dock: boolean; setDock: (on: boolean) => void; onClose: () => void }) {
  const [startup, setStartup] = useState<boolean | null>(null);
  const [winNotes, setWinNotes] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<(Place & { where: string })[] | null>(null);
  useEffect(() => {
    window.island?.getStartup().then(setStartup).catch(() => setStartup(false));
    window.island?.settingsInfo().then((i) => setWinNotes(i.winNotes)).catch(() => {});
  }, []);
  const search = async () => { if (query.trim().length >= 2) setFound((await window.island?.placeSearch(query)) ?? []); };
  const toggleTool = (id: string) => change({ hidden: settings.hidden.includes(id) ? settings.hidden.filter((h) => h !== id) : [...settings.hidden, id] });
  return (
    <Panel title="Settings" onClose={onClose}>
      <h3 className="set-head">Look</h3>
      <ul className="rows">
        <Row title="Colour">
          <select className="field" aria-label="Colour" value={settings.theme} onChange={(e) => change({ theme: e.target.value as Settings['theme'] })}>
            <option value="black">Black</option><option value="graphite">Graphite</option><option value="midnight">Midnight</option><option value="light">Light</option>
          </select>
        </Row>
        <Row title="Size">
          <select className="field" aria-label="Size" value={settings.scale} onChange={(e) => change({ scale: Number(e.target.value) })}>
            <option value={0.9}>Small</option><option value={1}>Normal</option><option value={1.15}>Large</option><option value={1.3}>Extra large</option>
          </select>
        </Row>
        <Row title="24-hour clock"><Switch on={settings.clock24} label="24-hour clock" onChange={(v) => change({ clock24: v })} /></Row>
      </ul>

      <h3 className="set-head">Weather</h3>
      <ul className="rows">
        <Row title="City" sub={settings.place ? settings.place.city : 'Surat'}>
          <form className="add tight" onSubmit={(e) => { e.preventDefault(); search(); }}>
            <input className="field" placeholder="Find a city" aria-label="Find a city" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="pillbtn" type="submit" disabled={query.trim().length < 2}>Find</button>
          </form>
        </Row>
        {found && found.length === 0 && <li className="row"><span className="row-sub">No place found with that name.</span></li>}
        {found && found.map((p) => (
          <li key={p.lat + ',' + p.lon}><button className="row row-button" onClick={() => { change({ place: { city: p.city, lat: p.lat, lon: p.lon } }); setFound(null); setQuery(''); }}><span className="row-main">{p.city}</span><span className="row-sub">{p.where}</span></button></li>
        ))}
        <Row title="Temperature">
          <select className="field" aria-label="Temperature unit" value={settings.unit} onChange={(e) => change({ unit: e.target.value as 'c' | 'f' })}><option value="c">Celsius</option><option value="f">Fahrenheit</option></select>
        </Row>
      </ul>

      <h3 className="set-head">Behaviour</h3>
      <ul className="rows">
        <Row title="Peek on changes" sub="Drop down for a moment when the song changes or charging starts"><Switch on={settings.peek} label="Peek on changes" onChange={(v) => change({ peek: v })} /></Row>
        <Row title="Sounds" sub="A short beep for reminders, timers and calls"><Switch on={settings.sounds} label="Sounds" onChange={(v) => change({ sounds: v })} /></Row>
        <Row title="Song lyrics" sub="Looked up on lrclib.net by title and artist"><Switch on={settings.lyrics} label="Song lyrics" onChange={(v) => change({ lyrics: v })} /></Row>
        <Row title="Sticky notes on the screen edge" sub="Off: notes open here in the island only"><Switch on={dock} label="Sticky notes on the screen edge" onChange={setDock} /></Row>
        <Row title="Start with Windows" sub="Open Island when you sign in"><Switch on={!!startup} label="Start with Windows" disabled={startup === null} onChange={(v) => window.island?.setStartup(v).then(setStartup)} /></Row>
      </ul>

      <h3 className="set-head">Notifications and clipboard</h3>
      <ul className="rows">
        <Row title="Windows app notifications" sub={winNotes === 'denied' ? 'Windows refused access. Allow it under Settings, Privacy, Notifications' : winNotes === 'failed' ? 'Not available on this version of Windows' : 'WhatsApp, Mail and other apps show up as a pill'}><Switch on={settings.winNotes} label="Windows app notifications" onChange={(v) => change({ winNotes: v })} /></Row>
        <Row title="Phone notifications" sub="From a phone paired under Phone"><Switch on={settings.phoneNotes} label="Phone notifications" onChange={(v) => change({ phoneNotes: v })} /></Row>
        <Row title="Clipboard history" sub="Keep the last things you copied, pictures included"><Switch on={settings.clipHistory} label="Clipboard history" onChange={(v) => change({ clipHistory: v })} /></Row>
      </ul>

      <h3 className="set-head">Tools shown</h3>
      <div className="chips">
        {TOOLS.map((t) => (
          <button key={t.id} className={`chip ${settings.hidden.includes(t.id) ? '' : 'chip-on'}`} aria-pressed={!settings.hidden.includes(t.id)} onClick={() => toggleTool(t.id)}>{t.label}</button>
        ))}
      </div>

      <h3 className="set-head">App</h3>
      <ul className="rows">
        <Row title="Shortcuts" sub="Ctrl+Alt+I hide or show · Ctrl+Alt+Space dictate · Ctrl+Alt+Q quit · Esc close" />
        <Row title="Switch off" sub="Also in the menu of the island's icon beside the clock"><button className="pillbtn danger" onClick={() => window.island?.quit()}>Quit</button></Row>
      </ul>
    </Panel>
  );
}
