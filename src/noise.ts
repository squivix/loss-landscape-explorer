/** Seeded randomness for procedural terrain. Everything here is deterministic per seed. */

export type Rng = () => number;

/** mulberry32: small, fast, good enough for terrain. Returns [0, 1). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

const GRADS = Array.from({ length: 16 }, (_, i) => [Math.cos((i * Math.PI) / 8), Math.sin((i * Math.PI) / 8)]);

/**
 * 2-D gradient (Perlin) noise with its own permutation, roughly in [-1, 1], smooth (C2) so
 * numerical gradients and Newton steps on it behave. Zero on the integer lattice.
 */
export function makeNoise(rng: Rng): (x: number, z: number) => number {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  // Random offset so the lattice zeros don't line up between fields.
  const ox = rng() * 256, oz = rng() * 256;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (h: number, x: number, z: number) => {
    const g = GRADS[h & 15];
    return g[0] * x + g[1] * z;
  };
  return (x, z) => {
    x += ox;
    z += oz;
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = x - xi, zf = z - zi;
    const X = xi & 255, Z = zi & 255;
    const aa = perm[perm[X] + Z], ab = perm[perm[X] + Z + 1];
    const ba = perm[perm[X + 1] + Z], bb = perm[perm[X + 1] + Z + 1];
    const u = fade(xf), v = fade(zf);
    const x1 = dot(aa, xf, zf) + u * (dot(ba, xf - 1, zf) - dot(aa, xf, zf));
    const x2 = dot(ab, xf, zf - 1) + u * (dot(bb, xf - 1, zf - 1) - dot(ab, xf, zf - 1));
    return 1.4 * (x1 + v * (x2 - x1));
  };
}

/**
 * A river network as a log-depth D ≥ 0 (multiply a loss by exp(-D) to carve it): main
 * channels meander along the zero line of one noise field, and tributaries sprout off them,
 * fading out away from the main channel. Width and depth drift along the way. Working in log
 * space gives rounded valleys on log-scaled terrain instead of knife-cut grooves. `depth` is
 * the range of the deepest carve as a fraction of the loss removed; `span` is roughly the map
 * size in function units. `through`, if given, is a point a main channel must pass through.
 */
export function makeRivers(rng: Rng, span: number, depth: [number, number], through?: { x: number; z: number }) {
  const main = makeNoise(rng), trib = makeNoise(rng);
  const warpX = makeNoise(rng), warpZ = makeNoise(rng);
  const width = makeNoise(rng), deep = makeNoise(rng);
  const dMax = -Math.log(1 - between(rng, depth[0], depth[1]));
  const freq = between(rng, 1.0, 1.6);
  const channel = (u: number, v: number) => {
    const wu = u + 0.13 * warpX(u * 2.2, v * 2.2);
    const wv = v + 0.13 * warpZ(u * 2.2, v * 2.2);
    return { wu, wv, m: main(wu * freq, wv * freq) };
  };
  // Shifting the level set makes a main channel pass exactly through `through`.
  const m0 = through ? channel(through.x / span, through.z / span).m : 0;
  return (x: number, z: number) => {
    const u = x / span, v = z / span;
    const { wu, wv, m: raw } = channel(u, v);
    const m = raw - m0;
    const w1 = 0.06 + 0.16 * (0.5 + 0.5 * width(u * 1.3, v * 1.3)) ** 1.5;
    const river = Math.exp(-((m / w1) ** 2));
    const t = trib(wu * freq * 2.4, wv * freq * 2.4);
    const near = Math.exp(-((m / 0.45) ** 2));
    const branch = 0.8 * near * Math.exp(-((t / (w1 * 0.55)) ** 2));
    const d = dMax * (0.45 + 0.55 * (0.5 + 0.5 * deep(u * 1.1, v * 1.1)));
    return d * (1 - (1 - river) * (1 - branch));
  };
}
