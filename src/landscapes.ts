import { between, makeNoise, makeRivers, makeRng, type Rng } from './noise';

export type LandscapeId = 'ackley' | 'rastrigin' | 'beale' | 'rosenbrock' | 'himmelblau' | 'wilds';

export interface Point2 {
  x: number;
  z: number;
}

export interface Landscape {
  id: LandscapeId;
  name: string;
  description: string;
  /** The loss function, in function coordinates. */
  f: (x: number, z: number) => number;
  xRange: [number, number];
  zRange: [number, number];
  /** Maps a raw loss value to a terrain height (world units). Must be monotonic. */
  height: (loss: number) => number;
  globalMinima: Point2[];
  /** Suggested learning rates per optimizer, since gradient magnitudes differ wildly. */
  lr: Record<OptimizerId, number>;
}

export type OptimizerId = 'gd' | 'momentum' | 'rmsprop' | 'adam';

const TAU = 2 * Math.PI;
// Function declarations are hoisted, so this can be built before LANDSCAPES.
const WILDS_DEFAULT = makeWilds(makeRng(1));

export const LANDSCAPES: Record<LandscapeId, Landscape> = {
  ackley: {
    id: 'ackley',
    name: 'Ackley',
    description: 'A ripply funnel with one deep hole at the bottom.',
    f: (x, z) =>
      -20 * Math.exp(-0.2 * Math.sqrt(0.5 * (x * x + z * z))) -
      Math.exp(0.5 * (Math.cos(TAU * x) + Math.cos(TAU * z))) +
      Math.E +
      20,
    // Zoomed in from the textbook ±32 (and our old ±6) so the ripples are spaced out.
    xRange: [-3.2, 3.2],
    zRange: [-3.2, 3.2],
    height: (l) => l * 0.85,
    globalMinima: [{ x: 0, z: 0 }],
    lr: { gd: 0.02, momentum: 0.01, rmsprop: 0.02, adam: 0.05 },
  },
  rastrigin: {
    id: 'rastrigin',
    name: 'Rastrigin',
    description: 'An egg-crate of local minima. Tests global search.',
    f: (x, z) => 20 + x * x - 10 * Math.cos(TAU * x) + z * z - 10 * Math.cos(TAU * z),
    xRange: [-2.6, 2.6],
    zRange: [-2.6, 2.6],
    height: (l) => l * 0.2,
    globalMinima: [{ x: 0, z: 0 }],
    lr: { gd: 0.002, momentum: 0.001, rmsprop: 0.02, adam: 0.05 },
  },
  beale: {
    id: 'beale',
    name: 'Beale',
    description: 'Flat valleys with steep walls, cut by winding, branching river channels.',
    f: (x, z) =>
      (1.5 - x + x * z) ** 2 + (2.25 - x + x * z * z) ** 2 + (2.625 - x + x * z * z * z) ** 2,
    xRange: [-4.5, 4.5],
    zRange: [-4.5, 4.5],
    height: (l) => Math.log1p(l),
    globalMinima: [{ x: 3, z: 0.5 }],
    lr: { gd: 0.0005, momentum: 0.0002, rmsprop: 0.01, adam: 0.05 },
  },
  rosenbrock: {
    id: 'rosenbrock',
    name: 'Rosenbrock',
    description: 'A long, curved banana valley, with river channels winding down into it.',
    f: (x, z) => (1 - x) ** 2 + 100 * (z - x * x) ** 2,
    xRange: [-2, 2],
    zRange: [-1, 3],
    height: (l) => Math.log1p(l) * 1.5,
    globalMinima: [{ x: 1, z: 1 }],
    lr: { gd: 0.001, momentum: 0.0005, rmsprop: 0.005, adam: 0.02 },
  },
  himmelblau: {
    id: 'himmelblau',
    name: 'Himmelblau',
    description: 'Four equally good global minima. Where you end up depends on where you start.',
    f: (x, z) => (x * x + z - 11) ** 2 + (x + z * z - 7) ** 2,
    xRange: [-5, 5],
    zRange: [-5, 5],
    height: (l) => Math.log1p(l) * 1.8,
    globalMinima: [
      { x: 3, z: 2 },
      { x: -2.805118, z: 3.131312 },
      { x: -3.77931, z: -3.283186 },
      { x: 3.584428, z: -1.848126 },
    ],
    lr: { gd: 0.005, momentum: 0.002, rmsprop: 0.02, adam: 0.05 },
  },
  wilds: {
    id: 'wilds',
    name: 'Wilds',
    description: 'Random layered terrain: ranges, mesas, dunes, craters, rivers. The goal hides somewhere new.',
    f: WILDS_DEFAULT.f,
    xRange: [-5, 5],
    zRange: [-5, 5],
    height: (l) => l * 1.2,
    globalMinima: [WILDS_DEFAULT.min],
    lr: { gd: 0.02, momentum: 0.01, rmsprop: 0.02, adam: 0.05 },
  },
};

