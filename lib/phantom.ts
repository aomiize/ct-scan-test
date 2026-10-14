import type { Volume } from './types';

/** Deterministic synthetic abdomen (T12–L4) with a matching generic-scheme mask. Not patient data. */
export function makePhantom(): { vol: Volume; mask: Uint8Array; l3: number } {
  const nx = 192, ny = 192, nz = 70, sx = 2, sy = 2, sz = 3, N = nx * ny * nz;
  const data = new Int16Array(N);
  const mask = new Uint8Array(N);

  let seed = 1337;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const noise = () => (rnd() + rnd() + rnd() - 1.5) * 16;
  const bowel = [[-40, -60, 18], [10, -70, 16], [50, -50, 15], [-10, -30, 14], [30, -20, 13], [-55, -35, 12], [65, -15, 12], [0, -90, 11]];
  const imat: [number, number, number][] = [];
  for (let q = 0; q < 90; q++) imat.push([rnd() * Math.PI * 2, 0.75 + rnd() * 0.06, 1.5 + rnd() * 2.5]);
  const ell = (X: number, Y: number, cx: number, cy: number, a: number, b: number) => ((X - cx) / a) ** 2 + ((Y - cy) / b) ** 2;

  for (let k = 0; k < nz; k++) {
    const t = k / (nz - 1);
    const disc = k % 14 >= 12;
    const A = 150 + 10 * Math.sin(t * 3), B = 108 + 6 * Math.cos(t * 2.3);
    const psoasR = 1 - t * 0.7;
    for (let j = 0; j < ny; j++) {
      const Y = (j - ny / 2) * sy;
      for (let i = 0; i < nx; i++) {
        const X = (i - nx / 2) * sx, p = i + nx * (j + ny * k);
        let hu = -1000, L = 0;
        if (Y > 120 && Y < 128 && Math.abs(X) < 175) hu = 180;
        const r = Math.sqrt(ell(X, Y, 0, 0, A, B));
        if (r <= 1) {
          const th = Math.atan2(Y / B, X / A);
          const satIn = 0.8 + 0.04 * Math.sin(th * 3) + (Y > 0 ? -0.04 : 0);
          if (r > 0.985) hu = 30;
          else if (r > satIn) { hu = -105; L = 2; }
          else if (r > satIn - 0.065) {
            hu = 48; L = 1;
            for (const m of imat) {
              const dx = ((th - m[0] + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
              if (Math.abs(dx * A * r) < m[2] && Math.abs(r - m[1]) < 0.012) { hu = -70; L = 4; break; }
            }
          } else {
            hu = -92; L = 3;
            if (t > 0.55 && ell(X, Y, -62, -5, 58 * (t - 0.4), 62) < 1) { hu = 58; L = 0; }
            if (t > 0.2 && t < 0.8 && (ell(X, Y, 58, 32, 22, 30) < 1 || ell(X, Y, -58, 34, 22, 30) < 1)) { hu = 34; L = 0; }
            for (const b of bowel) {
              const d = ell(X, Y, b[0], b[1] + 8 * Math.sin(t * 6 + b[0]), b[2], b[2]);
              if (d < 1) { hu = d < 0.35 && b[2] % 3 === 0 ? -820 : 28; L = 0; break; }
            }
            if (ell(X, Y, 14, -6, 11, 11) < 1) { hu = 42; L = 0; }
            if (ell(X, Y, -16, -4, 12, 10) < 1) { hu = 40; L = 0; }
          }
          const psoas = Math.min(ell(X, Y, 34, 22, 22 * psoasR + 6, 18 * psoasR + 5), ell(X, Y, -34, 22, 22 * psoasR + 6, 18 * psoasR + 5));
          const para = Math.min(ell(X, Y, 40, 74, 30, 22), ell(X, Y, -40, 74, 30, 22));
          if ((psoas < 1 || para < 1) && r <= satIn) { hu = 50; L = 1; }
          const vb = Math.hypot(X, Y - 26);
          if (disc) {
            if (vb < 21) { hu = 85; L = 0; }
          } else {
            if (vb < 21) { hu = vb > 18.5 ? 720 : 230; L = 5; }
            const arch = Math.hypot(X, Y - 56);
            if (arch < 14) { hu = arch > 9 ? 650 : 12; L = arch > 9 ? 5 : 0; }
            if (Y > 66 && Y < 92 && Math.abs(X) < 5) { hu = 600; L = 5; }
            if (Math.abs(Y - 58) < 6 && Math.abs(X) > 12 && Math.abs(X) < 30) { hu = 600; L = 5; }
          }
        }
        data[p] = Math.round(hu + (hu > -950 ? noise() : noise() * 0.3));
        mask[p] = L;
      }
    }
  }
  return { vol: { nx, ny, nz, sx, sy, sz, data, src: 'synthetic', desc: 'Synthetic abdomen phantom' }, mask, l3: 20 };
}
