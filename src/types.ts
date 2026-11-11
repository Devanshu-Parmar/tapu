export interface Media {
  title: string;
  artist: string;
  app: string;
  /** Where it is playing: 'spotify', 'youtube', 'web' for another site in a browser, or '' for some other app. */
  site: string;
  playing: boolean;
  pos: number;
  dur: number;
  art: string | null;
}

export interface Volume { level: number; muted: boolean }
/** cpu and mem are fractions from 0 to 1. */
export interface SystemLoad { cpu: number; mem: number; memGb: number }
export interface Lyrics { key: string; lines: { t: number; text: string }[] }

export interface WeatherDay { date: string; code: number; max: number; min: number }

export interface Weather {
  city: string;
  temp: number;
  feels: number;
  humidity: number;
  wind: number;
  /** WMO weather code as reported by Open-Meteo. */
  code: number;
  day: boolean;
  days: WeatherDay[];
  /** 'C' or 'F'. */
  unit?: string;
}

/** One line of a sticky's checklist. */
export interface Task {
  id: string;
  text: string;
  done: boolean;
  /** When to remind, as a timestamp in ms. Optional: most tasks have none. */
  due?: number;
  /** True once the island has shown the reminder. */
  notified?: boolean;
}

export type StickyColor = 'yellow' | 'pink' | 'blue' | 'green';
export type StickyTab = 'text' | 'tasks' | 'draw';

/** A sticky note: free text, a checklist and a scribble, on one coloured card. */
export interface Sticky {
  id: string;
  color: StickyColor;
  tab: StickyTab;
  text: string;
  tasks: Task[];
  /** The scribble, as a PNG data URL. */
  drawing?: string;
}

export interface City { label: string; tz: string }

/** A device found on the Wi-Fi that speaks LocalSend. */
export interface PhoneDevice { fingerprint: string; alias: string; ip: string; port: number; protocol: string; type: string; seen: number }
/** A transfer another device is asking permission for. */
export interface PhoneRequest { id: string; alias: string; fingerprint: string; count: number; size: number; names: string[] }
export interface PhoneInfo { ok: boolean; error: string; alias: string; devices: PhoneDevice[]; requests: PhoneRequest[]; trusted: string[]; received: { file: string; from: string; at: number }[] }
export type PhoneEvent = { kind: 'text'; from: string; text: string } | { kind: 'files'; from: string; files: string[] };
export interface PhoneApi {
  info(): Promise<PhoneInfo>;
  scan(): Promise<PhoneDevice[]>;
  openFolder(): void;
  answer(id: string, accept: boolean, always: boolean): void;
  sendFiles(fingerprint: string): Promise<ToolResult>;
  sendText(fingerprint: string): Promise<ToolResult>;
  onDevices(cb: (d: PhoneDevice[]) => void): void;
  onRequests(cb: (r: PhoneRequest[]) => void): void;
  onEvent(cb: (e: PhoneEvent) => void): void;
}

/** A phone connected through the companion (KDE Connect) link. */
export interface Companion { id: string; name: string; type: string; paired: boolean; pending: '' | 'in' | 'out'; battery: number; charging: boolean }
export interface CompanionApi {
  info(): Promise<{ ok: boolean; error: string; devices: Companion[]; clipboard: boolean }>;
  find(): void;
  pair(id: string): void;
  answer(id: string, accept: boolean): void;
  unpair(id: string): void;
  ring(id: string): void;
  mute(id: string): void;
  setClipboard(on: boolean): void;
  onDevices(cb: (d: Companion[]) => void): void;
  onPair(cb: (p: { id: string; name: string }) => void): void;
  onNote(cb: (n: { device: string; deviceId: string; id: string; app: string; title: string; text: string; replyId: string }) => void): void;
  reply(id: string, replyId: string, message: string): Promise<boolean>;
  onCall(cb: (c: { device: string; event: string; name: string; number: string }) => void): void;
}

