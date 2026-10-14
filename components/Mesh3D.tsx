'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LabelMap, Role, Volume } from '@/lib/types';

type Group = 'muscle' | 'fat' | 'bone' | 'other';
const GROUP_OF: Record<Role, Group> = { muscle: 'muscle', sat: 'fat', vat: 'fat', imat: 'fat', bone: 'bone', other: 'other' };
const OPACITY: Record<Role, number> = { muscle: 0.55, sat: 0.16, vat: 0.4, imat: 0.6, bone: 1, other: 0.5 };
const MAX_DIM = 112;
const BONE_HU = 250;
const MIN_BONE_PIECE = 40;
const BONE_COLOR = 'rgb(226,230,240)';

interface Props {
  vol: Volume | null;
  mask: Uint8Array | null;
  labels: LabelMap;
  sliceK: number;
  l3: number | null;
}

/**
 * Surface mesh of each label from the (downsampled) mask: one quad for every voxel face that borders a different label.
 * Axes: +X patient left, +Y superior, +Z anterior, in millimetres, so the default camera looks at the patient from the front.
 */
function buildMeshes(vol: Volume, mask: Uint8Array, labels: LabelMap) {
  const f = Math.max(1, Math.ceil(Math.max(vol.nx, vol.ny) / MAX_DIM));
  const fz = Math.max(1, Math.min(Math.ceil(vol.nz / MAX_DIM) * 2, Math.round((f * vol.sx) / vol.sz)));
  const dx = Math.ceil(vol.nx / f), dy = Math.ceil(vol.ny / f), dz = Math.ceil(vol.nz / fz);
  const ds = new Uint8Array(dx * dy * dz);
  for (let k = 0; k < dz; k++) {
    const sk = Math.min(vol.nz - 1, k * fz + (fz >> 1));
    for (let j = 0; j < dy; j++) {
      const sj = Math.min(vol.ny - 1, j * f + (f >> 1));
      for (let i = 0; i < dx; i++) {
        const si = Math.min(vol.nx - 1, i * f + (f >> 1));
        ds[i + dx * (j + dy * k)] = mask[si + vol.nx * (sj + vol.ny * sk)];
      }
    }
  }
  // Most body-composition masks have no bone label. Then take bone from the CT itself:
  // the highest HU in each block ≥ BONE_HU, kept only inside the body outline and in connected pieces big enough
  // to be skeleton (drops contrast specks and calcifications). The table sits outside the outline.
  // A lone L3-vertebra landmark is not a skeleton, so it does not stop the CT-based bone.
  const hasBone = Object.values(labels).some((d) => d.role === 'bone' && d.name !== 'L3 vertebra');
  let boneDs: Uint8Array | null = null;
  if (!hasBone) {
    boneDs = new Uint8Array(dx * dy * dz);
    // Body outline per slice: a voxel counts as inside when it lies between the outermost mask voxels
    // of both its row and its column. This excludes the curved table under and beside the patient.
    const rMin = new Int32Array(dy), rMax = new Int32Array(dy), cMin = new Int32Array(dx), cMax = new Int32Array(dx);
    for (let k = 0; k < dz; k++) {
      rMin.fill(dx); rMax.fill(-1); cMin.fill(dy); cMax.fill(-1);
      let any = false;
      for (let j = 0; j < dy; j++)
        for (let i = 0; i < dx; i++)
          if (ds[i + dx * (j + dy * k)]) {
            any = true;
            if (i < rMin[j]) rMin[j] = i; if (i > rMax[j]) rMax[j] = i;
            if (j < cMin[i]) cMin[i] = j; if (j > cMax[i]) cMax[i] = j;
          }
      if (!any) continue;
      for (let j = 0; j < dy; j++)
        for (let i = rMin[j]; i <= rMax[j]; i++) {
          if (j < cMin[i] || j > cMax[i]) continue;
          let mx = -32768;
          for (let bk = k * fz; bk < Math.min(vol.nz, (k + 1) * fz); bk++)
            for (let bj = j * f; bj < Math.min(vol.ny, (j + 1) * f); bj++) {
              const row = vol.nx * (bj + vol.ny * bk);
              for (let bi = i * f; bi < Math.min(vol.nx, (i + 1) * f); bi++) {
                const v = vol.data[row + bi];
                if (v > mx) mx = v;
              }
            }
          if (mx >= BONE_HU) boneDs[i + dx * (j + dy * k)] = 1;
        }
    }
    keepLargeComponents(boneDs, dx, dy, dz, MIN_BONE_PIECE);
  }

  const hx = f * vol.sx, hy = f * vol.sy, hz = fz * vol.sz;
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= dx || j >= dy || k >= dz ? 0 : ds[i + dx * (j + dy * k)]);
  // corner (i,j,k) in voxel grid units → world
  const W = (i: number, j: number, k: number): [number, number, number] => [(i - dx / 2) * hx, (k - dz / 2) * hz, -(j - dy / 2) * hy];

  const per = new Map<number, { pos: number[]; nrm: number[]; idx: number[] }>();
  for (const L of Object.keys(labels).map(Number)) per.set(L, { pos: [], nrm: [], idx: [] });

  // faces: [neighbour offset, 4 corners, world normal]
  const FACES: [[number, number, number], [number, number, number][], [number, number, number]][] = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [1, 0, 0]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], [-1, 0, 0]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], [0, 0, -1]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, 0, 1]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [0, 1, 0]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [0, -1, 0]],
  ];
  for (let k = 0; k < dz; k++)
    for (let j = 0; j < dy; j++)
      for (let i = 0; i < dx; i++) {
        const L = ds[i + dx * (j + dy * k)];
        if (!L) continue;
        const g = per.get(L);
        if (!g) continue;
        for (const [o, corners, n] of FACES) {
          if (at(i + o[0], j + o[1], k + o[2]) === L) continue;
          const base = g.pos.length / 3;
          for (const c of corners) {
            g.pos.push(...W(i + c[0], j + c[1], k + c[2]));
            g.nrm.push(...n);
          }
          // corners are counter-clockwise seen from outside; the grid→world map is a proper rotation, so keep the order
          g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
  let bone: { pos: number[]; nrm: number[]; idx: number[] } | null = null;
  if (boneDs) {
    bone = { pos: [], nrm: [], idx: [] };
    const bat = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= dx || j >= dy || k >= dz ? 0 : boneDs![i + dx * (j + dy * k)]);
    for (let k = 0; k < dz; k++)
      for (let j = 0; j < dy; j++)
        for (let i = 0; i < dx; i++) {
          if (!boneDs[i + dx * (j + dy * k)]) continue;
          for (const [o, corners, n] of FACES) {
            if (bat(i + o[0], j + o[1], k + o[2])) continue;
            const base = bone.pos.length / 3;
            for (const c of corners) {
              bone.pos.push(...W(i + c[0], j + c[1], k + c[2]));
              bone.nrm.push(...n);
            }
            bone.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
  }
  return { per, bone, size: [dx * hx, dz * hz, dy * hy] as const, zOf: (k: number) => (k / fz - dz / 2 + 0.5 / fz) * hz };
}

/** Zero out 6-connected pieces smaller than minSize voxels. */
function keepLargeComponents(g: Uint8Array, dx: number, dy: number, dz: number, minSize: number) {
  const seen = new Uint8Array(g.length);
  const stack = new Int32Array(g.length);
  const piece: number[] = [];
  for (let s = 0; s < g.length; s++) {
    if (!g[s] || seen[s]) continue;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    piece.length = 0;
    while (top) {
      const v = stack[--top];
      piece.push(v);
      const i = v % dx, j = ((v / dx) | 0) % dy, k = (v / (dx * dy)) | 0;
      const nb = [i > 0 ? v - 1 : -1, i < dx - 1 ? v + 1 : -1, j > 0 ? v - dx : -1, j < dy - 1 ? v + dx : -1, k > 0 ? v - dx * dy : -1, k < dz - 1 ? v + dx * dy : -1];
      for (const w of nb) if (w >= 0 && g[w] && !seen[w]) { seen[w] = 1; stack[top++] = w; }
    }
    if (piece.length < minSize) for (const v of piece) g[v] = 0;
  }
}

export default function Mesh3D({ vol, mask, labels, sliceK, l3 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const three = useRef<{
    renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
    root: THREE.Group; plane: THREE.Mesh; l3Plane: THREE.LineSegments; render: () => void; radius: number; zOf: (k: number) => number;
  } | null>(null);
  const [show, setShow] = useState<Record<Group, boolean>>({ muscle: true, fat: true, bone: true, other: false });
  const [info, setInfo] = useState('');
  const [boneFromCt, setBoneFromCt] = useState(false);
  // Muscle is see-through so the skeleton shows; solid when isolated.
  const [muscleSolid, setMuscleSolid] = useState(false);
  const [error, setError] = useState('');

  // scene setup
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch {
      setError('WebGL is not available in this browser, so the 3D view is off.');
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x05080c);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 1.2, 2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(-1.5, -0.5, -1);
    scene.add(rim);
    const root = new THREE.Group();
    scene.add(root);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xf0b44c, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);
    const l3Plane = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
    );
    l3Plane.rotation.x = -Math.PI / 2;
    scene.add(l3Plane);
    const axes = new THREE.AxesHelper(40);
    scene.add(axes);

    const controls = new OrbitControls(camera, renderer.domElement);
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    three.current = { renderer, scene, camera, controls, root, plane, l3Plane, render, radius: 300, zOf: () => 0 };
    resize();
    return () => {
      ro.disconnect();
      controls.dispose();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      three.current = null;
    };
  }, []);

  // (re)build meshes when the mask or label roles change
  const roleKey = Object.entries(labels).map(([L, d]) => `${L}:${d.role}:${d.color.join(',')}`).join('|');
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    for (const c of [...t.root.children]) {
      t.root.remove(c);
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    if (!vol || !mask) {
      setInfo('');
      t.render();
      return;
    }
    const t0 = performance.now();
    const { per, bone, size, zOf } = buildMeshes(vol, mask, labels);
    let faces = 0;
    // draw opaque first, then translucent from inner to outer
    const order = [...per.entries()].sort((a, b) => OPACITY[labels[a[0]].role] < OPACITY[labels[b[0]].role] ? 1 : -1);
    order.forEach(([L, g], i) => {
      if (!g.idx.length) return;
      faces += g.idx.length / 6;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
      geo.setIndex(g.idx);
      const d = labels[L];
      const op = OPACITY[d.role];
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(`rgb(${d.color.join(',')})`),
        transparent: op < 1,
        opacity: op,
        depthWrite: op >= 1,
        side: op < 1 ? THREE.DoubleSide : THREE.FrontSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = i;
      m.userData.group = GROUP_OF[d.role];
      m.userData.role = d.role;
      t.root.add(m);
    });
    if (bone && bone.idx.length) {
      faces += bone.idx.length / 6;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bone.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(bone.nrm, 3));
      geo.setIndex(bone.idx);
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color(BONE_COLOR) }));
      m.renderOrder = -1;
      m.userData.group = 'bone';
      t.root.add(m);
    }
    setBoneFromCt(!!bone);
    t.plane.scale.set(size[0] * 1.1, size[2] * 1.1, 1);
    t.l3Plane.scale.set(size[0] * 1.1, size[2] * 1.1, 1);
    t.radius = Math.max(...size) * 1.6;
    t.zOf = zOf;
    setInfo(`${faces.toLocaleString()} faces · built in ${(performance.now() - t0).toFixed(0)} ms`);
    preset('iso');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vol, mask, roleKey]);

  // visibility and planes
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.root.children.forEach((c) => {
      c.visible = show[c.userData.group as Group];
      if (c instanceof THREE.Mesh && c.userData.role === 'muscle') {
        const mat = c.material as THREE.MeshLambertMaterial;
        mat.opacity = muscleSolid ? 1 : OPACITY.muscle;
        mat.transparent = !muscleSolid;
        mat.depthWrite = muscleSolid;
        mat.side = muscleSolid ? THREE.FrontSide : THREE.DoubleSide;
        mat.needsUpdate = true;
      }
    });
    t.plane.position.y = t.zOf(sliceK);
    t.l3Plane.visible = l3 != null;
    if (l3 != null) t.l3Plane.position.y = t.zOf(l3);
    t.render();
  }, [show, muscleSolid, sliceK, l3, roleKey, vol, mask]);

  function preset(v: 'anterior' | 'posterior' | 'lateral' | 'iso') {
    const t = three.current;
    if (!t) return;
    const r = t.radius;
    const pos = { anterior: [0, 0, r], posterior: [0, 0, -r], lateral: [r, 0, 0], iso: [r * 0.55, r * 0.35, r * 0.75] }[v];
    t.camera.position.set(pos[0], pos[1], pos[2]);
    t.controls.target.set(0, 0, 0);
    t.camera.near = r / 100;
    t.camera.far = r * 10;
    t.camera.updateProjectionMatrix();
    t.controls.update();
    t.render();
  }

  const toggle = (g: Group) => setShow((s) => ({ ...s, [g]: !s[g] }));

  return (
    <div className="mesh3d">
      <div className="mesh-host" ref={hostRef}>
        {error && <p className="mesh-msg">{error}</p>}
        {!error && !mask && <p className="mesh-msg">Load a segmentation to build the 3D model.</p>}
        <div className="mesh-views">
          {(['anterior', 'posterior', 'lateral', 'iso'] as const).map((v) => (
            <button type="button" key={v} onClick={() => preset(v)}>{v === 'iso' ? 'Iso' : v[0].toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
        <div className="mesh-hint">Drag to orbit · scroll to zoom · right-drag to pan</div>
      </div>
      <div className="row mesh-controls">
        <button type="button" className="btn small" aria-pressed={show.muscle && !show.fat && !show.bone} onClick={() => { setShow({ muscle: true, fat: false, bone: false, other: false }); setMuscleSolid(true); }}>Isolate muscle</button>
        <label className="check"><input type="checkbox" checked={show.muscle} onChange={() => toggle('muscle')} />Muscle</label>
        <label className="check"><input type="checkbox" checked={muscleSolid} onChange={(e) => setMuscleSolid(e.target.checked)} />Solid muscle</label>
        <label className="check"><input type="checkbox" checked={show.fat} onChange={() => toggle('fat')} />Fat</label>
        <label className="check" title={boneFromCt ? `The mask has no bone label, so bone is taken from CT voxels ≥ ${BONE_HU} HU` : undefined}><input type="checkbox" checked={show.bone} onChange={() => toggle('bone')} />{boneFromCt ? `Bone (CT ≥ ${BONE_HU} HU)` : 'Bone'}</label>
        <label className="check"><input type="checkbox" checked={show.other} onChange={() => toggle('other')} />Other</label>
        <button type="button" className="btn small" onClick={() => { setShow({ muscle: true, fat: true, bone: true, other: false }); setMuscleSolid(false); preset('iso'); }}>Reset view</button>
        <span className="note sp">{info}{info && ' · amber plane = current axial, outline = L3'}</span>
      </div>
    </div>
  );
}
