import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './types';
import type { Lyrics, SystemLoad, Volume } from './types';
import type { City, ClaudeState, Clip, Media, PhoneDevice, PhoneRequest, Settings, Sticky, TimerState, VoiceState, Weather } from './types';
import { DEFAULT_SETTINGS } from './types';
import { PAGES } from './tools';
import { Brand, Icon, PATHS, clock, hasBrand, mmss, setClock24, weatherIcon } from './ui';
import { AiPanel, SettingsPanel, SharePanel, ShelfPanel, TranslatePanel } from './morepanels';
import { AudioPanel, ColourPanel, CutBgPanel, ImagePanel, OcrPanel, PdfPanel, QrPanel, RenamePanel, VideoPanel, ZipPanel } from './filepanels';
import { StickyBoard } from './Stickies';
import { VaultPanel } from './vaultpanel';
import { PhonePanel } from './phonepanel';
import { ClaudePanel, VoicePanel } from './panels';
import { CITIES, CalendarPanel, ClipsPanel, ClocksPanel, ConvertPanel, Panel, SoonPanel, TimerPanel, WeatherPanel, timerLeft } from './panels';

// Sizes in px. Closed is the pill alone; open is the pill plus the boxes or a panel.
const PILL = { w: 440, h: 32 };
const LIVE_W = 224;
const TOOLS_W = 209;
const OPEN_W = LIVE_W + 7 + TOOLS_W;
const BOX_H = 164;
const PANEL_H = 244;
const GAP = 7;
const TOAST_H = 30; // the separate notification pill under the bar
const FLASH_MS = 3500; // how long the pill shows itself when something changes

const ALL_TOOLS = PAGES.flatMap((p) => p.items);
const PER_PAGE = 9;

/** Tools that just open the matching Windows settings page for now. */
const SETTINGS_PAGE: Record<string, string> = {
  wifi: 'ms-settings:network-wifi',
  bt: 'ms-settings:bluetooth',
  night: 'ms-settings:nightlight',
  mixer: 'ms-settings:apps-volume',
  output: 'ms-settings:sound',
  bright: 'ms-settings:display',
};

interface Alert { text: string; tone: 'orange' | 'green' | 'red' | 'blue'; panel?: string; file?: string; sticky: boolean; call?: string; reply?: { device: string; replyId: string } }

function shortCity(c: City): string {
  const words = c.label.split(' ');
  return words.length > 1 ? words.map((w) => w[0]).join('').toUpperCase() : c.label.slice(0, 3).toUpperCase();
}

let soundsOn = true; // Settings can silence the beeps

function beep() {
  if (!soundsOn) return;
  try {
    const ctx = new AudioContext();
    [0, 0.22, 0.44].forEach((at) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.18);
    });
    window.setTimeout(() => ctx.close(), 1200);
  } catch { /* no audio device */ }
}