/** A saved login as shown in a list: never includes the password. */
export interface VaultItem { id: string; title: string; user: string; url: string }
interface VaultReply { ok: boolean; locked?: boolean; message?: string }
export interface VaultApi {
  status(): Promise<{ exists: boolean; unlocked: boolean }>;
  reveal(): void;
  create(master: string): Promise<VaultReply>;
  unlock(master: string): Promise<VaultReply>;
  lock(): Promise<VaultReply>;
  list(): Promise<VaultReply & { items: VaultItem[] }>;
  save(item: { id?: string; title: string; user: string; password: string; url: string }): Promise<VaultReply & { id?: string }>;
  remove(id: string): Promise<VaultReply>;
  generate(length: number, symbols: boolean): Promise<string>;
  show(id: string): Promise<VaultReply & { password?: string }>;
  copy(id: string, what: 'password' | 'user'): Promise<VaultReply>;
}

export interface VoiceState { state: 'idle' | 'listening' | 'working'; since: number }
export interface VoiceResult { ok: boolean; text?: string; message?: string; typed?: boolean }
export interface VoiceInfo { problem: string; mics: string[]; mic: string; lang: string; history: { text: string; at: number }[]; state: VoiceState }

/** One Claude Code session seen on this computer in the last few hours. */
export interface ClaudeSession { project: string; active: boolean; mtime: number }
export interface ClaudeState { active: number; sessions: ClaudeSession[] }
export interface ClaudeUsage { input: number; output: number; cacheRead: number; cacheWrite: number; replies: number; sessions: number }

/** What a file tool reports back: where the result went, and a sentence about it. */
export interface ToolResult { ok: boolean; file?: string; message?: string }

export interface TimerState {
  /** Length the timer was set to, in seconds. */
  total: number;
  /** Seconds left while paused or not started. */
  left: number;
  /** Timestamp in ms when it will finish, while running. */
  endAt: number | null;
}

/** Copied text, or a copied picture kept as a file with a small preview. */
export interface ClipPicture { image: string; thumb: string; w: number; h: number; id: string }
export type Clip = string | ClipPicture;

export interface Place { city: string; lat: number; lon: number }
/** Everything the Settings panel can change. */
export interface Settings {
  theme: 'black' | 'graphite' | 'midnight' | 'light';
  scale: number;
  clock24: boolean;
  unit: 'c' | 'f';
  place: Place | null;
  peek: boolean;
  sounds: boolean;
  lyrics: boolean;
  clipHistory: boolean;
  winNotes: boolean;
  phoneNotes: boolean;
  hidden: string[];
}
export const DEFAULT_SETTINGS: Settings = { theme: 'black', scale: 1, clock24: false, unit: 'c', place: null, peek: true, sounds: true, lyrics: true, clipHistory: true, winNotes: true, phoneNotes: true, hidden: [] };

export interface ShelfItem { file: string; name: string; size: number; dir: boolean }
export interface ShelfApi {
  list(): Promise<ShelfItem[]>;
  addDropped(files: FileList | File[]): Promise<ShelfItem[]>;
  pick(): Promise<ShelfItem[]>;
  remove(file: string): Promise<ShelfItem[]>;
  clear(): Promise<ShelfItem[]>;
  reveal(file: string): void;
  drag(file: string): void;
  zip(): Promise<ToolResult>;
  toPhone(): Promise<ToolResult>;
  onChange(cb: (items: ShelfItem[]) => void): void;
}
export interface ShareInfo { url: string; until: number; files: { name: string; size: number }[] }
export interface ShareApi {
  info(): Promise<ShareInfo | null>;
  start(source: 'shelf' | 'pick' | 'receive'): Promise<{ ok: boolean; message?: string } & Partial<ShareInfo>>;
  stop(): void;
  toPhone(): Promise<ToolResult>;
  onChange(cb: (info: ShareInfo | null) => void): void;
}
export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface AiApi {
  info(): Promise<{ hasKey: boolean; models: { id: string; label: string }[]; model: string }>;
  setKey(key: string): Promise<{ ok: boolean; message?: string }>;
  setModel(model: string): void;
  ask(messages: ChatTurn[]): Promise<{ ok: boolean; text?: string; message?: string; cut?: boolean }>;
  stop(): void;
  onText(cb: (piece: string) => void): void;
}

