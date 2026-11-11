import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './types';
import type { Sticky, StickyColor, StickyTab, Task } from './types';
import { Icon, PATHS } from './ui';

const COLORS: StickyColor[] = ['yellow', 'pink', 'blue', 'green'];
const SPINE = 12; // how much of each sticky peeks out from the screen edge while tucked away
const DRAW_W = 232;
const DRAW_H = 132;

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const blank = (color: StickyColor): Sticky => ({ id: newId(), color, tab: 'text', text: '', tasks: [] });

function dueLabel(due: number): string {
  const d = new Date(due);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
  if (d.toDateString() === new Date().toDateString()) return time;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d) + ', ' + time;
}

/** Freehand scribble. The drawing is kept as a picture so it survives a restart. */
function Scribble({ value, onChange }: { value?: string; onChange: (png: string | undefined) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!value) return;
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height);
    img.src = value;
  }, [value]);

  const point = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * ref.current!.width, y: ((e.clientY - r.top) / r.height) * ref.current!.height };
  };
  const down = (e: React.PointerEvent) => {
    drawing.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    const ctx = ref.current!.getContext('2d')!;
    const p = point(e);
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.01, p.y); ctx.stroke();
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext('2d')!;
    const p = point(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(ref.current!.toDataURL('image/png'));
  };

  return (
    <div className="scribble">
      <canvas ref={ref} width={DRAW_W * 2} height={DRAW_H * 2} style={{ width: DRAW_W, height: DRAW_H }}
        aria-label="Scribble area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <button className="s-btn" onClick={() => onChange(undefined)}>Clear</button>
    </div>
  );
}

function Checklist({ tasks, onChange }: { tasks: Task[]; onChange: (t: Task[]) => void }) {
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [timed, setTimed] = useState(false);
  const add = () => {
    const t = text.trim();
    if (!t) return;
    const due = timed && when ? new Date(when).getTime() : NaN;
    onChange([...tasks, { id: newId(), text: t, done: false, due: isFinite(due) ? due : undefined }]);
    setText(''); setWhen(''); setTimed(false);
  };
  return (
    <div className="s-tasks">
      <ul>
        {tasks.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}>
            <button className={`s-check ${t.done ? 'on' : ''}`} role="checkbox" aria-checked={t.done} aria-label={t.done ? 'Mark not done' : 'Mark done'}
              onClick={() => onChange(tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))}>
              {t.done && <Icon d={PATHS.check} size={10} width={3.2} />}
            </button>
            <span className="s-task-text">{t.text}{t.due && <em>{dueLabel(t.due)}</em>}</span>
            <button className="s-x" aria-label="Delete task" onClick={() => onChange(tasks.filter((x) => x.id !== t.id))}><Icon d={PATHS.trash} size={12} width={2} /></button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input placeholder="Add a task" aria-label="New task" value={text} onChange={(e) => setText(e.target.value)} />
        {/* A reminder time is optional: the clock button reveals it. */}
        <button type="button" className={`s-icon ${timed ? 'on' : ''}`} aria-label="Set a reminder time" aria-pressed={timed} onClick={() => setTimed(!timed)}><Icon d={PATHS.clock} size={13} width={2.2} /></button>
        <button type="submit" className="s-icon" aria-label="Add task"><Icon d={PATHS.plus} size={13} width={2.6} /></button>
        {timed && <input className="s-when" type="datetime-local" aria-label="Remind me at" value={when} onChange={(e) => setWhen(e.target.value)} />}
      </form>
    </div>
  );
}

