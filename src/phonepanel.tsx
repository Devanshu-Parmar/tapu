import { useEffect, useState } from 'react';
import type { Companion, PhoneDevice, PhoneInfo, PhoneRequest } from './types';
import { Panel } from './panels';
import { Icon } from './ui';

const PHONE = 'M7 3h10v18H7zM11 18h2';
const size = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

export function PhonePanel({ requests, devices, onClose }: { requests: PhoneRequest[]; devices: PhoneDevice[] | null; onClose: () => void }) {
  const api = window.island!;
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  // The companion link: notifications, calls, battery and clipboard, through the KDE Connect app.
  const [mates, setMates] = useState<Companion[]>([]);
  const [mateError, setMateError] = useState('');
  const [clipOn, setClipOn] = useState(true);
  useEffect(() => {
    api.companion.info().then((c) => { setMates(c.devices); setMateError(c.ok ? '' : c.error); setClipOn(c.clipboard); }).catch(() => {});
    api.companion.onDevices(setMates);
    api.companion.find();
  }, []);

  const load = () => api.phone.info().then(setInfo).catch(() => {});
  const scan = async () => { setScanning(true); await api.phone.scan(); setScanning(false); load(); };
  useEffect(() => { load().then(() => scan()); }, []);

  const list = devices ?? info?.devices ?? [];
  // Refresh the received list when something new arrives while the panel is open.
  useEffect(() => { api.phone.onEvent(() => load()); }, []);
  const act = async (d: PhoneDevice, what: 'files' | 'clipboard') => {
    setBusy(d.fingerprint + what); setNote(null);
    const r = what === 'files' ? await api.phone.sendFiles(d.fingerprint) : await api.phone.sendText(d.fingerprint);
    setBusy('');
    if (r.message !== 'cancelled') setNote({ text: r.message ?? (r.ok ? 'Sent' : 'That did not work'), bad: !r.ok });
  };

  if (info && !info.ok) {
    return <Panel title="Phone" onClose={onClose}><p className="outcome outcome-bad">{info.error}</p><p className="hint">The phone link uses port 53317. If the LocalSend desktop app is open on this laptop, close it and restart the island.</p></Panel>;
  }

  return (
    <Panel title="Phone" onClose={onClose} action={<>
      <button className="pillbtn" onClick={() => api.phone.openFolder()}>Open folder</button>
      <button className="pillbtn" disabled={scanning} onClick={scan}>{scanning ? 'Looking…' : 'Look again'}</button>
    </>}>
      {requests.map((r) => (
        <div key={r.id} className="ask">
          <div className="row-text">
            <span className="row-main">{r.alias} wants to send {r.count} {r.count === 1 ? 'item' : 'items'}</span>
            <span className="row-sub">{r.names.join(', ')}{r.count > r.names.length ? '…' : ''} · {size(r.size)}</span>
          </div>
          <button className="pillbtn solid" onClick={() => api.phone.answer(r.id, true, false)}>Accept</button>
          <button className="pillbtn" onClick={() => api.phone.answer(r.id, true, true)}>Always</button>
          <button className="pillbtn danger" onClick={() => api.phone.answer(r.id, false, false)}>Decline</button>
        </div>
      ))}
      <p className="hint">Notifications and calls</p>
      {mateError && <p className="outcome outcome-bad">{mateError}</p>}
      <ul className="rows">
        {mates.map((m) => (
          <li key={m.id} className="row">
            <span className="round"><Icon d={PHONE} size={14} width={2} /></span>
            <div className="row-text">
              <span className="row-main">{m.name}</span>
              <span className="row-sub">{m.paired ? (m.battery >= 0 ? `Connected · battery ${m.battery}%${m.charging ? ', charging' : ''}` : 'Connected') : m.pending === 'out' ? 'Waiting for you to accept on the phone…' : m.pending === 'in' ? 'Wants to pair with this laptop' : 'Found, not paired yet'}</span>
            </div>
            {m.paired && <button className="pillbtn" onClick={() => api.companion.ring(m.id)}>Ring</button>}
            {m.paired && <button className="pillbtn danger" onClick={() => api.companion.unpair(m.id)}>Unpair</button>}
            {!m.paired && m.pending === '' && <button className="pillbtn solid" onClick={() => api.companion.pair(m.id)}>Pair</button>}
            {!m.paired && m.pending === 'in' && <button className="pillbtn solid" onClick={() => api.companion.answer(m.id, true)}>Accept</button>}
            {!m.paired && m.pending === 'in' && <button className="pillbtn danger" onClick={() => api.companion.answer(m.id, false)}>Decline</button>}
          </li>
        ))}
      </ul>
      {mates.length === 0 && !mateError && <p className="empty">To get your phone's notifications and calls here, install the free KDE Connect app on the phone, join the same Wi-Fi, and open it. This laptop shows up there to pair.</p>}
      {mates.some((m) => m.paired) && (
        <div className="row">
          <div className="row-text"><span className="row-main">Share the clipboard</span><span className="row-sub">Copy on one, paste on the other</span></div>
          <button className={`switch ${clipOn ? 'switch-on' : ''}`} role="switch" aria-checked={clipOn} aria-label="Share the clipboard" onClick={() => { api.companion.setClipboard(!clipOn); setClipOn(!clipOn); }}><i /></button>
        </div>
      )}
      <p className="hint">Files</p>
      {note && <p className={`outcome ${note.bad ? 'outcome-bad' : 'outcome-ok'}`}>{note.text}</p>}
      <ul className="rows">
        {list.map((d) => (
          <li key={d.fingerprint} className="row">
            <span className="round"><Icon d={PHONE} size={14} width={2} /></span>
            <div className="row-text">
              <span className="row-main">{d.alias}{info?.trusted.includes(d.fingerprint) && <em className="tag">always accepted</em>}</span>
              <span className="row-sub">{d.seen ? d.ip : 'Not answering. Open LocalSend on the phone.'}</span>
            </div>
            <button className="pillbtn" disabled={!!busy} onClick={() => act(d, 'clipboard')}>{busy === d.fingerprint + 'clipboard' ? 'Sending…' : 'Clipboard'}</button>
            <button className="pillbtn solid" disabled={!!busy} onClick={() => act(d, 'files')}>{busy === d.fingerprint + 'files' ? 'Sending…' : 'Files'}</button>
          </li>
        ))}
      </ul>
      {list.length === 0 && (
        <p className="empty">
          {scanning ? 'Looking for your phone on this Wi-Fi…' : 'No phone found yet.'} Install the free LocalSend app on your phone, connect it to the same Wi-Fi as this laptop, and open it.
          This laptop appears there as “{info?.alias ?? 'Island'}”.
        </p>
      )}
      {info && info.received.length > 0 && (
        <>
          <p className="hint">Received</p>
          <ul className="rows">
            {info.received.slice(0, 6).map((r) => (
              <li key={r.file}><button className="row row-button" onClick={() => api.reveal(r.file)}><span className="row-main clip">{r.file.split(/[\\/]/).pop()}</span><span className="row-sub">Show</span></button></li>
            ))}
          </ul>
        </>
      )}
      <p className="hint">Files from your phone land in Downloads\Island. Text sent from the phone is copied to this laptop’s clipboard. If Windows asks whether to allow the island on your network, choose Allow, or the phone cannot reach it.</p>
    </Panel>
  );
}
