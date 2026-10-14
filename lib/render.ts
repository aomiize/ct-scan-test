import type { LabelMap } from './types';
import type { ViewGeom } from './views';

/** Paint one slice (grey LUT + label overlay) into an ImageData of size g.w × g.h. */
export function paintSlice(img: ImageData, g: ViewGeom, data: Int16Array, lut: Uint8Array, mask: Uint8Array | null, labels: LabelMap, opacity: number) {
  const LR = new Uint8Array(256), LG = new Uint8Array(256), LB = new Uint8Array(256), LV = new Uint8Array(256);
  for (const [L, d] of Object.entries(labels)) {
    LR[+L] = d.color[0]; LG[+L] = d.color[1]; LB[+L] = d.color[2]; LV[+L] = d.visible ? 1 : 0;
  }
  const d = img.data, a = opacity;
  let q = 0;
  for (let v = 0; v < g.h; v++) {
    let id = g.base + v * g.dv;
    for (let u = 0; u < g.w; u++, id += g.du) {
      const gv = lut[data[id] + 32768];
      let r = gv, gg = gv, b = gv;
      if (mask) {
        const L = mask[id];
        if (L && LV[L]) {
          r += (LR[L] - r) * a;
          gg += (LG[L] - gg) * a;
          b += (LB[L] - b) * a;
        }
      }
      d[q] = r; d[q + 1] = gg; d[q + 2] = b; d[q + 3] = 255;
      q += 4;
    }
  }
}