export const LANDSCAPE_ORDER: LandscapeId[] = ['wilds', 'ackley', 'rastrigin', 'beale', 'rosenbrock', 'himmelblau'];

type GoalStyle = 'pit' | 'basin' | 'gully' | 'crater' | 'canyon' | 'summit' | 'hidden';

/**
 * Procedural terrain, built in layers that compose:
 * 1. Macro shape: rolling ground plus a random subset of plateaus, mountain ranges, mesas,
 *    hills and a tilt.
 * 2. Details, each confined to its own patches and to the elevations it suits: dunes settle in
 *    the lowlands, spires on high ground, craters, sinkholes and ridges scattered in regions,
 *    terraces cut into some zones. They ride on top of the macro shape, so a crater can sit on
 *    a plateau or dunes can fill a valley between ranges.
 * 3. Rivers carve through all of it.
 * 4. The goal: one of several kinds of global minimum at a random spot. The whole terrain is
 *    multiplied by a mask that is exactly zero only there, and everything is kept ≥ ~0.1
 *    elsewhere, so it is the one global minimum and every other dip is a local one.
 */
function makeWilds(rng: Rng, k = 1): { f: (x: number, z: number) => number; min: Point2 } {
  // `k` scales the map's area (k² times the land, same feature sizes). The map always contains
  // the minimum but slides by up to ~0.4 of its width when it's placed, so features go a little
  // wider than the map itself.
  const R = 8 * k;
  const pt = () => ({ x: between(rng, -R, R), z: between(rng, -R, R) });
  const count = (lo: number, hi: number) => Math.floor(between(rng, lo, hi + 1) * k * k);
  const sigmoid = (t: number) => 1 / (1 + Math.exp(-t));
  type Field = (x: number, z: number) => number;
  /** A bump that is exactly zero beyond `cut` radii, so far-away features cost nothing. */
  const blob = (cx: number, cz: number, s: number, cut = 3.5): Field => {
    const cut2 = (cut * s) ** 2, floor = Math.exp(-(cut * cut) / 2);
    return (x, z) => {
      const d2 = (x - cx) ** 2 + (z - cz) ** 2;
      return d2 > cut2 ? 0 : Math.exp(-d2 / (2 * s * s)) - floor;
    };
  };
  /** Low-frequency patches covering roughly `cover` of the land, with soft borders. */
  const region = (cover: number): Field => {
    const n = makeNoise(rng), fq = between(rng, 0.08, 0.18), thr = 0.9 * (0.5 - cover);
    return (x, z) => sigmoid((n(x * fq, z * fq) - thr) / 0.08);
  };
  const sum = (fields: Field[]): Field => (x, z) => {
    let v = 0;
    for (const f of fields) v += f(x, z);
    return v;
  };
  /**
   * A spatial index for features that only matter within some radius, so a height lookup only
   * evaluates the handful nearby however many there are on a big map.
   */
  const scatter = <F extends (...a: any[]) => number>() => {
    const B = 3, buckets = new Map<number, F[]>();
    const key = (bx: number, bz: number) => bx * 100003 + bz;
    return {
      add(cx: number, cz: number, radius: number, fn: F) {
        for (let bx = Math.floor((cx - radius) / B); bx <= Math.floor((cx + radius) / B); bx++)
          for (let bz = Math.floor((cz - radius) / B); bz <= Math.floor((cz + radius) / B); bz++) {
            const list = buckets.get(key(bx, bz));
            if (list) list.push(fn);
            else buckets.set(key(bx, bz), [fn]);
          }
      },
      at(x: number, z: number) {
        return buckets.get(key(Math.floor(x / B), Math.floor(z / B)));
      },
    };
  };

  const min = { x: between(rng, -3.5 * k, 3.5 * k), z: between(rng, -3.5 * k, 3.5 * k) };
  const styles: GoalStyle[] = ['pit', 'basin', 'gully', 'crater', 'canyon', 'summit', 'hidden'];
  const goal = styles[Math.floor(rng() * styles.length)];

  // ---- 1. macro shape ----
  const macro: Field[] = [];
  const macroLocal = scatter<Field>();
  const n1 = makeNoise(rng), n2 = makeNoise(rng), n3 = makeNoise(rng);
  const rough = between(rng, 0.3, 2.2), scale = between(rng, 0.12, 0.5);
  macro.push((x, z) =>
    rough * (n1(x * scale, z * scale) + 0.5 * n2(x * scale * 2.1, z * scale * 2.1) + 0.25 * n3(x * scale * 4.3, z * scale * 4.3)),
  );
  const macroFamilies: (() => void)[] = [
    function plateaus() {
      // Big irregular tablelands with cliff edges, from thresholded noise.
      const n = makeNoise(rng), fq = between(rng, 0.12, 0.25), thr = between(rng, -0.2, 0.3);
      const h = between(rng, 1.5, 3.5), sharp = between(rng, 0.03, 0.1);
      macro.push((x, z) => h * sigmoid((n(x * fq, z * fq) - thr) / sharp));
    },
    function mountains() {
      // Ridged noise: sharp crests that branch like a range, only in some parts of the map.
      const a = region(between(rng, 0.3, 0.7));
      const m1 = makeNoise(rng), m2 = makeNoise(rng), fq = between(rng, 0.15, 0.35), h = between(rng, 2, 5);
      const ridge = (v: number) => (1 - Math.sqrt(v * v + 0.004)) ** 2;
      macro.push((x, z) => h * a(x, z) * (ridge(m1(x * fq, z * fq)) + 0.4 * ridge(m2(x * fq * 2.2, z * fq * 2.2))));
    },
    function mesas() {
      for (let i = count(1, 5); i > 0; i--) {
        const c = pt(), r0 = between(rng, 0.8, 2.6), h = between(rng, 1.5, 3.5), edge = makeNoise(rng);
        const sharp = between(rng, 0.1, 0.3);
        macroLocal.add(c.x, c.z, r0 + 0.5 + 12 * sharp, (x, z) => {
          const r = Math.hypot(x - c.x, z - c.z) + 0.4 * edge(x * 0.9, z * 0.9);
          return h * sigmoid((r0 - r) / sharp);
        });
      }
    },
    function hills() {
      for (let i = count(6, 22); i > 0; i--) {
        const c = pt(), s = between(rng, 0.6, 2.4), a = between(rng, 0.8, 4), b = blob(c.x, c.z, s);
        macroLocal.add(c.x, c.z, 3.5 * s, (x, z) => a * b(x, z));
      }
    },
    function tilt() {
      const ang = rng() * 2 * Math.PI, a = between(rng, 0.1, 0.3);
      macro.push((x, z) => a * (x * Math.cos(ang) + z * Math.sin(ang)));
    },
  ];
  const macroOn = macroFamilies.map(() => rng() < 0.45);
  if (!macroOn.some(Boolean)) macroOn[Math.floor(rng() * macroOn.length)] = true;
  macroFamilies.forEach((fam, i) => macroOn[i] && fam());

  // Goal-specific landforms join the macro shape.
  if (goal === 'summit') {
    // A mesa with the goal sunk into its top: you have to climb before you can descend.
    const r0 = between(rng, 1.3, 2.2), h = between(rng, 2.5, 4.5), edge = makeNoise(rng);
    macro.push((x, z) => {
      const r = Math.hypot(x - min.x, z - min.z) + 0.25 * edge(x * 0.9, z * 0.9);
      return h * sigmoid((r0 - r) / 0.15);
    });
  } else if (goal === 'crater') {
    const r0 = between(rng, 1.4, 2.6), w = between(rng, 0.3, 0.5), h = between(rng, 2, 4);
    macro.push((x, z) => h * Math.exp(-(((Math.hypot(x - min.x, z - min.z) - r0) / w) ** 2)));
  }
  const macroGlobal = sum(macro);
  const macroField: Field = (x, z) => {
    let v = macroGlobal(x, z);
    const near = macroLocal.at(x, z);
    if (near) for (const f of near) v += f(x, z);
    return v;
  };

  // Where "low" and "high" ground is, for the details' elevation preferences.
  const samples: number[] = [];
  const nSamples = Math.min(2000, Math.round(400 * k * k));
  for (let i = 0; i < nSamples; i++) samples.push(macroField(between(rng, -R, R), between(rng, -R, R)));
  samples.sort((a, b) => a - b);
  const lowQ = samples[Math.floor(nSamples * 0.3)], highQ = samples[Math.floor(nSamples * 0.7)];
  const spread = Math.max(0.2, (highQ - lowQ) / 2);
  const lowland = (m: number) => sigmoid((lowQ + spread - m) / (0.4 * spread));
  const highland = (m: number) => sigmoid((m - highQ + spread) / (0.4 * spread));

  // ---- 2. details, confined to patches and elevations (M is the macro height there) ----
  type Detail = (x: number, z: number, M: number) => number;
  const details: Detail[] = [];
  const detailLocal = scatter<Field>();
  const detailFamilies: (() => void)[] = [
    function dunes() {
      const where = region(between(rng, 0.4, 0.8));
      const ang = rng() * Math.PI, cx = Math.cos(ang), cz = Math.sin(ang);
      const k = (2 * Math.PI) / between(rng, 1.2, 3), a = between(rng, 0.6, 1.8);
      const warp = makeNoise(rng), wa = between(rng, 1, 3);
      details.push((x, z, M) => {
        const m = lowland(M) * where(x, z);
        return m < 1e-3 ? 0 : m * a * Math.sin(k * (x * cx + z * cz) + wa * warp(x * 0.2, z * 0.2)) ** 2;
      });
    },
    function spires() {
      for (let i = count(3, 10); i > 0; i--) {
        const c = pt(), s = between(rng, 0.3, 0.8), a = between(rng, 3, 7) * highland(macroField(c.x, c.z));
        // Faded to exactly zero at 8 radii so it can live in the spatial index.
        const cut2 = 64 * s * s;
        if (a > 0.1)
          detailLocal.add(c.x, c.z, 8 * s, (x, z) => {
            const d2 = (x - c.x) ** 2 + (z - c.z) ** 2;
            return d2 >= cut2 ? 0 : ((a / (1 + d2 / (s * s)) ** 1.5) * (1 - d2 / cut2) ** 2);
          });
      }
    },
    function craters() {
      const where = region(between(rng, 0.3, 0.7));
      for (let i = count(2, 9); i > 0; i--) {
        const c = pt(), r0 = between(rng, 0.6, 2.2), w = between(rng, 0.2, 0.45), h = between(rng, 1.5, 3.5);
        const cut = r0 + 4 * w, strength = where(c.x, c.z);
        if (strength < 0.05) continue;
        detailLocal.add(c.x, c.z, cut, (x, z) => {
          const r = Math.hypot(x - c.x, z - c.z);
          if (r > cut) return 0;
          return strength * h * (Math.exp(-(((r - r0) / w) ** 2)) - 0.85 * Math.exp(-((r / (0.6 * r0)) ** 2)));
        });
      }
    },
    function sinkholes() {
      const where = region(between(rng, 0.3, 0.7));
      for (let i = count(4, 14); i > 0; i--) {
        const c = pt(), s = between(rng, 0.25, 1), a = between(rng, 1, 3.5) * where(c.x, c.z), b = blob(c.x, c.z, s);
        if (a > 0.05) detailLocal.add(c.x, c.z, 3.5 * s, (x, z) => -a * b(x, z));
      }
    },
    function ridges() {
      const where = region(between(rng, 0.4, 0.8));
      for (let i = count(2, 6); i > 0; i--) {
        const a0 = pt(), ang = rng() * Math.PI, len = between(rng, 3, 10);
        const dx = Math.cos(ang) * len, dz = Math.sin(ang) * len;
        const w = between(rng, 0.25, 0.9), h = between(rng, 1.5, 4) * (rng() < 0.3 ? -0.7 : 1); // some are trenches
        detailLocal.add(a0.x + dx / 2, a0.z + dz / 2, len / 2 + 3 * w, (x, z) => {
          const t = Math.min(1, Math.max(0, ((x - a0.x) * dx + (z - a0.z) * dz) / (len * len)));
          const d2 = (x - a0.x - t * dx) ** 2 + (z - a0.z - t * dz) ** 2;
          return d2 > 9 * w * w ? 0 : h * where(x, z) * Math.exp(-d2 / (w * w));
        });
      }
    },
  ];
  const detailOn = detailFamilies.map(() => rng() < 0.5);
  if (!detailOn.some(Boolean)) detailOn[Math.floor(rng() * detailOn.length)] = true;
  detailFamilies.forEach((fam, i) => detailOn[i] && fam());
  const detailField: Detail = (x, z, M) => {
    let v = 0;
    for (const d of details) v += d(x, z, M);
    const near = detailLocal.at(x, z);
    if (near) for (const f of near) v += f(x, z);
    return v;
  };

  // Terraces: a smooth, still-monotonic staircase, cut into some zones of the macro shape.
  const terraces = rng() < 0.35 ? region(between(rng, 0.3, 0.7)) : null;
  const step = between(rng, 0.6, 1.4), flat = between(rng, 0.6, 0.95);

  // ---- 3. rivers ----
  const hasRivers = goal === 'canyon' || rng() < 0.55;
  const rivers = makeRivers(rng, 12, goal === 'canyon' ? [0.8, 0.95] : [0.4, 0.92], goal === 'canyon' ? min : undefined);

  // ---- 4. the goal ----
  let mask: Field;
  switch (goal) {
    case 'basin': {
      // A flat-bottomed dry lake with a firm rim.
      const rho = between(rng, 0.9, 2);
      mask = (x, z) => {
        const t = ((x - min.x) ** 2 + (z - min.z) ** 2) / (rho * rho);
        return (t * t) / (1 + t * t);
      };
      break;
    }
    case 'gully': {
      // A long trough; the lowest point hides somewhere along it.
      const ang = rng() * Math.PI, c = Math.cos(ang), s = Math.sin(ang);
      const len = between(rng, 2, 4.5), w = between(rng, 0.35, 0.8);
      mask = (x, z) => {
        const dx = x - min.x, dz = z - min.z;
        return 1 - Math.exp(-(((c * dx + s * dz) / len) ** 2) - ((-s * dx + c * dz) / w) ** 2);
      };
      break;
    }
    case 'hidden': {
      // A broad, gentle low that blends into the terrain around it.
      const sig2 = between(rng, 2, 3.5) ** 2;
      mask = (x, z) => 1 - Math.exp(-((x - min.x) ** 2 + (z - min.z) ** 2) / sig2);
      break;
    }
    default: {
      // Pit, crater floor, canyon bed, mesa-top sinkhole: a funnel of varying width.
      const sig = goal === 'summit' ? between(rng, 0.3, 0.6) : goal === 'crater' ? between(rng, 1, 1.8) : between(rng, 0.4, 1.3);
      mask = (x, z) => 1 - Math.exp(-((x - min.x) ** 2 + (z - min.z) ** 2) / (sig * sig));
    }
  }

  const base = between(rng, 1.8, 3);
  const bowl = goal === 'hidden' ? 0 : between(rng, 0, 0.025) / (k * k);
  return {
    min,
    f: (x, z) => {
      const M = macroField(x, z);
      let raw = base + M;
      if (terraces) {
        const k = terraces(x, z);
        if (k > 1e-3) raw -= (k * flat * step * Math.sin((2 * Math.PI * raw) / step)) / (2 * Math.PI);
      }
      raw += detailField(x, z, M);
      let g = 0.25 + Math.log1p(Math.exp(1.2 * raw)) / 1.2;
      if (hasRivers) g *= Math.exp(-rivers(x, z));
      const r2 = (x - min.x) ** 2 + (z - min.z) ** 2;
      // The pin keeps wide, flat goals (basin, gully, hidden) from having a large near-zero
      // floor: the loss only drops under the "found it" threshold right at the minimum.
      return g * mask(x, z) + bowl * r2 + 0.03 * (1 - Math.exp(-r2 / 0.3));
    },
  };
}

