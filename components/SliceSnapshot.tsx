'use client';

import { useEffect, useRef } from 'react';
import { paintSlice } from '@/lib/render';
import type { LabelMap, Volume } from '@/lib/types';
import { geom } from '@/lib/views';

/** Static axial slice with label overlay, used as report evidence. */
export default function SliceSnapshot({ vol, mask, labels, k, lut, opacity = 0.5, caption }: {
  vol: Volume; mask: Uint8Array | null; labels: LabelMap; k: number; lut: Uint8Array; opacity?: number; caption: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = geom(vol, 'axial', { i: 0, j: 0, k });
    c.width = g.w;
    c.height = g.h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(g.w, g.h);
    paintSlice(img, g, vol.data, lut, mask, labels, opacity);
    ctx.putImageData(img, 0, 0);
  }, [vol, mask, labels, k, lut, opacity]);
  return (
    <figure className="snapshot">
      <canvas ref={ref} style={{ aspectRatio: `${vol.nx * vol.sx} / ${vol.ny * vol.sy}` }} />
      <figcaption>{caption}</figcaption>
      <span className="snap-r">R</span>
      <span className="snap-l">L</span>
    </figure>
  );
}
