import { useEffect, useMemo, useRef, useState } from 'react';
import './types';
import type { ClaudeState, ClaudeUsage, Lyrics, Media, TimerState, Volume, Weather } from './types';
import { Brand, Icon, PATHS, clock, hasBrand, mmss, weatherIcon, weatherWord } from './ui';

type Mode = 'clock' | 'music' | 'power' | 'claude' | 'timer';
const MODES: { id: Mode; label: string }[] = [
  { id: 'clock', label: 'Clock' }, { id: 'music', label: 'Music' }, { id: 'power', label: 'Battery' },
  { id: 'claude', label: 'Claude' }, { id: 'timer', label: 'Timer' },
];
const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

/** A full-screen, single-subject view: just the clock, just the music, and so on. */
export function Stage() {
  const first = useMemo(() => (new URLSearchParams(location.search).get('mode') as Mode) || 'clock', []);
  const [mode, setMode] = useState<Mode>(first);
  const [extras, setExtras] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [media, setMedia] = useState<Media | null>(null);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [claude, setClaude] = useState<ClaudeState>({ active: 0, sessions: [] });
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [lyrics, setLyrics] = useState<Lyrics>({ key: '', lines: [] });
  const [volume, setVolume] = useState<Volume>({ level: -1, muted: false });
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [battery, setBattery] = useState<{ level: number; charging: boolean } | null>(null);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);

  useEffect(() => {
    const api = window.island;
    const id = window.setInterval(() => setNow(new Date()), 1000);
    api?.state().then((s) => { setMedia(s.media); setWeather(s.weather); setClaude(s.claude); setLyrics(s.lyrics); setVolume(s.volume); }).catch(() => {});
    api?.load('stageExtras').then((v) => setExtras(v === true)).catch(() => {});
    api?.load('timer').then((v) => { if (v && typeof v === 'object') setTimer(v as TimerState); }).catch(() => {});
    api?.onStoreChanged((c) => { if (c.key === 'timer' && c.value) setTimer(c.value as TimerState); });
    api?.onMedia(setMedia); api?.onWeather(setWeather); api?.onClaude(setClaude); api?.onLyrics(setLyrics); api?.onVolume(setVolume);
    (navigator as any).getBattery?.().then((b: any) => {
      const read = () => setBattery({ level: b.level, charging: b.charging });
      read(); b.addEventListener('levelchange', read); b.addEventListener('chargingchange', read);
    }).catch(() => {});
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') api?.closeStage(); };
    document.addEventListener('keydown', key);
    return () => { window.clearInterval(id); document.removeEventListener('keydown', key); };
  }, []);

  useEffect(() => { if (mode === 'claude') window.island?.claudeUsage().then(setUsage).catch(() => {}); }, [mode, claude.active]);

  // The controls and the pointer fade away after a few still seconds.
  const wake = () => {
    setIdle(false);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 3500);
  };
  useEffect(() => { wake(); }, []);

  const t = clock(now);
  const dateText = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(now);
  const hasMedia = !!media && !!media.title;
  const progress = hasMedia && media!.dur > 0 ? Math.min(media!.pos / media!.dur, 1) : 0;
  const at = hasMedia ? lyrics.lines.reduce((best, l, i) => (l.t <= media!.pos + 0.4 ? i : best), -1) : -1;
  const timerLeft = timer ? (timer.endAt ? Math.max(0, (timer.endAt - now.getTime()) / 1000) : timer.left) : 0;
  const pct = battery ? Math.round(battery.level * 100) : 0;
  const toggleExtras = () => { const v = !extras; setExtras(v); window.island?.save('stageExtras', v); };

  return (
    <div className={`stage stage-${mode} ${idle ? 'stage-idle' : ''}`} onMouseMove={wake} onMouseDown={wake}>
      {mode === 'music' && hasMedia && media!.art && <div className="stage-glow" style={{ backgroundImage: `url(${media!.art})` }} aria-hidden="true" />}

      <main className="stage-main" key={mode}>
        {mode === 'clock' && (
          <>
            <p className="stage-kicker">{dateText}</p>
            <h1 className="stage-huge">{t.time}<small>{t.ampm}</small></h1>
            {weather && <p className="stage-line"><Icon d={weatherIcon(weather)} size={26} width={1.8} />{weather.temp}°{weather.unit ?? 'C'} · {weatherWord(weather.code)} · {weather.city}</p>}
          </>
        )}

        {mode === 'music' && (hasMedia ? (
          <div className="stage-music">
            <div className="stage-cover" style={media!.art ? { backgroundImage: `url(${media!.art})` } : undefined} />
            <div className="stage-track">
              <p className="stage-kicker">{hasBrand(media!.site) && <Brand name={media!.site} size={18} />}Now playing</p>
              <h1 className="stage-title">{media!.title}</h1>
              <p className="stage-artist">{media!.artist}</p>
              <div className="stage-lyrics">
                {lyrics.lines.length === 0 ? <span className="dim">No synced lyrics for this one</span> : (
                  <>
                    <span className="dim">{at > 0 ? lyrics.lines[at - 1].text : ' '}</span>
                    <span className="now">{at >= 0 ? lyrics.lines[at].text || '♪' : '♪'}</span>
                    <span className="dim">{at + 1 < lyrics.lines.length ? lyrics.lines[at + 1].text : ' '}</span>
                  </>
                )}
              </div>
              <button className="stage-seek" aria-label="Seek" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); window.island?.seek(((e.clientX - r.left) / r.width) * media!.dur); }}><i style={{ width: `${progress * 100}%` }} /></button>
              <div className="stage-times"><span>{mmss(media!.pos)}</span><span>-{mmss(Math.max(media!.dur - media!.pos, 0))}</span></div>
              <div className="stage-controls">
                <button aria-label="Previous" onClick={() => window.island?.media('prev')}><Icon d={PATHS.prev} size={30} fill /></button>
                <button aria-label={media!.playing ? 'Pause' : 'Play'} onClick={() => window.island?.media('toggle')}><Icon d={media!.playing ? PATHS.pause : PATHS.play} size={44} fill /></button>
                <button aria-label="Next" onClick={() => window.island?.media('next')}><Icon d={PATHS.next} size={30} fill /></button>
                {volume.level >= 0 && <input type="range" min="0" max="100" aria-label="Volume" value={Math.round(volume.level * 100)} onChange={(e) => { const v = Number(e.target.value) / 100; setVolume({ ...volume, level: v }); window.island?.setVolume(v); }} />}
              </div>
            </div>
          </div>
        ) : <p className="stage-line">Nothing is playing</p>)}

        {mode === 'power' && (battery ? (
          <>
            <div className="stage-ring">
              <svg viewBox="0 0 200 200" aria-hidden="true">
                <circle cx="100" cy="100" r="88" fill="none" stroke="var(--well)" strokeWidth="12" />
                <circle cx="100" cy="100" r="88" fill="none" strokeWidth="12" strokeLinecap="round" stroke={battery.level <= 0.2 && !battery.charging ? 'var(--red)' : 'var(--green)'} strokeDasharray={`${Math.max(battery.level, 0.01) * 553} 553`} transform="rotate(-90 100 100)" />
              </svg>
              <span>{pct}<small>%</small></span>
            </div>
            <p className={`stage-line ${battery.charging ? 'green' : ''}`}>{battery.charging && <Icon d={PATHS.bolt} size={22} fill />}{battery.charging ? (pct >= 100 ? 'Fully charged' : 'Charging') : 'On battery'}</p>
          </>
        ) : <p className="stage-line">No battery found</p>)}

        {mode === 'claude' && (
          <>
            <p className="stage-kicker"><Brand name="claude" size={22} />Claude Code</p>
            <h1 className="stage-title">{claude.active > 0 ? `Working on ${claude.sessions.filter((s) => s.active).map((s) => s.project).slice(0, 2).join(' and ')}` : 'Idle'}</h1>
            <div className="stage-stats">
              <div><b>{usage ? compact(usage.output) : '…'}</b><span>written today</span></div>
              <div><b>{usage ? compact(usage.input + usage.cacheRead + usage.cacheWrite) : '…'}</b><span>read today</span></div>
              <div><b>{usage ? usage.replies : '…'}</b><span>replies</span></div>
              <div><b>{usage ? usage.sessions : '…'}</b><span>sessions</span></div>
            </div>
          </>
        )}

        {mode === 'timer' && (
          <>
            <p className="stage-kicker">{timer?.endAt ? 'Timer running' : timerLeft > 0 ? 'Timer paused' : 'No timer set'}</p>
            <h1 className="stage-huge orange">{mmss(Math.ceil(timerLeft))}</h1>
            <p className="stage-line">Start, pause and reset from the Timer tool on the island</p>
          </>
        )}
      </main>

      {/* Optional strip of whatever else is going on. */}
      {extras && (
        <div className="stage-extras">
          {mode !== 'clock' && <span>{t.time} {t.ampm}</span>}
          {weather && mode !== 'clock' && <span><Icon d={weatherIcon(weather)} size={15} width={2} />{weather.temp}°</span>}
          {battery && mode !== 'power' && <span className={battery.charging ? 'green' : ''}>{battery.charging && <Icon d={PATHS.bolt} size={12} fill />}{pct}%</span>}
          {hasMedia && mode !== 'music' && <span>{hasBrand(media!.site) && <Brand name={media!.site} size={15} />}{media!.title}</span>}
          {claude.active > 0 && mode !== 'claude' && <span><Brand name="claude" size={15} />Claude working</span>}
          {timer?.endAt && mode !== 'timer' && <span className="orange">{mmss(Math.ceil(timerLeft))}</span>}
        </div>
      )}

      <nav className="stage-bar black">
        {MODES.map((m) => <button key={m.id} className={`pillbtn ${mode === m.id ? 'solid' : ''}`} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
        <span className="draw-rule" />
        <button className={`pillbtn ${extras ? 'solid' : ''}`} aria-pressed={extras} onClick={toggleExtras}>Other info</button>
        <button className="round" aria-label="Leave full screen" onClick={() => window.island?.closeStage()}><Icon d={PATHS.close} size={13} width={2.4} /></button>
      </nav>
    </div>
  );
}