/**
 * The landscape for one game: the textbook function plus seeded variety.
 * - Every landscape: a random relief, so steepness differs between games.
 * - Ackley, Rastrigin: a random rotation about the minimum, so the rows of bumps point anywhere.
 * - Beale, Rosenbrock: carved river channels (multiplying the loss keeps the minimum global).
 * - Wilds: a whole new terrain.
 */
export function makeLandscape(id: LandscapeId, seed: number, mapSize = 50): Landscape {
  /** How much bigger than the original 50-unit map this one is. */
  const k = mapSize / 50;
  const rng = makeRng(seed);
  const base = LANDSCAPES[id];
  let f = base.f;
  let globalMinima = base.globalMinima;
  let xRange = base.xRange, zRange = base.zRange;
  const g = base.globalMinima[0];
  const span = Math.max(base.xRange[1] - base.xRange[0], base.zRange[1] - base.zRange[0]);

  if (id === 'ackley' || id === 'rastrigin') {
    // Rotate about the minimum, then bend the rows with a gentle warp that is zero at the
    // minimum. The warp's slope stays well under 1, so it can't fold a second point onto it.
    const a = rng() * Math.PI, c = Math.cos(a), s = Math.sin(a);
    const wx = makeNoise(rng), wz = makeNoise(rng);
    const amp = between(rng, 0.2, 0.4), fq = between(rng, 0.25, 0.4);
    const w0x = wx(g.x * fq, g.z * fq), w0z = wz(g.x * fq, g.z * fq);
    const f0 = f;
    f = (x, z) => {
      const px = x + amp * (wx(x * fq, z * fq) - w0x), pz = z + amp * (wz(x * fq, z * fq) - w0z);
      const dx = px - g.x, dz = pz - g.z;
      return f0(g.x + c * dx - s * dz, g.z + s * dx + c * dz);
    };
  } else if (id === 'beale' || id === 'rosenbrock') {
    // Carving fades out where the loss is already low, so the valley floors (and the minimum
    // itself) are left alone and no carved pit can get close to the global minimum's loss.
    const rivers = makeRivers(rng, span, [0.85, 0.97]);
    const f0 = f;
    f = (x, z) => {
      const l = f0(x, z);
      return l * Math.exp((-rivers(x, z) * l) / (l + 0.5));
    };
  } else if (id === 'wilds') {
    // Wilds grows more land on a bigger map instead of stretching it.
    const w = makeWilds(rng, k);
    f = w.f;
    globalMinima = [w.min];
    xRange = [-5 * k, 5 * k];
    zRange = [-5 * k, 5 * k];
  }

  // Relief: h' = H·k·(h/H)^γ keeps 0 at 0 and stays monotonic, but reshapes how quickly
  // the ground climbs (γ) and how tall it gets overall (k). H is the textbook height scale.
  const hs: number[] = [];
  for (let i = 0; i <= 16; i++)
    for (let j = 0; j <= 16; j++)
      hs.push(base.height(base.f(base.xRange[0] + (i / 16) * (base.xRange[1] - base.xRange[0]),
                                 base.zRange[0] + (j / 16) * (base.zRange[1] - base.zRange[0]))));
  hs.sort((a, b) => a - b);
  const H = Math.max(1e-6, hs[Math.floor(hs.length * 0.9)]);
  const relief = Math.exp(between(rng, -0.3, 0.3)), gamma = between(rng, 0.75, 1.3);
  // The textbook functions stretch to fill a bigger map, so their heights stretch with it to
  // keep the same steepness.
  const lift = id === 'wilds' ? 1 : k;
  const height = (l: number) => lift * H * relief * Math.max(0, base.height(l) / H) ** gamma;

  return { ...base, f, height, globalMinima, xRange, zRange };
}

