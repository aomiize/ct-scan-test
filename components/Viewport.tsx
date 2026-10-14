'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { VIEW_COLOR } from '@/lib/labels';
import { measLength } from '@/lib/metrics';
import type { Cursor, LabelMap, Measurement, Tool, ViewName, Volume, WindowLevel } from '@/lib/types';
import { paintSlice } from '@/lib/render';
import { geom, pick } from '@/lib/views';

const TITLES: Record<ViewName, string> = { axial: 'Axial', coronal: 'Coronal', sagittal: 'Sagittal' };

interface Props {
  name: ViewName;
  vol: Volume | null;
  mask: Uint8Array | null;
  labels: LabelMap;
  lut: Uint8Array;
  cur: Cursor;
  wl: WindowLevel;
  opacity: number;
  tool: Tool;
  meas: Measurement[];
  l3: number | null;
  resetToken: number;
  onCursor: (c: Cursor) => void;
  onStep: (name: ViewName, d: number) => void;
  onWL: (wl: WindowLevel) => void;
  onAddMeas: (m: Omit<Measurement, 'id'>) => void;
  title?: string;
}

interface Fit {
  ox: number;
  oy: number;
  ku: number;
  kv: number;
  W: number;
  H: number;
}

type Drag =
  | { mode: 'wl'; x: number; y: number; wl: WindowLevel }
  | { mode: 'pan'; x: number; y: number; pan: [number, number] }
  | { mode: 'cross' }
  | { mode: 'cal'; m: Omit<Measurement, 'id'> };