export function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const forceOpen = params.get('open') === '1' || params.has('panel');

  // Hovering only shows the pill. A click opens the island, and it stays open
  // until a click outside it (or Esc).
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [panel, setPanel] = useState<string | null>(params.get('panel'));
  const open = forceOpen || pinned;

  const [now, setNow] = useState(() => new Date());
  const [media, setMedia] = useState<Media | null>(null);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const changeSettings = (part: Partial<Settings>) => {
    const next = { ...settings, ...part };
    setSettingsState(next);
    window.island?.save('settings', next);
  };
  // Settings that are not plain styling are pushed to where they are used.
  setClock24(settings.clock24);
  soundsOn = settings.sounds;
  const k = [0.9, 1, 1.15, 1.3].includes(settings.scale) ? settings.scale : 1;
  useEffect(() => { document.documentElement.dataset.theme = params.get('theme') ?? settings.theme; }, [settings.theme]);
  const [claude, setClaude] = useState<ClaudeState>({ active: 0, sessions: [] });
  const [awake, setAwake] = useState(false);
  const [battery, setBattery] = useState<{ level: number; charging: boolean } | null>(null);
  const [stickies, setStickies] = useState<Sticky[]>([]);
  const [dock, setDockState] = useState(true);
  const [voice, setVoice] = useState<VoiceState>({ state: 'idle', since: 0 });
  const [spoken, setSpoken] = useState(''); // what dictation has heard so far
  const [phoneRequests, setPhoneRequests] = useState<PhoneRequest[]>([]);
  const [phoneDevices, setPhoneDevices] = useState<PhoneDevice[] | null>(null);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [system, setSystem] = useState<SystemLoad | null>(null);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [panelH, setPanelH] = useState(0);
  const boxesRef = useRef<HTMLDivElement>(null);
  const [cities, setCitiesState] = useState<City[]>([CITIES[0]]);
  const [timer, setTimer] = useState<TimerState>({ total: 300, left: 300, endAt: null });
  const [alert, setAlert] = useState<Alert | null>(null);
  // Everything announced is also kept, newest first, for the bell's list.
  const [notices, setNotices] = useState<(Alert & { id: number; at: number })[]>([]);
  const [unread, setUnread] = useState(0);
  const notify = (a: Alert) => {
    setAlert(a);
    setNotices((n) => [{ ...a, id: Date.now() + Math.random(), at: Date.now() }, ...n].slice(0, 30));
    setUnread((u) => u + 1);
  };
  const [page, setPage] = useState(0);
  const [dir, setDir] = useState<'down' | 'up'>('down');
  const closeTimer = useRef<number | null>(null);
  const toastAlone = useRef(false); // a notification is showing with the bar tucked away
  const wheelLock = useRef(0);
  const liveLock = useRef(0);
  const [liveIdx, setLiveIdx] = useState(0);
  const [volume, setVolume] = useState<Volume>({ level: -1, muted: false });
  const [lyrics, setLyrics] = useState<Lyrics>({ key: '', lines: [] });
  const [liveDir, setLiveDir] = useState<'down' | 'up'>('down');

  const setCities = (c: City[]) => { setCitiesState(c); window.island?.save('cities', c); };
  const saveStickies = (s: Sticky[]) => { setStickies(s); window.island?.save('stickies', s); };
  const setDock = (on: boolean) => { setDockState(on); window.island?.setStickyDock(on); };

  useEffect(() => {
    const api = window.island;
    api?.load('settings').then((v) => { if (v && typeof v === 'object') setSettingsState({ ...DEFAULT_SETTINGS, ...(v as Partial<Settings>) }); }).catch(() => {});
    // Notifications from other Windows apps.
    api?.onWinNote((n) => notify({ text: [n.app, n.title, n.text].filter(Boolean).join(' · '), tone: 'blue', sticky: false }));
    api?.state().then((s) => { setMedia(s.media); setWeather(s.weather); setClips(s.clips); setClaude(s.claude); setAwake(s.awake); setVoice(s.voice); setVolume(s.volume); setLyrics(s.lyrics); setRecStart(s.recording.on ? s.recording.since : null); }).catch(() => {});
    api?.onRecording((r) => setRecStart(r.on ? r.since : null));
    api?.onRecordingDone((r) => notify(r.ok ? { text: 'Recording saved', tone: 'green', file: r.file, sticky: false } : { text: 'Recording failed', tone: 'red', sticky: false }));
    api?.onSystem(setSystem);
    api?.onVoice(setVoice);
    api?.onVoicePartial(setSpoken);
    // From the phone: its notifications, calls, and requests to pair.
    api?.companion.onNote((n) => notify({ text: [n.app, n.title, n.text].filter(Boolean).join(' · '), tone: 'blue', sticky: false, reply: n.replyId ? { device: n.deviceId, replyId: n.replyId } : undefined }));
    api?.companion.onPair((p) => { notify({ text: `${p.name} wants to pair`, tone: 'orange', panel: 'phone', sticky: true }); beep(); });
    api?.companion.onCall((c) => {
      const who = c.name || c.number || 'Unknown caller';
      if (c.event === 'ringing') { notify({ text: `Call from ${who}`, tone: 'red', panel: 'phone', sticky: true, call: c.device }); beep(); }
      else if (c.event === 'missedCall') notify({ text: `Missed call from ${who}`, tone: 'red', sticky: false });
      else setAlert((a) => (a && a.call ? null : a)); // answered or ended: take the ringing pill away
    });
    api?.onCapture((r) => notify(r.ok ? { text: 'Screenshot saved and copied', tone: 'green', file: r.file, sticky: false } : { text: 'Screenshot failed', tone: 'red', sticky: false }));
    api?.onVolume(setVolume);
    api?.onLyrics(setLyrics);
    // Phone link: someone asking to send, and things arriving.
    api?.phone.onDevices(setPhoneDevices);
    api?.phone.onRequests((r) => {
      setPhoneRequests(r);
      if (r.length) { notify({ text: `${r[0].alias} wants to send ${r[0].count} ${r[0].count === 1 ? 'item' : 'items'}`, tone: 'orange', panel: 'phone', sticky: true }); beep(); }
      else setAlert((a) => (a && a.panel === 'phone' && a.sticky ? null : a));
    });
    api?.phone.onEvent((e) => notify(e.kind === 'text'
      ? { text: `Copied text from ${e.from}`, tone: 'green', sticky: false }
      : { text: `${e.files.length} ${e.files.length === 1 ? 'file' : 'files'} from ${e.from}`, tone: 'green', file: e.files[e.files.length - 1], sticky: false }));
    // Dictation finished (from the shortcut or the panel): say what happened in the bar.
    api?.onVoiceResult((r) => notify(r.ok
      ? { text: (r.typed ? 'Typed: ' : 'Copied: ') + (r.text ?? ''), tone: 'green', sticky: false }
      : { text: r.message ?? 'Dictation failed', tone: 'red', sticky: false }));
    api?.load('stickies').then((v) => { if (Array.isArray(v)) setStickies(v as Sticky[]); }).catch(() => {});
    api?.onStoreChanged((c) => {
      if (c.key === 'stickies' && Array.isArray(c.value)) setStickies(c.value as Sticky[]);
      if (c.key === 'stickyDock') setDockState(c.value !== false); // changed from the tray menu
    });
    api?.load('stickyDock').then((v) => { if (v === false) setDockState(false); }).catch(() => {});
    api?.load('cities').then((v) => { if (Array.isArray(v)) setCitiesState(v as City[]); }).catch(() => {});
    api?.onMedia(setMedia);
    api?.onWeather(setWeather);
    api?.onClips(setClips);
    api?.onClaude(setClaude);
  }, []);

  // Laptop battery.
  useEffect(() => {
    let b: any = null;
    const read = () => { if (b) setBattery({ level: b.level, charging: b.charging }); };
    (navigator as any).getBattery?.().then((got: any) => {
      b = got; read();
      b.addEventListener('levelchange', read);
      b.addEventListener('chargingchange', read);
    }).catch(() => {});
    return () => { if (b) { b.removeEventListener('levelchange', read); b.removeEventListener('chargingchange', read); } };
  }, []);

  // The app watches the real pointer and tells us when it enters or leaves.
  useEffect(() => {
    window.island?.onHover((inside) => {
      if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
      // Pointing at a notification that arrived on its own must not drag the bar down with it.
      if (inside) { if (!toastAlone.current) setHovered(true); }
      else closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setHovered(false); }, 140);
    });
    // Clicking anywhere outside the island takes focus away, which closes it.
    window.island?.onBlur(() => { setPinned(false); setPanel(null); });
  }, []);

  // Esc steps back: out of a panel first, then closes the island.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (panel) setPanel(null); else setPinned(false);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [panel]);

  // Reminders and the timer both raise an alert in the pill when they come due.
  useEffect(() => {
    const t = now.getTime();
    // Reminders live on the sticky notes' task lists.
    const due = stickies.flatMap((s) => s.tasks).find((k) => !k.done && !k.notified && k.due !== undefined && k.due <= t);
    if (due) {
      const next = stickies.map((s) => ({ ...s, tasks: s.tasks.map((k) => (k.id === due.id ? { ...k, notified: true } : k)) }));
      setStickies(next);
      window.island?.save('stickies', next);
      notify({ text: due.text, tone: 'orange', panel: 'notes', sticky: true });
      beep();
    }
    if (timer.endAt !== null && t >= timer.endAt) {
      setTimer({ ...timer, left: 0, endAt: null });
      notify({ text: 'Timer done', tone: 'orange', panel: 'timer', sticky: true });
      beep();
    }
  }, [now]);

  // The full-screen timer view reads the timer from saved data.
  useEffect(() => { window.island?.save('timer', timer); }, [timer]);

  // A passing alert (like "Screenshot saved") clears itself.
  useEffect(() => {
    // It waits while you are typing a reply, and phone messages stay a little longer so you can.
    if (!alert || alert.sticky || replying) return;
    const id = window.setTimeout(() => setAlert(null), alert.reply ? 9000 : 4500);
    return () => window.clearTimeout(id);
  }, [alert, replying]);
  useEffect(() => { setReplying(false); setReplyText(''); }, [alert?.text]);
  const sendReply = async () => {
    if (!alert?.reply || !replyText.trim()) return;
    const ok = await window.island?.companion.reply(alert.reply.device, alert.reply.replyId, replyText.trim());
    notify(ok ? { text: 'Reply sent', tone: 'green', sticky: false } : { text: 'Could not send the reply', tone: 'red', sticky: false });
  };

  // The island stays out of sight until the pointer reaches the top edge. It also
  // drops down by itself for a moment when something changes.
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const firstFlash = useRef(true);
  const flashKey = `${media?.title ?? ''}|${media?.playing ? 1 : 0}|${battery?.charging ? 1 : 0}|${claude.active > 0 ? 1 : 0}`;
  useEffect(() => {
    if (firstFlash.current) { firstFlash.current = false; return; }
    if (!settings.peek) return;
    setFlash(true);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => { flashTimer.current = null; setFlash(false); }, FLASH_MS);
  }, [flashKey]);
  // A notification does not bring the bar down: it shows as its own pill, alone, at the top.
  const visible = open || hovered || flash || recStart !== null || voice.state !== 'idle';
  toastAlone.current = !!alert && !visible;

  // The clock only needs to tick every second while someone can see it (or a timer is
  // counting). Tucked away, a slow tick is enough to catch reminders, and saves the laptop work.
  const ticking = visible || !!alert || timer.endAt !== null;
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), ticking ? 1000 : 15000);
    return () => window.clearInterval(id);
  }, [ticking]);
  useEffect(() => { window.island?.presence({ open, visible }); }, [open, visible]);

  // Once a page has been flipped, tools stop popping in one by one (that is only for opening).
  const [flipped, setFlipped] = useState(false);
  useEffect(() => { if (!open) setFlipped(false); }, [open]);

  // Tell the app which area reacts to the pointer: the whole island when open,
  // the pill while it is showing, and otherwise just a thin strip on the top edge.
  // A panel is only as tall as its contents, up to a limit, so a three-button tool stays small.
  const bodyH = panel ? (panelH || PANEL_H) : BOX_H;
  useLayoutEffect(() => {
    const el = boxesRef.current;
    if (!el) return;
    const measure = () => setPanelH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panel]);
  const toastH = alert ? TOAST_H + GAP : 0;
  // Opening the list counts as having seen everything.
  useEffect(() => { if (panel === 'notify') setUnread(0); }, [panel, notices.length]);
  useEffect(() => {
    // Sizes below are in the island's own units; k turns them into real screen points.
    const cx = window.innerWidth / 2;
    const zone = (w: number, h: number, pad = 0) => window.island?.zone({ x: cx - (w * k) / 2 - pad, y: 0, w: w * k + pad * 2, h: h * k });
    if (open) zone(OPEN_W, PILL.h + toastH + GAP + bodyH + 6, 6);
    else if (visible) zone(PILL.w, PILL.h + toastH);
    else if (alert) zone(OPEN_W, TOAST_H);
    else window.island?.zone({ x: cx - (PILL.w * k) / 2, y: 0, w: PILL.w * k, h: 3 });
    window.island?.log(`open=${open} visible=${visible} panel=${panel}`);
  }, [open, visible, bodyH, panel, toastH, k]);

  const local = clock(now);
  const secondCity = cities[0];
  const dateText = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  // The closed bar uses a shorter date, so its middle stays empty: clicking there just opens the island.
  const shortDate = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(now) + ' ' + now.getDate();
  const hasMedia = !!media && !!media.title;
  const progress = hasMedia && media!.dur > 0 ? Math.min(media!.pos / media!.dur, 1) : 0;
  const remaining = hasMedia ? Math.max(media!.dur - media!.pos, 0) : 0;
  const timerRunning = timer.endAt !== null;

  const shownTools = ALL_TOOLS.filter((t) => t.id === 'settings' || !settings.hidden.includes(t.id));
  const pageCount = Math.ceil(shownTools.length / PER_PAGE);
  const curPage = Math.min(page, pageCount - 1);
  const tiles = shownTools.slice(curPage * PER_PAGE, curPage * PER_PAGE + PER_PAGE);

  const go = (next: number) => {
    const clamped = Math.min(pageCount - 1, Math.max(0, next));
    if (clamped === curPage) return;
    setFlipped(true);
    setDir(clamped > curPage ? 'down' : 'up');
    setPage(clamped);
  };
  const onWheel = (e: React.WheelEvent) => {
    const t = Date.now();
    if (t < wheelLock.current || Math.abs(e.deltaY) < 4) return;
    wheelLock.current = t + 170;
    go(curPage + (e.deltaY > 0 ? 1 : -1));
  };

  const openPanel = (p: string) => { setPinned(true); setPanel(p); };

  // Screen recording runs outside this window; the island only starts and stops it.
  const stopRecording = () => { window.island?.toggleRecording(); };

  const runTool = async (id: string, label: string) => {
    const api = window.island;
    if (id === 'capture') { setPanel('capture'); return; }
    // Notes open on the screen edge if that is switched on, otherwise right here.
    if (id === 'notes') { if (dock) api?.showStickies(); else setPanel('notes'); return; }
    if (id === 'shrink') { setPanel('image'); return; }
    if (id === 'voice' || id === 'vault' || id === 'phone') { setPanel(id); return; }
    if (['pdf', 'image', 'video', 'audio', 'cutbg', 'zip', 'rename', 'ocr', 'qr', 'colour'].includes(id)) { setPanel(id); return; }
    if (id === 'draw') { api?.openDraw(); setPinned(false); return; }
    if (id === 'record') {
      api?.toggleRecording().then((r) => { if (r && !r.ok) notify({ text: r.message ?? 'Could not start recording', tone: 'red', sticky: false }); });
      setPinned(false);
      return;
    }
    if (id === 'awake') { api?.toggleAwake().then(setAwake); return; }
    if (id === 'lock') { api?.lock(); return; }
    if (id === 'wifi' || id === 'bt') {
      // Switch it for real; if Windows will not allow that, fall back to its settings page.
      const r = await api?.radio(id === 'wifi' ? 'wifi' : 'bluetooth', 'toggle');
      if (r?.ok) notify({ text: label + ' is now ' + (r.on ? 'on' : 'off'), tone: 'blue', sticky: false });
      else api?.openSettings(SETTINGS_PAGE[id]);
      return;
    }
    if (id === 'night') {
      const r = await api?.night('toggle');
      if (r?.ok) notify({ text: 'Night light is now ' + (r.on ? 'on' : 'off'), tone: 'blue', sticky: false });
      else api?.openSettings(SETTINGS_PAGE[id]);
      return;
    }
    if (['shelf', 'translate', 'ai', 'share'].includes(id)) { setPanel(id); return; }
    if (SETTINGS_PAGE[id]) { api?.openSettings(SETTINGS_PAGE[id]); return; }
    if (['clips', 'timer', 'convert', 'clocks', 'calendar', 'settings'].includes(id)) { setPanel(id); return; }
    setPanel('soon:' + label);
  };

  // What tapping a notification does: show the file, or open the thing it is about.
  const actOn = (a: Alert) => {
    if (a.file) window.island?.reveal(a.file);
    else if (a.panel === 'notes') { if (dock) window.island?.showStickies(); else openPanel('notes'); }
    else if (a.panel) openPanel(a.panel);
    setAlert(null);
  };

  // Left side of the pill: the most important thing happening right now.
  let status: ReactNode = null;
  let statusClick: (() => void) | undefined;
  if (voice.state !== 'idle') {
    status = voice.state === 'listening'
      ? <span className="st st-red"><span className="rec-dot" /><b className="st-tail">{spoken ? spoken.slice(-34) : `Listening ${mmss((now.getTime() - voice.since) / 1000)}`}</b></span>
      : <span className="st st-orange"><Icon d={PATHS.spark} size={13} width={2.1} /><b>Writing it out…</b></span>;
    statusClick = () => openPanel('voice');
  } else if (recStart !== null) {
    status = <span className="st st-red"><span className="rec-dot" /><b>Recording {mmss((now.getTime() - recStart) / 1000)} · tap to stop</b></span>;
    statusClick = stopRecording;
  } else if (timerRunning) {
    status = <span className="st st-orange"><Icon d={PATHS.timer} size={13} width={2.1} /><b>{mmss(Math.ceil(timerLeft(timer, now.getTime())))}</b></span>;
    statusClick = () => openPanel('timer');
  } else if (hasMedia) {
    status = (
      <span className="st">
        <span className="pill-art" style={media!.art ? { backgroundImage: `url(${media!.art})` } : undefined} aria-hidden="true">
          {hasBrand(media!.site) && <span className="pill-badge"><Brand name={media!.site} size={10} /></span>}
        </span>
        <b>{media!.title}</b>
        <span className={`eq ${media!.playing ? 'eq-on' : ''}`} aria-hidden="true"><i /><i /><i /><i /><i /></span>
      </span>
    );
    statusClick = () => { setPinned(true); setPanel(null); setLiveIdx(0); };
  } else if (claude.active > 0) {
    const busy = claude.sessions.filter((s) => s.active);
    status = <span className="st st-claude"><Brand name="claude" size={15} /><b>Claude · {busy[0]?.project ?? 'working'}{busy.length > 1 ? ` +${busy.length - 1}` : ''}</b></span>;
    statusClick = () => openPanel('claude');
  } else if (battery?.charging) {
    status = <span className="st st-green"><Icon d={PATHS.bolt} size={12} fill /><b>Charging {Math.round(battery.level * 100)}%</b></span>;
  } else if (battery && battery.level <= 0.2) {
    status = <span className="st st-red"><Icon d={PATHS.battery} size={14} width={2} /><b>Low battery {Math.round(battery.level * 100)}%</b></span>;
  }

  // Everything else that is going on sits beside it as small badges, so one
  // thing (say Claude working) never hides another (say charging).
  const main = voice.state !== 'idle' ? 'voice' : recStart !== null ? 'rec' : timerRunning ? 'timer' : hasMedia ? 'media' : claude.active > 0 ? 'claude' : battery?.charging ? 'power' : battery && battery.level <= 0.2 ? 'power' : '';
  const badges: ReactNode[] = [];
  if (main !== 'timer' && timerRunning) {
    badges.push(<button key="timer" className="seg seg-mini st-orange" aria-label="Timer" onClick={() => openPanel('timer')}><Icon d={PATHS.timer} size={12} width={2.2} />{mmss(Math.ceil(timerLeft(timer, now.getTime())))}</button>);
  }
  if (main !== 'claude' && claude.active > 0) {
    badges.push(<button key="claude" className="seg seg-mini st-claude" aria-label="Claude is working" onClick={() => openPanel('claude')}><Brand name="claude" size={13} />{claude.active > 1 ? claude.active : null}</button>);
  }
  if (main !== 'power' && battery) {
    const low = battery.level <= 0.2 && !battery.charging;
    badges.push(<span key="power" className={`seg seg-mini ${battery.charging ? 'st-green' : low ? 'st-red' : 'seg-soft'}`} aria-label={battery.charging ? 'Charging' : 'Battery'}>{battery.charging ? <Icon d={PATHS.bolt} size={10} fill /> : <Icon d={PATHS.battery} size={13} width={2} />}{Math.round(battery.level * 100)}%</span>);
  }

  const art = hasMedia && media!.art ? { backgroundImage: `url(${media!.art})` } : undefined;

  // The lyric line being sung right now, if this song has synced lyrics.
  const lyricNow = hasMedia ? ([...lyrics.lines].reverse().find((l) => l.t <= media!.pos + 0.4)?.text ?? '') : '';

  // The first box shows one live thing at a time; scrolling flips between them.
  const cards = [hasMedia ? 'music' : '', claude.active > 0 ? 'claude' : '', 'power', system ? 'system' : ''].filter(Boolean);
  const liveAt = Math.min(liveIdx, cards.length - 1);
  const card = cards[liveAt];
  const goLive = (next: number) => {
    const clamped = Math.min(cards.length - 1, Math.max(0, next));
    if (clamped === liveAt) return;
    setLiveDir(clamped > liveAt ? 'down' : 'up');
    setLiveIdx(clamped);
  };
  const onLiveWheel = (e: React.WheelEvent) => {
    const t = Date.now();
    if (t < liveLock.current || Math.abs(e.deltaY) < 4) return;
    liveLock.current = t + 220;
    goLive(liveAt + (e.deltaY > 0 ? 1 : -1));
  };
  const sizeVars = {
    '--pill-w': `${PILL.w}px`, '--pill-h': `${PILL.h}px`,
    '--open-w': `${OPEN_W}px`,
    '--live-w': `${LIVE_W}px`,
    '--box-h': panel ? 'auto' : `${BOX_H}px`, '--gap': `${GAP}px`,
    zoom: k,
  } as CSSProperties;

  const closePanel = () => setPanel(null);
  let panelView: ReactNode = null;
  if (panel === 'clocks') panelView = <ClocksPanel now={now} cities={cities} setCities={setCities} onClose={closePanel} />;
  else if (panel === 'phone') panelView = <PhonePanel requests={phoneRequests} devices={phoneDevices} onClose={closePanel} />;
  else if (panel === 'vault') panelView = <VaultPanel onClose={closePanel} />;
  else if (panel === 'voice') panelView = <VoicePanel now={now} voice={voice} spoken={spoken} onClose={closePanel} />;
  else if (panel === 'claude') panelView = <ClaudePanel now={now} claude={claude} onClose={closePanel} />;
  else if (panel === 'weather') panelView = <WeatherPanel weather={weather} onClose={closePanel} />;
  else if (panel === 'calendar') panelView = <CalendarPanel now={now} onClose={closePanel} />;
  else if (panel === 'timer') panelView = <TimerPanel now={now} timer={timer} setTimer={setTimer} onClose={closePanel} />;
  else if (panel === 'convert') panelView = <ConvertPanel onClose={closePanel} />;
  else if (panel === 'clips') panelView = <ClipsPanel clips={clips} onClose={closePanel} />;
  else if (panel === 'settings') panelView = <SettingsPanel settings={settings} change={changeSettings} dock={dock} setDock={setDock} onClose={closePanel} />;
  else if (panel === 'shelf') panelView = <ShelfPanel onClose={closePanel} openShare={() => setPanel('share')} />;
  else if (panel === 'share') panelView = <SharePanel onClose={closePanel} />;
  else if (panel === 'translate') panelView = <TranslatePanel onClose={closePanel} />;
  else if (panel === 'ai') panelView = <AiPanel onClose={closePanel} />;
  else if (panel === 'notes') panelView = <Panel title="Notes" onClose={closePanel}><div className="s-inline"><StickyBoard stickies={stickies} save={saveStickies} /></div></Panel>;
  else if (panel === 'pdf') panelView = <PdfPanel onClose={closePanel} />;
  else if (panel === 'image') panelView = <ImagePanel onClose={closePanel} />;
  else if (panel === 'zip') panelView = <ZipPanel onClose={closePanel} />;
  else if (panel === 'video') panelView = <VideoPanel onClose={closePanel} />;
  else if (panel === 'audio') panelView = <AudioPanel onClose={closePanel} />;
  else if (panel === 'cutbg') panelView = <CutBgPanel onClose={closePanel} />;
  else if (panel === 'rename') panelView = <RenamePanel onClose={closePanel} />;
  else if (panel === 'ocr') panelView = <OcrPanel onClose={closePanel} />;
  else if (panel === 'qr') panelView = <QrPanel onClose={closePanel} />;
  else if (panel === 'colour') panelView = <ColourPanel onClose={closePanel} />;
  else if (panel === 'notify') panelView = (
    <Panel title="Notifications" onClose={closePanel} action={notices.length > 0 && <button className="pillbtn" onClick={() => setNotices([])}>Clear</button>}>
      {notices.length === 0 && <p className="empty">Nothing yet. Reminders, timers, phone transfers, screenshots and dictation all show up here.</p>}
      <ul className="rows">
        {notices.map((n) => (
          <li key={n.id} className="row-wrap">
            {n.reply && <button className="pillbtn" onClick={() => { setAlert({ ...n, sticky: true }); setReplying(true); }}>Reply</button>}
            <button className="row row-button" onClick={() => actOn(n)}>
              <span className={`tone tone-${n.tone}`} />
              <span className="row-main">{n.text}</span>
              <span className="row-sub">{new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(n.at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
  else if (panel === 'capture') panelView = (
    <Panel title="Capture" onClose={closePanel}>
      <div className="actions">
        <button className="pillbtn solid" onClick={() => { setPinned(false); setPanel(null); window.island?.capture(); }}>Whole screen</button>
        <button className="pillbtn" onClick={() => { setPinned(false); setPanel(null); window.island?.snip(); }}>Select an area</button>
        <button className="pillbtn" onClick={() => { setPinned(false); setPanel(null); window.island?.openDraw(); }}>Draw, then capture</button>
      </div>
      <p className="hint">Saved to Downloads\Island\Screenshots and copied.</p>
    </Panel>
  );
  else if (panel?.startsWith('soon:')) panelView = <SoonPanel name={panel.slice(5)} onClose={closePanel} />;

  return (
    <div className="anchor" style={sizeVars}>
      {/* Files dragged onto any part of the island land on the shelf. */}
      <div className={`stack ${open ? 'stack-open' : visible ? 'stack-closed' : 'stack-hidden'}`} onClick={() => setPinned(true)}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; } }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); window.island?.shelf.addDropped(e.dataTransfer.files).then(() => openPanel('shelf')); }}>

        {/* One pill, always: status on the left, then date, weather and time. Each part opens its own panel. */}
        <div className="pill black">
          {status && (statusClick
            ? <button className="seg seg-status" onClick={(e) => { e.stopPropagation(); statusClick!(); }}>{status}</button>
            : <span className="seg seg-status">{status}</span>)}
          {badges.slice(0, 2)}
          {/* The middle of the bar is left empty on purpose: a click here just opens the island. */}
          <span className="spacer" />
          <button className="seg seg-date" onClick={() => openPanel('calendar')}>{open ? dateText : shortDate}</button>
          {weather && (
            <button className="seg seg-soft" onClick={() => openPanel('weather')}><Icon d={weatherIcon(weather)} size={13} width={2} />{weather.temp}°</button>
          )}
          {open && secondCity && !status && (
            <button className="seg seg-dim" onClick={() => openPanel('clocks')}>{shortCity(secondCity)} {clock(now, secondCity.tz).time}</button>
          )}
          <button className="seg seg-time" onClick={() => openPanel('clocks')}>{local.time}<small>{local.ampm}</small></button>
          {open && (
            <button className="seg seg-icon" aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'} onClick={() => openPanel('notify')}><Icon d={PATHS.bell} size={14} width={2} />{unread > 0 && <i className="unread" />}</button>
          )}
        </div>

        {/* A notification gets its own pill, under the bar on the left. The bell on it opens the full list. */}
        {alert && (
          <div className="toast black" key={alert.text} role="status">
            {replying && alert.reply && (
              <form className="toast-reply" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); sendReply(); }}>
                <input autoFocus placeholder="Type a reply" aria-label="Reply" value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setReplying(false); } }} />
                <button className="toast-act" type="submit" disabled={!replyText.trim()}>Send</button>
              </form>
            )}
            <button className="toast-body" style={replying && alert.reply ? { display: 'none' } : undefined} onClick={(e) => { e.stopPropagation(); actOn(alert); }}>
              <span className={`toast-icon st-${alert.tone}`}><Icon d={alert.file ? PATHS.shot : alert.panel === 'timer' ? PATHS.timer : alert.panel === 'phone' || alert.tone === 'blue' ? 'M7 3h10v18H7zM11 18h2' : PATHS.note} size={13} width={2.1} /></span>
              <span className="toast-text">{alert.text}</span>
            </button>
            {alert.reply && !replying && <button className="toast-act" onClick={(e) => { e.stopPropagation(); setReplying(true); }}>Reply</button>}
            {alert.call && <button className="toast-act" onClick={(e) => { e.stopPropagation(); window.island?.companion.mute(alert.call!); setAlert(null); }}>Silence</button>}
            <button className="toast-bell" aria-label={`All notifications, ${unread} new`} onClick={(e) => { e.stopPropagation(); setAlert(null); openPanel('notify'); }}>
              <Icon d={PATHS.bell} size={13} width={2.1} />{unread > 1 && <b>{unread}</b>}
            </button>
          </div>
        )}

        {/* Below the pill: either one panel, or the two boxes. The desktop shows through the gaps. */}
        <div className="boxes" ref={boxesRef} aria-hidden={!open}>
          {panelView ?? (
            <>
              {/* First box: whatever is live. With more than one thing going on, scroll to flip between them. */}
              <section className="box black live-box" onWheel={onLiveWheel}>
                <div className={`live-card live-${liveDir}`} key={card}>
                  {card === 'music' && (
                    <div className="live">
                      <div className="track">
                        <span className="track-art" style={art} aria-hidden="true">
                          {hasBrand(media!.site) && <span className="track-badge"><Brand name={media!.site} size={15} /></span>}
                        </span>
                        <div className="track-text">
                          <span className="track-title">{media!.title}</span>
                          <span className="track-artist">{media!.artist || ' '}</span>
                        </div>
                        {media!.site === 'spotify' && (
                          <button className="round" aria-label="Open Spotify" onClick={() => window.island?.openSource()}><Icon d="M14 5h5v5M19 5l-8 8M11 6H5v13h13v-6" size={13} width={2.2} /></button>
                        )}
                      </div>
                      <span className={`lyric ${lyricNow ? '' : 'lyric-none'}`}>{lyricNow || (lyrics.lines.length ? '♪' : 'No synced lyrics for this one')}</span>
                      <div className="seek">
                        <button className="seek-bar" aria-label="Seek" disabled={!(media!.dur > 0)}
                          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); window.island?.seek(((e.clientX - r.left) / r.width) * media!.dur); }}>
                          <i style={{ width: `${progress * 100}%` }} />
                        </button>
                        <div className="seek-times"><span>{mmss(media!.pos)}</span><span>-{mmss(remaining)}</span></div>
                      </div>
                      <div className="transport">
                        <button aria-label="Previous" onClick={() => window.island?.media('prev')}><Icon d={PATHS.prev} size={17} fill /></button>
                        <button aria-label={media!.playing ? 'Pause' : 'Play'} onClick={() => window.island?.media('toggle')}>
                          <Icon d={media!.playing ? PATHS.pause : PATHS.play} size={22} fill />
                        </button>
                        <button aria-label="Next" onClick={() => window.island?.media('next')}><Icon d={PATHS.next} size={17} fill /></button>
                        {volume.level >= 0 && (
                          <div className="vol">
                            <button aria-label={volume.muted ? 'Unmute' : 'Mute'} onClick={() => window.island?.toggleMute()}>
                              <Icon d={volume.muted ? 'M4 10v4h3l5 4V6L7 10zM16 9l5 6M21 9l-5 6' : 'M4 10v4h3l5 4V6L7 10zM16 9a4 4 0 010 6'} size={14} width={2} />
                            </button>
                            <input type="range" min="0" max="100" aria-label="Volume" value={Math.round(volume.level * 100)}
                              onChange={(e) => { const v = Number(e.target.value) / 100; setVolume({ ...volume, level: v }); window.island?.setVolume(v); }} />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {card === 'claude' && (
                    <button className="live claude-box" onClick={() => setPanel('claude')}>
                      <span className="claude-mark"><Brand name="claude" size={26} /></span>
                      <span className="claude-title">Claude is working</span>
                      <span className="claude-list">
                        {claude.sessions.filter((s) => s.active).slice(0, 3).map((s, i) => <span key={i}><i className="live-dot live-on" />{s.project}</span>)}
                      </span>
                      <span className="row-sub">Tap for today's usage</span>
                    </button>
                  )}
                  {card === 'system' && system && (
                    <div className="live sys">
                      <span className="sys-title">This laptop</span>
                      <div className="meter"><div><span>Processor</span><b>{Math.round(system.cpu * 100)}%</b></div><i><u style={{ width: `${system.cpu * 100}%` }} /></i></div>
                      <div className="meter"><div><span>Memory</span><b>{Math.round(system.mem * 100)}%</b></div><i><u className={system.mem > 0.85 ? 'hot' : ''} style={{ width: `${system.mem * 100}%` }} /></i></div>
                      <span className="row-sub">{(system.mem * system.memGb).toFixed(1)} of {system.memGb.toFixed(0)} GB in use</span>
                    </div>
                  )}
                  {card === 'power' && (
                    <div className="live power">
                      {battery ? (
                        <>
                          <div className="ring">
                            <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
                              <circle cx="46" cy="46" r="39" fill="none" stroke="var(--track)" strokeWidth="7" />
                              <circle cx="46" cy="46" r="39" fill="none" strokeWidth="7" strokeLinecap="round"
                                stroke={battery.level <= 0.2 && !battery.charging ? 'var(--red)' : 'var(--green)'}
                                strokeDasharray={`${Math.max(battery.level, 0.01) * 245} 245`} transform="rotate(-90 46 46)" />
                            </svg>
                            <span className="ring-text">{Math.round(battery.level * 100)}<small>%</small></span>
                          </div>
                          <span className={`power-label ${battery.charging ? 'power-on' : ''}`}>
                            {battery.charging && <Icon d={PATHS.bolt} size={12} fill />}
                            {battery.charging ? 'Charging' : 'On battery'}
                          </span>
                        </>
                      ) : (
                        <span className="power-label">All quiet</span>
                      )}
                    </div>
                  )}
                </div>
                <button className="expand" aria-label="Show this full screen" onClick={(e) => { e.stopPropagation(); window.island?.openStage(card); }}><Icon d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" size={12} width={2.2} /></button>
                {cards.length > 1 && (
                  <div className="dots" aria-label={`Showing ${liveAt + 1} of ${cards.length}`}>
                    {cards.map((name, i) => (
                      <button key={name} className={`dot ${i === liveAt ? 'dot-on' : ''}`} aria-label={name === 'music' ? 'Music' : name === 'claude' ? 'Claude' : name === 'system' ? 'Laptop load' : 'Battery'} onClick={() => goLive(i)} />
                    ))}
                  </div>
                )}
              </section>
              <section className="box black tools" onWheel={onWheel}>
                <div className={`grid grid-${dir} ${flipped ? '' : 'grid-pop'}`} key={curPage}>
                  {tiles.map((it, i) => (
                    <button key={it.id} className={`tile ${it.tone ? 'tile-' + it.tone : ''} ${(it.id === 'awake' && awake) || (it.id === 'record' && recStart !== null) ? 'tile-on' : ''}`} style={{ '--i': i } as CSSProperties} onClick={() => runTool(it.id, it.label)}>
                      <span className="tile-icon"><Icon d={it.d} size={16} width={2.1} /></span>
                      <span className="tile-label">{it.label}</span>
                    </button>
                  ))}
                </div>
                <div className="dots" aria-label={`Page ${curPage + 1} of ${pageCount}`}>
                  {Array.from({ length: pageCount }, (_, i) => (
                    <button key={i} className={`dot ${i === curPage ? 'dot-on' : ''}`} aria-label={`Page ${i + 1}`} onClick={() => go(i)} />
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