export type MinPlacement = 'random' | 'center' | 'pick' | 'natural';

export const PLACEMENTS: { id: MinPlacement; label: string; hint: string }[] = [
  { id: 'random', label: 'Random', hint: 'Somewhere new every game. The terrain around it shifts to match.' },
  { id: 'center', label: 'Center', hint: 'Always in the middle of the map.' },
  { id: 'pick', label: 'Pick', hint: 'Click the explored map to place it.' },
  { id: 'natural', label: 'Natural', hint: "Wherever the textbook function puts it." },
];

/**
 * Slides the function under the map so its (first) global minimum lands at (u, v), given as
 * fractions of the domain. Minima that slide off the map are dropped from the list.
 */
export function placeMinimum(L: Landscape, u: number, v: number): Landscape {
  const g = L.globalMinima[0];
  const dx = g.x - (L.xRange[0] + u * (L.xRange[1] - L.xRange[0]));
  const dz = g.z - (L.zRange[0] + v * (L.zRange[1] - L.zRange[0]));
  const inside = (p: Point2) =>
    p.x >= L.xRange[0] && p.x <= L.xRange[1] && p.z >= L.zRange[0] && p.z <= L.zRange[1];
  return {
    ...L,
    f: (x, z) => L.f(x + dx, z + dz),
    globalMinima: L.globalMinima.map((p) => ({ x: p.x - dx, z: p.z - dz })).filter(inside),
  };
}