export interface IslandApi {
  presence(p: { open: boolean; visible: boolean }): void;
  copyClipPicture(id: string): void;
  onWinNote(cb: (n: { app: string; title: string; text: string }) => void): void;
  night(action: 'toggle' | 'state'): Promise<{ ok: boolean; on: boolean; why: string }>;
  settingsInfo(): Promise<{ winNotes: string }>;
  placeSearch(name: string): Promise<(Place & { where: string })[]>;
  shelf: ShelfApi;
  share: ShareApi;
  ai: AiApi;
  translateLangs(): Promise<[string, string][]>;
  translate(text: string, from: string, to: string): Promise<{ ok: boolean; text?: string; message?: string }>;
  zone(z: { x: number; y: number; w: number; h: number }): void;
  onHover(cb: (inside: boolean) => void): void;
  onBlur(cb: () => void): void;
  onShow(cb: () => void): void;
  state(): Promise<{ media: Media | null; weather: Weather | null; clips: Clip[]; claude: ClaudeState; awake: boolean; voice: VoiceState; volume: Volume; lyrics: Lyrics; recording: { on: boolean; since: number } }>;
  onMedia(cb: (m: Media | null) => void): void;
  onWeather(cb: (w: Weather | null) => void): void;
  onClips(cb: (c: Clip[]) => void): void;
  onClaude(cb: (c: ClaudeState) => void): void;
  claudeUsage(): Promise<ClaudeUsage>;
  onVolume(cb: (v: Volume) => void): void;
  onRecording(cb: (r: { on: boolean; since: number }) => void): void;
  onRecordingDone(cb: (r: { ok: boolean; file?: string }) => void): void;
  onSystem(cb: (s: SystemLoad) => void): void;
  toggleRecording(): Promise<{ ok: boolean; message?: string }>;
  rates(): Promise<Record<string, number> | null>;
  onLyrics(cb: (l: Lyrics) => void): void;
  seek(seconds: number): void;
  setVolume(level: number): void;
  toggleMute(): void;
  openSource(): void;
  onVoice(cb: (v: VoiceState) => void): void;
  onVoiceResult(cb: (r: VoiceResult) => void): void;
  onVoicePartial(cb: (text: string) => void): void;
  voiceInfo(): Promise<VoiceInfo>;
  voiceStart(): Promise<VoiceResult>;
  voiceStop(): Promise<VoiceResult>;
  voiceSet(mic: string, lang: string): void;
  media(cmd: 'toggle' | 'play' | 'pause' | 'next' | 'prev'): void;
  log(text: string): void;
  quit(): void;
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): void;
  onStoreChanged(cb: (change: { key: string; value: unknown }) => void): void;
  copyClip(text: string): void;
  clearClips(): void;
  capture(): Promise<{ ok: boolean; file?: string }>;
  snip(): void;
  snipDone(box: { x: number; y: number; w: number; h: number } | null): void;
  onCapture(cb: (r: { ok: boolean; file?: string }) => void): void;
  saveRecording(data: ArrayBuffer): Promise<{ ok: boolean; file?: string }>;
  reveal(file: string): void;
  showStickies(): void;
  setStickyDock(on: boolean): void;
  pick(kind: 'pdf' | 'image' | 'archive' | 'video' | 'audio' | 'any', multi: boolean): Promise<string[]>;
  video(files: string[], options: Record<string, unknown>): Promise<ToolResult>;
  audio(files: string[], options: Record<string, unknown>): Promise<ToolResult>;
  cutBackground(files: string[]): Promise<ToolResult>;
  pdf(op: string, files: string[], options?: Record<string, unknown>): Promise<ToolResult>;
  image(files: string[], options: Record<string, unknown>): Promise<ToolResult>;
  archive(op: 'zip' | 'unzip', files: string[]): Promise<ToolResult>;
  rename(files: string[], options: Record<string, unknown>): Promise<ToolResult>;
  readText(file: string): Promise<{ ok: boolean; text: string }>;
  savePicture(dataUrl: string, name: string): Promise<ToolResult>;
  copyText(text: string): void;
  openDraw(): void;
  openStage(mode: string): void;
  closeStage(): void;
  closeDraw(): void;
  vault: VaultApi;
  phone: PhoneApi;
  companion: CompanionApi;
  toggleAwake(): Promise<boolean>;
  lock(): void;
  radio(kind: 'wifi' | 'bluetooth', action: 'toggle' | 'state'): Promise<{ ok: boolean; on: boolean; why: string }>;
  openSettings(uri: string): void;
  getStartup(): Promise<boolean>;
  setStartup(v: boolean): Promise<boolean>;
}

declare global { interface Window { island?: IslandApi } }
