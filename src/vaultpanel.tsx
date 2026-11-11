import { useEffect, useState } from 'react';
import type { VaultItem } from './types';
import { Panel } from './panels';
import { Icon, PATHS } from './ui';

const KEY = 'M14.5 4a5.5 5.5 0 11-5.2 7.300L3 17.600V21h3.400v-2.200h2.200v-2.200h2.400l1.300-1.300A5.500 5.500 0 0114.500 4zM16.500 8h.01';
const PERSON = 'M12 4a4 4 0 100 8 4 4 0 000-8zM4.500 20a7.500 7.500 0 0115 0';
const PENCIL = 'M4 20h4l10-10-4-4L4 16zM13 7l4 4';
const EYE = 'M2.500 12s3.500-6.500 9.500-6.500 9.500 6.500 9.500 6.500-3.500 6.500-9.500 6.500S2.500 12 2.500 12zM12 9.500a2.500 2.500 0 100 5 2.500 2.500 0 000-5z';

interface Draft { id?: string; title: string; user: string; password: string; url: string }

export function VaultPanel({ onClose }: { onClose: () => void }) {
  const api = window.island!;
  const [state, setState] = useState<{ exists: boolean; unlocked: boolean } | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [query, setQuery] = useState('');
  const [master, setMaster] = useState('');
  const [again, setAgain] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [show, setShow] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const s = await api.vault.status();
    setState(s);
    if (s.unlocked) { const l = await api.vault.list(); setItems(l.items); }
  };
  useEffect(() => { refresh(); }, []);

  // The vault locks itself after a few idle minutes; notice that instead of showing a stale list.
  const guard = async <T extends { ok: boolean; locked?: boolean; message?: string }>(work: Promise<T>): Promise<T | null> => {
    const r = await work;
    if (r.locked) { setDraft(null); setNote({ text: 'The vault locked itself. Unlock it again.', bad: true }); await refresh(); return null; }
    return r;
  };

  const create = async () => {
    if (master !== again) { setNote({ text: 'The two passwords do not match', bad: true }); return; }
    setBusy(true);
    const r = await api.vault.create(master);
    setBusy(false);
    setMaster(''); setAgain('');
    setNote(r.ok ? null : { text: r.message ?? 'Could not create the vault', bad: true });
    refresh();
  };
  const unlock = async () => {
    setBusy(true);
    const r = await api.vault.unlock(master);
    setBusy(false);
    setMaster('');
    setNote(r.ok ? null : { text: r.message ?? 'Could not unlock', bad: true });
    refresh();
  };
  const lock = async () => { await api.vault.lock(); setDraft(null); setItems([]); setNote(null); refresh(); };

  const copy = async (id: string, what: 'password' | 'user') => {
    const r = await guard(api.vault.copy(id, what));
    if (r) setNote(r.ok ? { text: what === 'password' ? 'Password copied. It clears from the clipboard in 20 seconds.' : 'Username copied.' } : { text: 'Could not copy', bad: true });
  };
  const edit = (it: VaultItem) => { setShow(false); setNote(null); setDraft({ id: it.id, title: it.title, user: it.user, password: '', url: it.url }); };
  const reveal = async () => {
    if (!draft?.id || draft.password) { setShow(!show); return; }
    const r = await guard(api.vault.show(draft.id));
    if (r?.ok) { setDraft({ ...draft, password: r.password ?? '' }); setShow(true); }
  };
  const save = async () => {
    if (!draft) return;
    const r = await guard(api.vault.save(draft));
    if (!r) return;
    if (!r.ok) { setNote({ text: r.message ?? 'Could not save', bad: true }); return; }
    setDraft(null); setNote({ text: 'Saved' }); refresh();
  };
  const remove = async () => {
    if (!draft?.id) return;
    const r = await guard(api.vault.remove(draft.id));
    if (r) { setDraft(null); setNote({ text: 'Deleted' }); refresh(); }
  };

  const message = note && <p className={`outcome ${note.bad ? 'outcome-bad' : 'outcome-ok'}`}>{note.text}</p>;

  if (!state) return <Panel title="Vault" onClose={onClose}><p className="empty">Opening…</p></Panel>;

  if (!state.exists) {
    return (
      <Panel title="Vault" onClose={onClose}>
        <form className="vault-form" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input className="field" type="password" autoComplete="new-password" placeholder="Choose a master password (8 or more)" aria-label="Master password" value={master} onChange={(e) => setMaster(e.target.value)} />
          <input className="field" type="password" autoComplete="new-password" placeholder="Type it again" aria-label="Master password again" value={again} onChange={(e) => setAgain(e.target.value)} />
          <button className="pillbtn solid" type="submit" disabled={busy || master.length < 8}>Create vault</button>
        </form>
        {message}
        <p className="hint">This one password protects everything in the vault. It is not stored anywhere, so if you forget it the vault cannot be opened by anyone, including me. The vault is a KeePass file kept on this laptop only.</p>
      </Panel>
    );
  }

  if (!state.unlocked) {
    return (
      <Panel title="Vault" onClose={onClose}>
        <form className="add" onSubmit={(e) => { e.preventDefault(); unlock(); }}>
          <input className="field grow" type="password" autoComplete="current-password" autoFocus placeholder="Master password" aria-label="Master password" value={master} onChange={(e) => setMaster(e.target.value)} />
          <button className="pillbtn solid" type="submit" disabled={busy || !master}>{busy ? 'Opening…' : 'Unlock'}</button>
        </form>
        {message}
        <p className="hint">The vault locks itself after 5 minutes without use, and whenever the island quits.</p>
      </Panel>
    );
  }

  if (draft) {
    return (
      <Panel title={draft.id ? 'Edit login' : 'New login'} onClose={() => setDraft(null)} action={
        <>
          {draft.id && <button className="round" aria-label="Delete this login" onClick={remove}><Icon d={PATHS.trash} size={14} width={2} /></button>}
          <button className="pillbtn solid" onClick={save}>Save</button>
        </>
      }>
        <div className="vault-form">
          <input className="field" placeholder="Name, like Gmail" aria-label="Name" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <input className="field" placeholder="Username or email" aria-label="Username" autoComplete="off" value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
          <div className="add">
            <input className="field grow" type={show ? 'text' : 'password'} autoComplete="new-password" placeholder={draft.id ? 'Password (leave empty to keep)' : 'Password'} aria-label="Password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            <button className="round" type="button" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={reveal}><Icon d={EYE} size={14} width={2} /></button>
            <button className="pillbtn" type="button" onClick={async () => { const p = await api.vault.generate(20, true); setDraft({ ...draft, password: p }); setShow(true); }}>Generate</button>
          </div>
          <input className="field" placeholder="Website (optional)" aria-label="Website" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
        </div>
        {message}
      </Panel>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => (i.title + ' ' + i.user + ' ' + i.url).toLowerCase().includes(q)) : items;
  return (
    <Panel title="Vault" onClose={onClose} action={
      <>
        <button className="pillbtn" onClick={() => api.vault.reveal()}>Show file</button>
        <button className="pillbtn" onClick={lock}>Lock</button>
        <button className="round solid" aria-label="Add a login" onClick={() => { setShow(false); setNote(null); setDraft({ title: '', user: '', password: '', url: '' }); }}><Icon d={PATHS.plus} size={14} width={2.4} /></button>
      </>
    }>
      <div className="add"><input className="field grow" placeholder="Search" aria-label="Search logins" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      {message}
      {items.length === 0 && <p className="empty">The vault is empty. Add your first login with the plus button.</p>}
      <ul className="rows">
        {shown.map((it) => (
          <li key={it.id} className="row">
            <div className="row-text"><span className="row-main">{it.title}</span>{it.user && <span className="row-sub">{it.user}</span>}</div>
            <button className="round" aria-label={`Copy username for ${it.title}`} onClick={() => copy(it.id, 'user')}><Icon d={PERSON} size={14} width={2} /></button>
            <button className="round" aria-label={`Copy password for ${it.title}`} onClick={() => copy(it.id, 'password')}><Icon d={KEY} size={14} width={2} /></button>
            <button className="round quiet" aria-label={`Edit ${it.title}`} onClick={() => edit(it)}><Icon d={PENCIL} size={13} width={2} /></button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