export function gradient(L: Landscape, x: number, z: number, h = 1e-5): Point2 {
  return {
    x: (L.f(x + h, z) - L.f(x - h, z)) / (2 * h),
    z: (L.f(x, z + h) - L.f(x, z - h)) / (2 * h),
  };
}

function hessian(L: Landscape, x: number, z: number, h = 1e-4) {
  const f0 = L.f(x, z);
  const fxx = (L.f(x + h, z) - 2 * f0 + L.f(x - h, z)) / (h * h);
  const fzz = (L.f(x, z + h) - 2 * f0 + L.f(x, z - h)) / (h * h);
  const fxz =
    (L.f(x + h, z + h) - L.f(x + h, z - h) - L.f(x - h, z + h) + L.f(x - h, z - h)) / (4 * h * h);
  return { fxx, fzz, fxz };
}

export function clampToDomain(L: Landscape, p: Point2): Point2 {
  return {
    x: Math.min(L.xRange[1], Math.max(L.xRange[0], p.x)),
    z: Math.min(L.zRange[1], Math.max(L.zRange[0], p.z)),
  };
}

export interface LocalMin extends Point2 {
  loss: number;
  converged: boolean;
}

/**
 * Finds the local minimum whose basin contains (x, z): damped Newton steps when the
 * Hessian is positive definite, gradient steps otherwise, both with backtracking.
 */
