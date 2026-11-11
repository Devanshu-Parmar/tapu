import { useEffect, useRef, useState } from 'react';
import './types';
import { Icon, PATHS } from './ui';

interface Stroke { color: string; size: number; alpha: number; erase?: boolean; points: { x: number; y: number }[] }
type Tool = 'pen' | 'marker' | 'eraser';

const COLORS = ['#ff453a', '#ffd60a', '#30d158', '#0a84ff', '#ffffff'];

/** A see-through sheet over the whole screen that you can draw on. Esc or the cross closes it. */
export function Draw() {
  const ref = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [tool, setTool] = useState<Tool>('pen');
  const [count, setCount] = useState(0);
  const [shooting, setShooting] = useState(false);
  // Hide the toolbar, take the picture with the drawings in it, then bring the toolbar back.
  const capture = () => { setShooting(true); window.setTimeout(async () => { await window.island?.capture(); setShooting(false); }, 180); };

  const paint = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    if (s.points.length === 0) return;
    // The eraser rubs ink away instead of adding it.
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.globalAlpha = s.alpha;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points) ctx.lineTo(p.x, p.y);
    if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.01, s.points[0].y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };

  const redraw = () => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of strokes.current) paint(ctx, s);
    if (current.current) paint(ctx, current.current);
  };

  useEffect(() => {
    const c = ref.current!;
    const fit = () => { c.width = window.innerWidth; c.height = window.innerHeight; redraw(); };
    fit();
    window.addEventListener('resize', fit);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.island?.closeDraw();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') undo();
    };
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', fit); document.removeEventListener('keydown', key); };
  }, []);

  const undo = () => { strokes.current.pop(); setCount(strokes.current.length); redraw(); };
  const clear = () => { strokes.current = []; setCount(0); redraw(); };

  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    current.current = tool === 'eraser'
      ? { color: '#000', size: 30, alpha: 1, erase: true, points: [{ x: e.clientX, y: e.clientY }] }
      : { color, size: tool === 'marker' ? 22 : 4, alpha: tool === 'marker' ? 0.35 : 1, points: [{ x: e.clientX, y: e.clientY }] };
    redraw();
  };
  const move = (e: React.PointerEvent) => {
    if (!current.current) return;
    current.current.points.push({ x: e.clientX, y: e.clientY });
    // A see-through marker has to be repainted whole, or overlaps darken; a solid pen can just extend.
    if (current.current.alpha < 1) redraw();
    else {
      const pts = current.current.points;
      const ctx = ref.current!.getContext('2d')!;
      paint(ctx, { ...current.current, points: pts.slice(-2) });
    }
  };
  const up = () => {
    if (!current.current) return;
    strokes.current.push(current.current);
    current.current = null;
    setCount(strokes.current.length);
  };

  return (
    <div className="draw">
      <canvas ref={ref} aria-label="Drawing area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="draw-bar black" style={shooting ? { visibility: 'hidden' } : undefined}>
        {COLORS.map((c) => (
          <button key={c} className={`draw-color ${c === color ? 'on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={c === color} onClick={() => setColor(c)} />
        ))}
        <span className="draw-rule" />
        {(['pen', 'marker', 'eraser'] as Tool[]).map((t) => (
          <button key={t} className={`pillbtn ${tool === t ? 'solid' : ''}`} aria-pressed={tool === t} onClick={() => setTool(t)}>{t === 'pen' ? 'Pen' : t === 'marker' ? 'Marker' : 'Eraser'}</button>
        ))}
        <span className="draw-rule" />
        <button className="pillbtn" disabled={count === 0} onClick={undo}>Undo</button>
        <button className="pillbtn" disabled={count === 0} onClick={clear}>Clear</button>
        <button className="pillbtn" onClick={capture}>Capture</button>
        <button className="round" aria-label="Stop drawing" onClick={() => window.island?.closeDraw()}><Icon d={PATHS.close} size={13} width={2.4} /></button>
      </div>
    </div>
  );
}
