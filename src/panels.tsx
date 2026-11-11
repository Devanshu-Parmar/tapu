import { useEffect, useState, type ReactNode } from 'react';
import type { City, ClaudeState, ClaudeUsage, Clip, TimerState, VoiceInfo, VoiceState, Weather } from './types';
import { GROUPS, convert, pretty, type UnitGroup } from './units';
import { Icon, PATHS, clock, mmss, weatherPath, weatherWord } from './ui';

/** Frame shared by every panel: back arrow, title, optional action, then the content. */
export function Panel({ title, onClose, action, children }: { title: string; onClose: () => void; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="box black panel">
      <header className="panel-head">
        <button className="round" aria-label="Back to tools" onClick={onClose}><Icon d={PATHS.back} size={15} width={2.2} /></button>
        <h2>{title}</h2>
        <span className="spacer" />
        {action}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

// ---------- world clocks ----------

export const CITIES: City[] = [
  { label: 'New York', tz: 'America/New_York' }, { label: 'London', tz: 'Europe/London' },
  { label: 'Paris', tz: 'Europe/Paris' }, { label: 'Berlin', tz: 'Europe/Berlin' },
  { label: 'Dubai', tz: 'Asia/Dubai' }, { label: 'Mumbai', tz: 'Asia/Kolkata' },
  { label: 'Singapore', tz: 'Asia/Singapore' }, { label: 'Hong Kong', tz: 'Asia/Hong_Kong' },
  { label: 'Tokyo', tz: 'Asia/Tokyo' }, { label: 'Seoul', tz: 'Asia/Seoul' },
  { label: 'Sydney', tz: 'Australia/Sydney' }, { label: 'Auckland', tz: 'Pacific/Auckland' },
  { label: 'Los Angeles', tz: 'America/Los_Angeles' }, { label: 'Chicago', tz: 'America/Chicago' },
  { label: 'Toronto', tz: 'America/Toronto' }, { label: 'São Paulo', tz: 'America/Sao_Paulo' },
  { label: 'Moscow', tz: 'Europe/Moscow' }, { label: 'Johannesburg', tz: 'Africa/Johannesburg' },
];

/** How far ahead (+) or behind (-) a time zone is from this computer, in hours. */
function hoursAhead(now: Date, tz: string): number {
  const there = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const here = new Date(now.toLocaleString('en-US'));
  return Math.round((there.getTime() - here.getTime()) / 360000) / 10;
}

export function ClocksPanel({ now, cities, setCities, onClose }: { now: Date; cities: City[]; setCities: (c: City[]) => void; onClose: () => void }) {
  const left = CITIES.filter((c) => !cities.some((x) => x.tz === c.tz));
  return (
    <Panel title="World clocks" onClose={onClose} action={<>
      <button className="pillbtn" onClick={() => window.island?.openStage('clock')}>Full screen</button>
      {left.length > 0 && (
        <select className="field" aria-label="Add a city" value="" onChange={(e) => { const c = CITIES.find((x) => x.tz === e.target.value); if (c) setCities([...cities, c]); }}>
          <option value="">Add city</option>
          {left.map((c) => <option key={c.tz} value={c.tz}>{c.label}</option>)}
        </select>
      )}
    </>}>
      {cities.length === 0 && <p className="empty">No cities yet. Add one from the menu above.</p>}
      <ul className="rows">
        {cities.map((c, i) => {
          const t = clock(now, c.tz);
          const diff = hoursAhead(now, c.tz);
          const dayThere = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: c.tz }).format(now);
          return (
            <li key={c.tz} className="row">
              <div className="row-text">
                <span className="row-main">{c.label}{i === 0 && <em className="tag">in bar</em>}</span>
                <span className="row-sub">{dayThere} · {diff === 0 ? 'same time' : `${Math.abs(diff)} h ${diff > 0 ? 'ahead' : 'behind'}`}</span>
              </div>
              <span className="row-big">{t.time}<small>{t.ampm}</small></span>
              <button className="round quiet" aria-label={`Remove ${c.label}`} onClick={() => setCities(cities.filter((x) => x.tz !== c.tz))}><Icon d={PATHS.close} size={12} width={2.2} /></button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ---------- weather ----------

export function WeatherPanel({ weather, onClose }: { weather: Weather | null; onClose: () => void }) {
  return (
    <Panel title={weather ? `Weather · ${weather.city}` : 'Weather'} onClose={onClose}>
      {!weather ? <p className="empty">Weather has not loaded yet. Check your internet connection.</p> : (
        <>
          <div className="wx-now">
            <Icon d={weatherPath(weather.code, weather.day)} size={40} width={1.5} />
            <div className="wx-now-text">
              <span className="wx-temp">{weather.temp}°{weather.unit ?? 'C'}</span>
              <span className="row-sub">{weatherWord(weather.code)} · feels like {weather.feels}°</span>
            </div>
            <div className="wx-facts">
              <span><b>{weather.humidity}%</b> humidity</span>
              <span><b>{weather.wind}</b> km/h wind</span>
            </div>
          </div>
          <div className="wx-days">
            {weather.days.map((d, i) => (
              <div key={d.date} className="wx-day">
                <span className="row-sub">{i === 0 ? 'Today' : new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(d.date + 'T12:00:00'))}</span>
                <Icon d={weatherPath(d.code, true)} size={20} />
                <span className="wx-hi">{d.max}°</span>
                <span className="row-sub">{d.min}°</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// ---------- calendar ----------

const MARKS = ['red', 'orange', 'green', 'blue', 'purple'] as const;
type Mark = (typeof MARKS)[number];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayKey = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

interface DayNote { color: Mark; text: string }

export function CalendarPanel({ now, onClose }: { now: Date; onClose: () => void }) {
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  // What you have put on each day, as "2026-11-14" -> colour and a line of text.
  const [notes, setNotes] = useState<Record<string, DayNote>>({});
  const [picked, setPicked] = useState<number | null>(now.getDate());
  useEffect(() => {
    window.island?.load('calendarMarks').then((v) => {
      if (!v || typeof v !== 'object') return;
      const out: Record<string, DayNote> = {};
      // Earlier versions saved only a colour; carry those over.
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string') out[k] = { color: val as Mark, text: '' };
        else if (val && typeof val === 'object') out[k] = { color: ((val as DayNote).color || 'red') as Mark, text: String((val as DayNote).text || '') };
      }
      setNotes(out);
    }).catch(() => {});
  }, []);

  const step = (by: number) => { const d = new Date(year, month + by, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); setPicked(null); };
  const key = picked ? dayKey(year, month, picked) : '';
  const current = key ? notes[key] : undefined;
  const change = (next: DayNote | null) => {
    if (!key) return;
    const all = { ...notes };
    if (next) all[key] = next; else delete all[key];
    setNotes(all);
    window.island?.save('calendarMarks', all);
  };

  const days = new Date(year, month + 1, 0).getDate();
  const lead = new Date(year, month, 1).getDay();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const isNow = year === now.getFullYear() && month === now.getMonth();
  const years = Array.from({ length: 21 }, (_, i) => now.getFullYear() - 10 + i);

  return (
    <Panel title="Calendar" onClose={onClose} action={
      <>
        {!isNow && <button className="pillbtn" onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); setPicked(now.getDate()); }}>Today</button>}
        <select className="field" aria-label="Month" value={month} onChange={(e) => { setMonth(Number(e.target.value)); setPicked(null); }}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
        <select className="field" aria-label="Year" value={year} onChange={(e) => { setYear(Number(e.target.value)); setPicked(null); }}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
        <button className="round" aria-label="Previous month" onClick={() => step(-1)}><Icon d={PATHS.back} size={14} width={2.2} /></button>
        <button className="round" aria-label="Next month" onClick={() => step(1)}><Icon d="M10 6l6 6-6 6" size={14} width={2.2} /></button>
      </>
    }>
      <div className="cal">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="cal-head">{d}</span>)}
        {cells.map((d, i) => {
          if (d === null) return <span key={i} />;
          const n = notes[dayKey(year, month, d)];
          return (
            <button key={i} className={`cal-day ${isNow && d === now.getDate() ? 'cal-today' : ''} ${n ? 'cal-' + n.color : ''} ${picked === d ? 'cal-picked' : ''}`}
              aria-label={`${d} ${MONTHS[month]}${n ? ': ' + (n.text || 'marked ' + n.color) : ''}`} aria-pressed={picked === d} onClick={() => setPicked(d)}>{d}</button>
          );
        })}
      </div>
      {picked ? (
        <div className="swatches">
          <input className="field grow" placeholder={`What is on ${picked} ${MONTHS[month].slice(0, 3)}?`} aria-label={`Note for ${picked} ${MONTHS[month]}`}
            value={current?.text ?? ''} onChange={(e) => change({ color: current?.color ?? 'red', text: e.target.value })} />
          {MARKS.map((m) => <button key={m} className={`swatch-dot cal-${m} ${current?.color === m ? 'on' : ''}`} aria-label={`Mark in ${m}`} aria-pressed={current?.color === m} onClick={() => change({ color: m, text: current?.text ?? '' })} />)}
          {current && <button className="round quiet" aria-label="Remove this mark" onClick={() => change(null)}><Icon d={PATHS.trash} size={13} width={2} /></button>}
        </div>
      ) : <p className="hint">Tap a day to mark it and write what is on.</p>}
    </Panel>
  );
}
// ---------- timer ----------

export function timerLeft(t: TimerState, nowMs: number): number {
  return t.endAt ? Math.max(0, (t.endAt - nowMs) / 1000) : t.left;
}

export function TimerPanel({ now, timer, setTimer, onClose }: { now: Date; timer: TimerState; setTimer: (t: TimerState) => void; onClose: () => void }) {
  const [custom, setCustom] = useState('');
  const left = timerLeft(timer, now.getTime());
  const running = timer.endAt !== null;
  const set = (minutes: number) => setTimer({ total: minutes * 60, left: minutes * 60, endAt: null });
  const frac = timer.total > 0 ? left / timer.total : 0;
  return (
    <Panel title="Timer" onClose={onClose} action={<button className="pillbtn" onClick={() => window.island?.openStage('timer')}>Full screen</button>}>
      <div className="timer">
        <div className="ring">
          <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
            <circle cx="46" cy="46" r="39" fill="none" stroke="var(--track)" strokeWidth="7" />
            <circle cx="46" cy="46" r="39" fill="none" stroke="var(--orange)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${Math.max(frac, 0.001) * 245} 245`} transform="rotate(-90 46 46)" />
          </svg>
          <span className="ring-text timer-text">{mmss(Math.ceil(left))}</span>
        </div>
        <div className="timer-side">
          <div className="presets">
            {[1, 5, 10, 25, 45].map((m) => <button key={m} className="pillbtn" onClick={() => set(m)}>{m} min</button>)}
          </div>
          <form className="add" onSubmit={(e) => { e.preventDefault(); const m = Number(custom); if (m > 0 && m <= 600) { set(m); setCustom(''); } }}>
            <input className="field grow" inputMode="decimal" placeholder="Minutes" aria-label="Custom minutes" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))} />
            <button className="pillbtn" type="submit">Set</button>
          </form>
          <div className="presets">
            <button className="pillbtn solid" disabled={left <= 0} onClick={() => setTimer(running ? { ...timer, left, endAt: null } : { ...timer, endAt: Date.now() + left * 1000 })}>{running ? 'Pause' : 'Start'}</button>
            <button className="pillbtn" onClick={() => setTimer({ total: timer.total, left: timer.total, endAt: null })}>Reset</button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ---------- unit converter ----------

export function ConvertPanel({ onClose }: { onClose: () => void }) {
  const [gi, setGi] = useState(0);
  // Currency is added once today's rates arrive; each currency's size is given in US dollars.
  const [money, setMoney] = useState<UnitGroup | null>(null);
  useEffect(() => {
    window.island?.rates().then((r) => {
      if (!r) return;
      const units: Record<string, number> = {};
      for (const code of ['INR', 'USD', 'EUR', 'GBP', 'AED', 'JPY', 'AUD', 'CAD', 'SGD', 'CNY', 'CHF', 'SAR']) if (r[code] > 0) units[code] = 1 / r[code];
      setMoney({ name: 'Currency', units });
    }).catch(() => {});
  }, []);
  const groups = money ? [...GROUPS, money] : GROUPS;
  const group = groups[Math.min(gi, groups.length - 1)];
  const names = Object.keys(group.units);
  const [from, setFrom] = useState(names[0]);
  const [to, setTo] = useState(names[1]);
  const [value, setValue] = useState('1');
  useEffect(() => { const n = Object.keys(groups[Math.min(gi, groups.length - 1)].units); setFrom(n[0]); setTo(n[1]); }, [gi]);
  const num = Number(value);
  const ok = value.trim() !== '' && isFinite(num) && names.includes(from) && names.includes(to);
  const out = ok ? pretty(convert(group, num, from, to)) : '';
  return (
    <Panel title="Convert" onClose={onClose} action={
      <select className="field" aria-label="Kind of unit" value={gi} onChange={(e) => setGi(Number(e.target.value))}>
        {groups.map((g, i) => <option key={g.name} value={i}>{g.name}</option>)}
      </select>
    }>
      <div className="conv">
        <div className="conv-side">
          <input className="field big" inputMode="decimal" aria-label="Value" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.\-eE]/g, ''))} />
          <select className="field" aria-label="From unit" value={from} onChange={(e) => setFrom(e.target.value)}>{names.map((n) => <option key={n}>{n}</option>)}</select>
        </div>
        <button className="round" aria-label="Swap units" onClick={() => { setFrom(to); setTo(from); }}><Icon d="M4 8h14l-3-3M20 16H6l3 3" size={15} width={2} /></button>
        <div className="conv-side">
          <output className="field big out">{out || '—'}</output>
          <select className="field" aria-label="To unit" value={to} onChange={(e) => setTo(e.target.value)}>{names.map((n) => <option key={n}>{n}</option>)}</select>
        </div>
      </div>
    </Panel>
  );
}

// ---------- clipboard history ----------

export function ClipsPanel({ clips, onClose }: { clips: Clip[]; onClose: () => void }) {
  const [copied, setCopied] = useState<number | null>(null);
  const flash = (i: number) => { setCopied(i); window.setTimeout(() => setCopied(null), 1200); };
  return (
    <Panel title="Clipboard" onClose={onClose} action={clips.length > 0 && <button className="pillbtn" onClick={() => window.island?.clearClips()}>Clear</button>}>
      {clips.length === 0 && <p className="empty">Text and pictures you copy will be kept here, newest first.</p>}
      <ul className="rows">
        {clips.map((c, i) => (
          <li key={typeof c === 'string' ? 't' + i : c.id}>
            {typeof c === 'string' ? (
              <button className="row row-button" onClick={() => { window.island?.copyClip(c); flash(i); }}>
                <span className="row-main clip">{c.trim().slice(0, 160)}</span>
                <span className="row-sub">{copied === i ? 'Copied' : 'Copy'}</span>
              </button>
            ) : (
              <button className="row row-button" onClick={() => { window.island?.copyClipPicture(c.id); flash(i); }}>
                <img className="clip-thumb" src={c.thumb} alt="" />
                <span className="row-main">Picture, {c.w} × {c.h}</span>
                <span className="row-sub">{copied === i ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------- Claude Code ----------

const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

function ago(ms: number, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - ms) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

export function ClaudePanel({ now, claude, onClose }: { now: Date; claude: ClaudeState; onClose: () => void }) {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  // Re-add today's tokens whenever a session starts or stops.
  useEffect(() => { window.island?.claudeUsage().then(setUsage).catch(() => {}); }, [claude.active]);
  return (
    <Panel title="Claude Code" onClose={onClose} action={<span className="row-sub">{claude.active > 0 ? `${claude.active} working` : 'idle'}</span>}>
      <div className="stats">
        <div><b>{usage ? compact(usage.output) : '…'}</b><span>written today</span></div>
        <div><b>{usage ? compact(usage.input + usage.cacheRead + usage.cacheWrite) : '…'}</b><span>read today</span></div>
        <div><b>{usage ? usage.replies : '…'}</b><span>replies</span></div>
        <div><b>{usage ? usage.sessions : '…'}</b><span>sessions</span></div>
      </div>
      {claude.sessions.length === 0 && <p className="empty">No Claude Code sessions in the last few hours.</p>}
      <ul className="rows">
        {claude.sessions.map((s, i) => (
          <li key={i} className="row">
            <span className={`live-dot ${s.active ? 'live-on' : ''}`} />
            <div className="row-text"><span className="row-main">{s.project}</span></div>
            <span className={`row-sub ${s.active ? 'working' : ''}`}>{s.active ? 'Working' : ago(s.mtime, now)}</span>
          </li>
        ))}
      </ul>
      <p className="hint">Counts are tokens, added up from today's sessions on this laptop. Plan limits and reset times are not shown because Claude Code does not publish them anywhere the island can read.</p>
    </Panel>
  );
}

// ---------- voice dictation ----------

const MIC = 'M9 6a3 3 0 016 0v5a3 3 0 01-6 0zM6 11a6 6 0 0012 0M12 17v4';

export function VoicePanel({ now, voice, spoken, onClose }: { now: Date; voice: VoiceState; spoken: string; onClose: () => void }) {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const load = () => window.island?.voiceInfo().then(setInfo).catch(() => {});
  useEffect(() => { load(); }, []);

  const listening = voice.state === 'listening';
  const working = voice.state === 'working';
  const toggle = async () => {
    setNote('');
    if (listening) {
      const r = await window.island?.voiceStop();
      if (r?.ok && r.text) setText((t) => (t ? t + ' ' : '') + r.text);
      else setNote(r?.message ?? 'That did not work');
      load();
    } else if (!working) {
      const r = await window.island?.voiceStart();
      if (r && !r.ok) setNote(r.message ?? 'Could not start listening');
    }
  };
  const change = (mic: string, lang: string) => { window.island?.voiceSet(mic, lang); setInfo(info ? { ...info, mic, lang } : info); };
  const copy = (t: string) => { window.island?.copyText(t); setCopied(true); window.setTimeout(() => setCopied(false), 1200); };

  if (info?.problem) return <Panel title="Voice" onClose={onClose}><p className="outcome outcome-bad">{info.problem}. Dictation needs its downloaded files in the vendor folder.</p></Panel>;

  return (
    <Panel title="Voice" onClose={onClose} action={text ? <button className="pillbtn" onClick={() => copy(text)}>{copied ? 'Copied' : 'Copy'}</button> : null}>
      <div className="voice">
        <div className="voice-side">
          <button className={`mic ${listening ? 'mic-on' : ''}`} disabled={working} aria-label={listening ? 'Stop and transcribe' : 'Start listening'} onClick={toggle}>
            <Icon d={listening ? 'M8 8h8v8H8z' : MIC} size={26} fill={listening} width={1.8} />
          </button>
          <span className="row-sub">{working ? 'Last words…' : listening ? `Listening ${mmss((now.getTime() - voice.since) / 1000)}` : 'Tap to talk'}</span>
        </div>
        <div className="voice-main">
          <textarea className="field area" placeholder="What you say appears here. It is copied for you too." aria-label="Dictated text" value={listening || working ? (text ? text + ' ' : '') + spoken : text} readOnly={listening || working} onChange={(e) => setText(e.target.value)} />
          <div className="add">
            <select className="field grow" aria-label="Microphone" value={info?.mic || info?.mics[0] || ''} onChange={(e) => change(e.target.value, info?.lang ?? 'auto')}>
              {(info?.mics ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              {info && info.mics.length === 0 && <option value="">No microphone found</option>}
            </select>
            <select className="field" aria-label="Language" value={info?.lang ?? 'auto'} onChange={(e) => change(info?.mic ?? '', e.target.value)}>
              <option value="auto">Auto</option><option value="en">English</option><option value="hi">Hindi</option><option value="gu">Gujarati</option>
            </select>
          </div>
        </div>
      </div>
      {note && <p className="outcome outcome-bad">{note}</p>}
      <p className="hint">Anywhere on your laptop: tap Ctrl+Alt+Space and speak; words are typed where your cursor is as you go, and another tap stops it. Or hold the keys while you speak and let go. Pick your language instead of Auto for the quickest start. Everything runs on this laptop.</p>
      {info && info.history.length > 0 && (
        <ul className="rows">
          {info.history.slice(0, 6).map((h) => (
            <li key={h.at}><button className="row row-button" onClick={() => copy(h.text)}><span className="row-main clip">{h.text}</span><span className="row-sub">Copy</span></button></li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------- not built yet ----------

export function SoonPanel({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <Panel title={name} onClose={onClose}>
      <p className="empty">{name} is not built yet. It is on the list and will work from this tile once it is.</p>
    </Panel>
  );
}