export function findLocalMin(L: Landscape, x: number, z: number, maxIter = 200): LocalMin {
  let p = { x, z };
  let fp = L.f(p.x, p.z);
  // Capped: Wilds' domain grows with the map, but its features don't.
  const maxStep = 0.03 * Math.min(10, Math.max(L.xRange[1] - L.xRange[0], L.zRange[1] - L.zRange[0]));
  for (let i = 0; i < maxIter; i++) {
    const g = gradient(L, p.x, p.z);
    const gn = Math.hypot(g.x, g.z);
    if (gn < 1e-7) return { ...p, loss: fp, converged: true };

    const { fxx, fzz, fxz } = hessian(L, p.x, p.z);
    const det = fxx * fzz - fxz * fxz;
    let d: Point2;
    if (fxx > 0 && det > 1e-12) {
      d = { x: -(fzz * g.x - fxz * g.z) / det, z: -(-fxz * g.x + fxx * g.z) / det };
      // Near an inflection the Newton step can be huge and leap into another basin.
      const len = Math.hypot(d.x, d.z);
      if (len > maxStep) d = { x: (d.x * maxStep) / len, z: (d.z * maxStep) / len };
    } else {
      // Steepest descent, sized so the first try moves at most ~0.1 units.
      const s = Math.min(1, 0.1 / gn);
      d = { x: -g.x * s, z: -g.z * s };
    }

    let t = 1;
    let next = clampToDomain(L, { x: p.x + d.x, z: p.z + d.z });
    let fn = L.f(next.x, next.z);
    while (fn > fp - 1e-4 * t * gn * Math.hypot(d.x, d.z) && t > 1e-8) {
      t *= 0.5;
      next = clampToDomain(L, { x: p.x + t * d.x, z: p.z + t * d.z });
      fn = L.f(next.x, next.z);
    }
    const moved = Math.hypot(next.x - p.x, next.z - p.z);
    if (fn > fp) return { ...p, loss: fp, converged: gn < 1e-3 };
    p = next;
    fp = fn;
    if (moved < 1e-9) return { ...p, loss: fp, converged: gn < 1e-3 };
  }
  const g = gradient(L, p.x, p.z);
  return { ...p, loss: fp, converged: Math.hypot(g.x, g.z) < 1e-3 };
}