export default function Viewport(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<{ canvas: HTMLCanvasElement; img: ImageData; key: string } | null>(null);
  const viewRef = useRef({ zoom: 1, panx: 0, pany: 0 });
  const fitRef = useRef<Fit | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const propsRef = useRef(p);
  propsRef.current = p;
  const [probe, setProbe] = useState('');
  const rafRef = useRef(0);

  const g = p.vol ? geom(p.vol, p.name, p.cur) : null;

  const computeFit = useCallback((): Fit | null => {
    const { vol, name, cur } = propsRef.current;
    const c = canvasRef.current;
    if (!vol || !c) return null;
    const gg = geom(vol, name, cur);
    const v = viewRef.current;
    const s = Math.min(c.width / (gg.w * gg.px), c.height / (gg.h * gg.py)) * 0.94 * v.zoom;
    const W = gg.w * gg.px * s, H = gg.h * gg.py * s;
    return { ox: (c.width - W) / 2 + v.panx, oy: (c.height - H) / 2 + v.pany, ku: gg.px * s, kv: gg.py * s, W, H };
  }, []);

  const renderOffscreen = useCallback(() => {
    const { vol, name, cur, mask, labels, lut, opacity } = propsRef.current;
    if (!vol) return null;
    const gg = geom(vol, name, cur);
    const key = `${gg.slice}`;
    let off = offRef.current;
    if (!off || off.canvas.width !== gg.w || off.canvas.height !== gg.h) {
      const canvas = document.createElement('canvas');
      canvas.width = gg.w;
      canvas.height = gg.h;
      off = { canvas, img: canvas.getContext('2d')!.createImageData(gg.w, gg.h), key: '' };
      offRef.current = off;
    }
    // Recompute whenever slice, data, LUT, mask, labels or opacity changes (identity-tracked via WeakMap-free tokens).
    const token = [key, idOf(vol.data), idOf(lut), mask ? idOf(mask) : 0, idOf(labels), opacity].join(':');
    if (off.key === token) return off.canvas;
    off.key = token;

    paintSlice(off.img, gg, vol.data, lut, mask, labels, opacity);
    off.canvas.getContext('2d')!.putImageData(off.img, 0, 0);
    return off.canvas;
  }, []);

  const draw = useCallback(() => {
    rafRef.current = 0;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    const { vol, name, cur, meas, l3, wl } = propsRef.current;
    if (!vol) return;
    const img = renderOffscreen();
    const f = computeFit();
    if (!img || !f) return;
    fitRef.current = f;
    const gg = geom(vol, name, cur);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, f.ox, f.oy, f.W, f.H);
    const P = (u: number, v: number): [number, number] => [f.ox + u * f.ku, f.oy + v * f.kv];

    // crosshair: vertical = first plane, horizontal = second plane, with a gap at the centre
    const [sx, sy] = P(gg.cross[0] + 0.5, gg.cross[1] + 0.5);
    const gap = 14 * dpr;
    ctx.lineWidth = dpr;
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = VIEW_COLOR[gg.lines[0]];
    ctx.beginPath();
    ctx.moveTo(sx, f.oy); ctx.lineTo(sx, sy - gap);
    ctx.moveTo(sx, sy + gap); ctx.lineTo(sx, f.oy + f.H);
    ctx.stroke();
    ctx.strokeStyle = VIEW_COLOR[gg.lines[1]];
    ctx.beginPath();
    ctx.moveTo(f.ox, sy); ctx.lineTo(sx - gap, sy);
    ctx.moveTo(sx + gap, sy); ctx.lineTo(f.ox + f.W, sy);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (l3 != null && name !== 'axial') {
      const [, ly] = P(0, vol.nz - 1 - l3 + 0.5);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(255,255,255,.6)';
      ctx.beginPath(); ctx.moveTo(f.ox, ly); ctx.lineTo(f.ox + f.W, ly); ctx.stroke();
      ctx.setLineDash([]);
      tag(ctx, 'L3', f.ox + 4 * dpr, ly - 4 * dpr, dpr, '#ffffff');
    }

    const live = dragRef.current?.mode === 'cal' ? [dragRef.current.m] : [];
    for (const m of [...meas, ...live]) {
      if (m.view !== name || m.slice !== gg.slice) continue;
      const [a1, a2] = P(m.a[0], m.a[1]), [b1, b2] = P(m.b[0], m.b[1]);
      ctx.strokeStyle = '#7cf0a0';
      ctx.fillStyle = '#7cf0a0';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(a1, a2); ctx.lineTo(b1, b2); ctx.stroke();
      for (const [x, y] of [[a1, a2], [b1, b2]]) {
        ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2); ctx.fill();
      }
      tag(ctx, `${measLength(vol, { ...m, id: 0 }).toFixed(1)} mm`, b1 + 6 * dpr, b2 - 6 * dpr, dpr, '#7cf0a0');
    }

    const o = gg.orient;
    ctx.font = `600 ${12 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(o[0], 8 * dpr, ch / 2);
    ctx.textAlign = 'right'; ctx.fillText(o[1], cw - 8 * dpr, ch / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(o[2], cw / 2, 6 * dpr);
    ctx.textBaseline = 'bottom'; ctx.fillText(o[3], cw / 2, ch - 6 * dpr);
    ctx.font = `${11 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(`W ${wl.w}  L ${wl.l}`, 8 * dpr, ch - 8 * dpr);
    if (viewRef.current.zoom !== 1) {
      ctx.textAlign = 'right';
      ctx.fillText(`${viewRef.current.zoom.toFixed(2)}×`, cw - 8 * dpr, ch - 8 * dpr);
    }
  }, [computeFit, renderOffscreen]);

  const schedule = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    schedule();
  });

  useEffect(() => {
    viewRef.current = { zoom: 1, panx: 0, pany: 0 };
    schedule();
  }, [p.resetToken, p.vol, schedule]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(c);
    const onWheel = (e: WheelEvent) => {
      const { vol, name, onStep } = propsRef.current;
      if (!vol) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const dpr = window.devicePixelRatio || 1;
        const mx = e.offsetX * dpr, my = e.offsetY * dpr;
        const f1 = computeFit();
        if (!f1) return;
        const u = (mx - f1.ox) / f1.ku, v = (my - f1.oy) / f1.kv;
        const vr = viewRef.current;
        vr.zoom = Math.max(0.5, Math.min(16, vr.zoom * Math.exp(-e.deltaY * 0.0015)));
        const f2 = computeFit()!;
        vr.panx += mx - u * f2.ku - f2.ox;
        vr.pany += my - v * f2.kv - f2.oy;
        schedule();
      } else onStep(name, e.deltaY > 0 ? -1 : 1);
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      c.removeEventListener('wheel', onWheel);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [schedule, computeFit]);

  const toImg = (e: React.PointerEvent): [number, number] => {
    const f = fitRef.current ?? computeFit();
    const dpr = window.devicePixelRatio || 1;
    if (!f) return [-1, -1];
    return [(e.nativeEvent.offsetX * dpr - f.ox) / f.ku, (e.nativeEvent.offsetY * dpr - f.oy) / f.kv];
  };
  const inside = (u: number, v: number) => !!g && u >= 0 && v >= 0 && u < g.w && v < g.h;
  const moveCursor = (u: number, v: number) => {
    if (!p.vol || !g) return;
    const cu = Math.max(0, Math.min(g.w - 1, Math.floor(u)));
    const cv = Math.max(0, Math.min(g.h - 1, Math.floor(v)));
    p.onCursor(pick(p.vol, p.name, p.cur, cu, cv));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!p.vol || !g) return;
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    const mode: Tool = e.button === 2 ? 'wl' : e.button === 1 ? 'pan' : p.tool;
    const [u, v] = toImg(e);
    if (mode === 'wl') dragRef.current = { mode, x: e.clientX, y: e.clientY, wl: { ...p.wl } };
    else if (mode === 'pan') dragRef.current = { mode, x: e.clientX, y: e.clientY, pan: [viewRef.current.panx, viewRef.current.pany] };
    else if (mode === 'cross') {
      dragRef.current = { mode };
      if (inside(u, v)) moveCursor(u, v);
    } else if (mode === 'cal' && inside(u, v)) {
      dragRef.current = { mode, m: { view: p.name, slice: g.slice, a: [u, v], b: [u, v] } };
    }
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!p.vol || !g) return;
    const [u, v] = toImg(e);
    if (inside(u, v)) {
      const c = pick(p.vol, p.name, p.cur, Math.floor(u), Math.floor(v));
      const id = c.i + p.vol.nx * (c.j + p.vol.ny * c.k);
      const L = p.mask ? p.mask[id] : 0;
      const lab = L && p.labels[L] ? ` · ${p.labels[L].name}` : '';
      setProbe(`voxel ${c.i}, ${c.j}, ${c.k} · ${p.vol.data[id]} HU${lab}`);
    } else setProbe('');

    const d = dragRef.current;
    if (!d) return;
    const dpr = window.devicePixelRatio || 1;
    if (d.mode === 'wl') {
      p.onWL({ w: Math.max(1, Math.round(d.wl.w + (e.clientX - d.x) * 4)), l: Math.round(d.wl.l - (e.clientY - d.y) * 2) });
    } else if (d.mode === 'pan') {
      viewRef.current.panx = d.pan[0] + (e.clientX - d.x) * dpr;
      viewRef.current.pany = d.pan[1] + (e.clientY - d.y) * dpr;
      schedule();
    } else if (d.mode === 'cross') moveCursor(u, v);
    else if (d.mode === 'cal') {
      d.m.b = [Math.max(0, Math.min(g.w, u)), Math.max(0, Math.min(g.h, v))];
      schedule();
    }
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.mode === 'cal' && p.vol && measLength(p.vol, { ...d.m, id: 0 }) >= 0.5) p.onAddMeas(d.m);
    schedule();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!p.vol) return;
    const map: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    if (e.key in map) {
      p.onStep(p.name, map[e.key]);
      e.preventDefault();
    }
  };

  const meta = (() => {
    if (!p.vol || !g) return '';
    const axis = p.name === 'axial' ? ['z', p.vol.sz] : p.name === 'coronal' ? ['y', p.vol.sy] : ['x', p.vol.sx];
    return `${g.slice + 1}/${g.n} · ${axis[0]} ${(g.slice * (axis[1] as number)).toFixed(1)} mm${p.name === 'axial' && p.l3 === g.slice ? ' · L3' : ''}`;
  })();

  return (
    <section className="pane">
      <div className="pane-head">
        <span className="dot" style={{ background: VIEW_COLOR[p.name] }} />
        <b>{p.title ?? TITLES[p.name]}</b>
        <span className="meta">{meta}</span>
        <span className="nav">
          <button type="button" aria-label={`Previous ${p.name} slice`} onClick={() => p.vol && p.onStep(p.name, -1)}>‹</button>
          <button type="button" aria-label={`Next ${p.name} slice`} onClick={() => p.vol && p.onStep(p.name, 1)}>›</button>
        </span>
      </div>
      <div className="vp">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`${TITLES[p.name]} view`}
          className={p.tool === 'pan' ? 't-pan' : p.tool === 'wl' ? 't-wl' : ''}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => !dragRef.current && setProbe('')}
          onDoubleClick={() => {
            viewRef.current = { zoom: 1, panx: 0, pany: 0 };
            schedule();
          }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="pane-foot">{probe}</div>
    </section>
  );
}

function tag(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, dpr: number, col: string) {
  ctx.font = `600 ${11 * dpr}px "IBM Plex Mono", monospace`;
  const w = ctx.measureText(t).width;
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(x - 3 * dpr, y - 11 * dpr, w + 6 * dpr, 15 * dpr);
  ctx.fillStyle = col;
  ctx.fillText(t, x, y);
}

/** Stable numeric identity per object, so the offscreen cache knows when inputs were replaced. */
const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(o: object) {
  let v = ids.get(o);
  if (!v) {
    v = nextId++;
    ids.set(o, v);
  }
  return v;
}
