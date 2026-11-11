import { useEffect, useRef, useState } from 'react';
import './types';

interface Box { x: number; y: number; w: number; h: number }

/** A dim sheet over the screen: drag out the area to capture. Esc cancels. */
export function Snip() {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') window.island?.snipDone(null); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY };
    setBox({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };
  const move = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    setBox({ x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) });
  };
  const up = () => {
    const b = box;
    start.current = null;
    // A stray click is not a selection.
    window.island?.snipDone(b && b.w > 6 && b.h > 6 ? b : null);
  };

  return (
    <div className="snip" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {box ? (
        <div className="snip-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
          <span>{Math.round(box.w)} × {Math.round(box.h)}</span>
        </div>
      ) : (
        <p className="snip-hint black">Drag to choose the area. Esc to cancel.</p>
      )}
    </div>
  );
}