export interface OptStep extends Point2 {
  loss: number;
}

export const OPTIMIZERS: { id: OptimizerId; label: string }[] = [
  { id: 'gd', label: 'Gradient Descent' },
  { id: 'momentum', label: 'Momentum (β=0.9)' },
  { id: 'rmsprop', label: 'RMSProp' },
  { id: 'adam', label: 'Adam' },
];

export type Schedule = 'constant' | 'cosine' | 'restarts' | 'cyclic';

export const SCHEDULES: { id: Schedule; label: string; hint: string }[] = [
  { id: 'constant', label: 'Constant', hint: 'The same learning rate every step.' },
  { id: 'cosine', label: 'Cosine', hint: 'Warms up to 3× the rate, then cools to a crawl over one run: big hops first, settling at the end.' },
  { id: 'restarts', label: 'Restarts', hint: 'Cosine cool-downs that kick back up to 3× three times a run (warm restarts), so it can hop out of whatever it settled into.' },
  { id: 'cyclic', label: 'Cyclic', hint: 'Swings between ¼× and 3× the rate, three cycles a run.' },
];

/** Extra tricks for escaping local minima. They apply from the next step on. */
export interface OptTricks {
  schedule: Schedule;
  /** Steps in one run; schedules are laid out over it. */
  period: number;
  /** Annealed random jitter, 0 (off) to 1. */
  noise: number;
  /** Sharpness-aware minimization: follow the gradient at a nearby uphill point, which ignores narrow pits. */
  sam: boolean;
}

export const NO_TRICKS: OptTricks = { schedule: 'constant', period: 300, noise: 0, sam: false };

const PEAK = 3, FLOOR = 0.05;
/** Jitter size at full noise, and SAM's probe distance, as fractions of the feature scale. */
const NOISE = 0.05, SAM_RHO = 0.03;

/** Learning-rate multiplier at step t (1-based). */
export function scheduleFactor(schedule: Schedule, t: number, period: number): number {
  const P = Math.max(3, period);
  const cool = (u: number) => FLOOR + (PEAK - FLOOR) * 0.5 * (1 + Math.cos(Math.PI * Math.min(1, u)));
  switch (schedule) {
    case 'constant':
      return 1;
    case 'cosine': {
      const w = Math.max(1, Math.round(0.05 * P));
      return t <= w ? PEAK * (0.1 + (0.9 * t) / w) : cool((t - w) / (P - w));
    }
    case 'restarts': {
      const c = P / 3;
      return cool(((t - 1) % c) / c);
    }
    case 'cyclic': {
      const phase = ((t - 1) % (P / 3)) / (P / 3);
      return 0.25 + (PEAK - 0.25) * (1 - Math.abs(2 * phase - 1));
    }
  }
}