export function Stickies() {
  const forceOpen = useMemo(() => new URLSearchParams(location.search).get('open') === '1', []);
  const [stickies, setStickies] = useState<Sticky[] | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const shown = forceOpen || hovered || pinned;
  const listRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const save = (next: Sticky[]) => { setStickies(next); window.island?.save('stickies', next); };

  useEffect(() => {
    const api = window.island;
    (async () => {
      const saved = await api?.load('stickies').catch(() => null);
      // A saved list is the truth even when it is empty (you deleted everything).
      if (Array.isArray(saved)) { setStickies(saved.length ? (saved as Sticky[]) : [blank('yellow')]); return; }
      // Very first run only: carry over anything written in the earlier notes list, then forget that list.
      const first = blank('yellow');
      const old = await api?.load('notes').catch(() => null);
      if (Array.isArray(old) && old.length) {
        first.tab = 'tasks';
        first.tasks = (old as Task[]).filter((t) => t && typeof t.text === 'string').map((t) => ({ id: newId(), text: t.text, done: !!t.done, due: t.due }));
        api?.save('notes', null);
      }
      api?.save('stickies', [first]);
      setStickies([first]);
    })();
    // The island marks a reminder as shown; pick that up so it is not lost on the next edit here.
    api?.onStoreChanged((c) => { if (c.key === 'stickies' && Array.isArray(c.value)) setStickies(c.value as Sticky[]); });
    api?.onHover((inside) => {
      if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
      if (inside) setHovered(true);
      else closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setHovered(false); }, 260);
    });
    // Clicking a sticky keeps the stack out while you type; clicking elsewhere lets it go.
    api?.onBlur(() => setPinned(false));
    api?.onShow(() => setPinned(true));
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); (document.activeElement as HTMLElement | null)?.blur?.(); } };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  // Solid area: the whole stack while out, just the spines along the edge while tucked in.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const report = () => {
      const top = el.offsetTop, h = el.offsetHeight, w = window.innerWidth;
      // With no stickies there is nothing to grab on the edge; the Notes tile on the island brings the stack out.
      if (stickies && stickies.length === 0 && !pinned && !forceOpen) window.island?.zone({ x: 0, y: 0, w: 0, h: 0 });
      else if (shown) window.island?.zone({ x: 0, y: Math.max(0, top - 8), w, h: h + 16 });
      else window.island?.zone({ x: w - SPINE, y: top, w: SPINE, h });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown, stickies, pinned]);

  if (!stickies) return null;

  return (
    <div className={`stickies ${shown ? 'stickies-out' : ''} ${stickies.length === 0 && !pinned && !forceOpen ? 'stickies-none' : ''}`} onMouseDown={() => setPinned(true)}>
      <div className="s-list" ref={listRef}>
        <StickyBoard stickies={stickies} save={save} />
      </div>
    </div>
  );
}

/** The sticky cards themselves. Used by the edge stack and by the Notes panel inside the island. */
export function StickyBoard({ stickies, save }: { stickies: Sticky[]; save: (next: Sticky[]) => void }) {
  const patch = (id: string, change: Partial<Sticky>) => save(stickies.map((s) => (s.id === id ? { ...s, ...change } : s)));
  return (
    <>
        {stickies.map((s) => (
          <article key={s.id} className={`sticky sticky-${s.color}`}>
            <header>
              <div className="s-tabs" role="tablist">
                {(['text', 'tasks', 'draw'] as StickyTab[]).map((t) => (
                  <button key={t} role="tab" aria-selected={s.tab === t} className={s.tab === t ? 'on' : ''} onClick={() => patch(s.id, { tab: t })}>
                    {t === 'text' ? 'Note' : t === 'tasks' ? 'Tasks' : 'Draw'}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              <button className="s-icon" aria-label="Change colour" onClick={() => patch(s.id, { color: COLORS[(COLORS.indexOf(s.color) + 1) % COLORS.length] })}><span className="s-dot" /></button>
              <button className="s-icon" aria-label="Delete sticky" onClick={() => save(stickies.filter((x) => x.id !== s.id))}><Icon d={PATHS.trash} size={13} width={2} /></button>
            </header>
            {s.tab === 'text' && <textarea placeholder="Write anything…" aria-label="Note text" value={s.text} onChange={(e) => patch(s.id, { text: e.target.value })} />}
            {s.tab === 'tasks' && <Checklist tasks={s.tasks} onChange={(tasks) => patch(s.id, { tasks })} />}
            {s.tab === 'draw' && <Scribble value={s.drawing} onChange={(drawing) => patch(s.id, { drawing })} />}
          </article>
        ))}
        <button className="s-new" onClick={() => save([...stickies, blank(COLORS[stickies.length % COLORS.length])])}>
          <Icon d={PATHS.plus} size={13} width={2.6} /> New sticky
        </button>
    </>
  );
}
