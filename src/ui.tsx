import type { Weather } from './types';

export function Icon({ d, size = 18, fill = false, width = 1.7 }: { d: string; size?: number; fill?: boolean; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const PATHS = {
  prev: 'M21 5v14l-9-7zM11 5v14l-9-7z',
  next: 'M3 5v14l9-7zM13 5v14l9-7z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  play: 'M7 4l13 8-13 8z',
  bell: 'M6 16V11a6 6 0 0112 0v5l1.5 2H4.5zM10 20a2 2 0 004 0',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  battery: 'M3 8h15v8H3zM20 11v2M6 11v2',
  back: 'M14 6l-6 6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2',
  timer: 'M12 5a8 8 0 100 16 8 8 0 000-16zM12 9v4l2.5 2M9 2h6',
  spark: 'M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z',
  note: 'M5 4h14v10l-5 6H5zM14 20v-6h5',
  shot: 'M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M9 9h6v6H9z',
};

const WX = {
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
  moon: 'M20 14A8 8 0 0110 4a8 8 0 1010 10z',
  partly: 'M8 5V3.5M3.5 9.5H2M4.2 5.7L3.1 4.6M11.8 5.7l1.1-1.1M5.2 11.2A3.5 3.5 0 1111 8M9 19a3.5 3.5 0 010-7 5 5 0 019.5 1.4A2.9 2.9 0 0118 19z',
  cloud: 'M7 18a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0117 18z',
  fog: 'M7 14a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0117 14M5 17h14M7 20h10',
  rain: 'M7 15a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0117 15M8 18l-1 3M12 18l-1 3M16 18l-1 3',
  snow: 'M7 15a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0117 15M8 19h.01M12 20h.01M16 19h.01M10 22h.01M14 22h.01',
  storm: 'M7 15a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0117 15M13 14l-3 4h3l-2 4',
};

export function weatherPath(code: number, day: boolean): string {
  if (code === 0) return day ? WX.sun : WX.moon;
  if (code === 1 || code === 2) return day ? WX.partly : WX.cloud;
  if (code === 3) return WX.cloud;
  if (code === 45 || code === 48) return WX.fog;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return WX.snow;
  if (code >= 95) return WX.storm;
  if (code >= 51) return WX.rain;
  return WX.cloud;
}

export function weatherWord(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1 || code === 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow';
  if (code >= 95) return 'Thunderstorm';
  if (code >= 51) return 'Rain';
  return 'Cloudy';
}

export const weatherIcon = (w: Weather) => weatherPath(w.code, w.day);

let clock24 = false;
/** Settings can switch every clock in the island to 24-hour time. */
export function setClock24(on: boolean) { clock24 = on; }

export function clock(d: Date, tz?: string) {
  const parts = new Intl.DateTimeFormat('en-US', clock24 ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz } : { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { time: `${get('hour')}:${get('minute')}`, ampm: get('dayPeriod') };
}

export function mmss(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/**
 * The mark of the app something comes from: Claude's burst, Spotify, YouTube.
 * Returns nothing for a source without a mark, so callers can fall back.
 */
export function Brand({ name, size = 14 }: { name: string; size?: number }) {
  if (name === 'claude') {
    // Twelve rays of uneven length around a centre, in Claude's coral.
    const rays = Array.from({ length: 12 }, (_, i) => {
      const a = (i * Math.PI) / 6;
      const r = i % 2 === 0 ? 10.2 : 8.2;
      return <line key={i} x1={12 + Math.cos(a) * 2.6} y1={12 + Math.sin(a) * 2.6} x2={12 + Math.cos(a) * r} y2={12 + Math.sin(a) * r} />;
    });
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#D97757" strokeWidth="2.3" strokeLinecap="round" role="img" aria-label="Claude">{rays}</svg>;
  }
  if (name === 'spotify') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Spotify">
        <circle cx="12" cy="12" r="11" fill="#1DB954" />
        <g fill="none" stroke="#000" strokeLinecap="round">
          <path d="M6.6 9.300c3.800-1.100 7.600-.800 10.900 1" strokeWidth="2.100" />
          <path d="M7.300 12.600c3-.900 6-.600 8.600.800" strokeWidth="1.800" />
          <path d="M8 15.600c2.300-.600 4.500-.400 6.400.600" strokeWidth="1.500" />
        </g>
      </svg>
    );
  }
  if (name === 'youtube') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="YouTube">
        <rect x="1.500" y="5" width="21" height="14" rx="4.200" fill="#FF0000" />
        <path d="M10 8.800l5.600 3.200-5.600 3.200z" fill="#fff" />
      </svg>
    );
  }
  return null;
}

export const hasBrand = (name: string) => name === 'claude' || name === 'spotify' || name === 'youtube';