/**
 * An optimizer mid-run: keeps its position and internal state (momentum, second moments,
 * Adam's step count, the noise generator) so it can keep stepping from where it stopped.
 */
export class OptimizerRun {
  p: Point2;
  /** Steps taken so far. */
  t = 0;
  /** Set when the loss blew up; no further steps are taken. */
  diverged = false;
  private vx = 0; private vz = 0; // momentum / Adam first moment
  private sx = 0; private sz = 0; // RMSProp / Adam second moment
  private rng: Rng;
  /** Learning-rate multiplier used on the last step, from the schedule. */
  lrFactor = 1;
  /** Lowest point visited so far (the checkpoint you'd keep), and the step it was reached at. */
  best: OptStep & { t: number };

  constructor(
    readonly L: Landscape,
    start: Point2,
    readonly opt: OptimizerId,
  ) {
    this.p = { ...start };
    this.best = { ...start, loss: L.f(start.x, start.z), t: 0 };
    // Seeded from the start, so the same run (continued or not) jitters the same way.
    this.rng = makeRng(Math.floor(start.x * 7919 + start.z * 104729) ^ 0x5bd1e995);
  }

  /** Takes up to `steps` more steps and returns the new points (not the current one). */
  step(lr0: number, steps: number, tricks: OptTricks = NO_TRICKS): OptStep[] {
    const { L, opt } = this;
    const out: OptStep[] = [];
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    // Feature scale: the map's width, capped because Wilds grows land rather than features.
    const scale = Math.min(10, Math.max(L.xRange[1] - L.xRange[0], L.zRange[1] - L.zRange[0]));
    for (let i = 0; i < steps && !this.diverged; i++) {
      const t = ++this.t;
      this.lrFactor = scheduleFactor(tricks.schedule, t, tricks.period);
      const lr = lr0 * this.lrFactor;
      let g = gradient(L, this.p.x, this.p.z);
      if (tricks.sam) {
        const gn = Math.hypot(g.x, g.z);
        if (gn > 1e-12) {
          const rho = SAM_RHO * scale;
          g = gradient(L, this.p.x + (rho * g.x) / gn, this.p.z + (rho * g.z) / gn);
        }
      }
      let dx: number, dz: number;
      switch (opt) {
        case 'gd':
          dx = lr * g.x;
          dz = lr * g.z;
          break;
        case 'momentum':
          this.vx = b1 * this.vx + g.x;
          this.vz = b1 * this.vz + g.z;
          dx = lr * this.vx;
          dz = lr * this.vz;
          break;
        case 'rmsprop':
          this.sx = 0.9 * this.sx + 0.1 * g.x * g.x;
          this.sz = 0.9 * this.sz + 0.1 * g.z * g.z;
          dx = (lr * g.x) / (Math.sqrt(this.sx) + eps);
          dz = (lr * g.z) / (Math.sqrt(this.sz) + eps);
          break;
        case 'adam': {
          this.vx = b1 * this.vx + (1 - b1) * g.x;
          this.vz = b1 * this.vz + (1 - b1) * g.z;
          this.sx = b2 * this.sx + (1 - b2) * g.x * g.x;
          this.sz = b2 * this.sz + (1 - b2) * g.z * g.z;
          const c1 = 1 - b1 ** t, c2 = 1 - b2 ** t;
          dx = (lr * (this.vx / c1)) / (Math.sqrt(this.sx / c2) + eps);
          dz = (lr * (this.vz / c1)) / (Math.sqrt(this.sz / c2) + eps);
          break;
        }
      }
      if (tricks.noise > 0) {
        // Gaussian jitter that cools to nothing over each run (annealing), so it can settle.
        const u = ((t - 1) % Math.max(1, tricks.period)) / Math.max(1, tricks.period);
        const sd = tricks.noise * NOISE * scale * (1 - u) ** 2;
        const r = Math.sqrt(-2 * Math.log(1 - this.rng())), a = 2 * Math.PI * this.rng();
        dx -= sd * r * Math.cos(a);
        dz -= sd * r * Math.sin(a);
      }
      const next = clampToDomain(L, { x: this.p.x - dx, z: this.p.z - dz });
      const loss = L.f(next.x, next.z);
      if (!Number.isFinite(loss)) {
        this.diverged = true;
        break;
      }
      this.p = next;
      if (loss < this.best.loss) this.best = { ...next, loss, t };
      out.push({ ...next, loss });
    }
    return out;
  }
}

export function runOptimizer(
  L: Landscape,
  start: Point2,
  opt: OptimizerId,
  lr: number,
  steps: number,
): OptStep[] {
  return [{ ...start, loss: L.f(start.x, start.z) }, ...new OptimizerRun(L, start, opt).step(lr, steps)];
}
