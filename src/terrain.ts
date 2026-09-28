import * as THREE from 'three';
import type { Landscape, Point2 } from './landscapes';

/** Map sizes (world units across). Heights and features scale with it; see makeLandscape. */
export const MAP_SIZES = [
  { id: 'small', label: 'Small', size: 50 },
  { id: 'medium', label: 'Medium', size: 100 },
  { id: 'large', label: 'Large', size: 160 },
  { id: 'huge', label: 'Huge', size: 250 },
] as const;
export type MapSizeId = (typeof MAP_SIZES)[number]['id'];

/** Vertices per side: cells get a little coarser on bigger maps to keep vertex counts sane. */
function gridFor(size: number) {
  const cell = 0.26 * (size / 50) ** 0.35;
  return Math.round(size / cell) + 1;
}

/** Cells per chunk side. Each chunk is its own mesh, built on demand and culled when far. */
const CHUNK = 32;

export type ThemeId = 'spectrum' | 'solid' | 'desert' | 'snow' | 'grass' | 'ash';

export interface TerrainStyle {
  theme: ThemeId;
  /** Used by the 'solid' theme. */
  solid: string;
  contours: boolean;
}

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'solid', label: 'Solid' },
  { id: 'desert', label: 'Desert' },
  { id: 'snow', label: 'Snow' },
  { id: 'grass', label: 'Grassland' },
  { id: 'ash', label: 'Ashy black' },
];

type Stops = [number, THREE.Color][];
const stops = (...s: [number, string][]): Stops => s.map(([t, c]) => [t, new THREE.Color(c)]);

/** Low → high loss. Heights are colored by rank so every landscape uses the full ramp. */
/**
 * `grain`: strength of the fine surface texture drawn in the shader (default GRAIN).
 * `lantern`: the avatar's light color at night on this palette (default LANTERN).
 */
const RAMPS: Record<
  Exclude<ThemeId, 'solid'>,
  { ramp: Stops; cliff?: THREE.Color; grain?: number; lantern?: THREE.Color }
> = {
  spectrum: {
    ramp: stops([0, '#0fd9c8'], [0.25, '#2463d9'], [0.55, '#7a2bc4'], [0.8, '#d9336b'], [1, '#ffa630']),
  },
  desert: {
    ramp: stops([0, '#f0d9a4'], [0.35, '#e2b877'], [0.65, '#cc8f52'], [0.88, '#a8603a'], [1, '#86452c']),
    cliff: new THREE.Color('#6e4630'),
  },
  snow: {
    ramp: stops([0, '#9fc3e0'], [0.2, '#d4e4f2'], [0.5, '#eef3f8'], [1, '#ffffff']),
    cliff: new THREE.Color('#4b515c'),
  },
  grass: {
    ramp: stops([0, '#2d6e2f'], [0.4, '#4f9a3b'], [0.7, '#86a845'], [0.9, '#9c8f5a'], [1, '#8a7a62']),
    cliff: new THREE.Color('#665a4c'),
  },
  ash: {
    // Charcoal and volcanic ash, with embers smouldering at the very bottom.
    ramp: stops([0, '#a8391a'], [0.03, '#4d3025'], [0.1, '#403d3a'], [0.6, '#5d5955'], [0.9, '#7d7872'], [1, '#a19b93']),
    cliff: new THREE.Color('#302b27'),
    grain: 0.32,
    // A warm lantern stains grey ash tan; a cool neutral one keeps it charcoal.
    lantern: new THREE.Color('#dde4f0'),
  },
};

/** CSS preview of a theme, low → high. */
export function themeSwatch(theme: ThemeId, solid: string) {
  if (theme === 'solid') return solid;
  const r = RAMPS[theme].ramp;
  return `linear-gradient(90deg, ${r.map(([t, c]) => `#${c.getHexString()} ${t * 100}%`).join(', ')})`;
}

function sample(ramp: Stops, t: number, out: THREE.Color) {
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i][0]) {
      const [t0, c0] = ramp[i - 1];
      const [t1, c1] = ramp[i];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(ramp[ramp.length - 1][1]);
}

/** Cheap per-vertex hash in [-1, 1], to break up flat bands on the natural themes. */
function noise(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Brightness of never-seen ground, so the lantern still shows its shape. */
const UNEXPLORED = 0.035;
/**
 * A glow along the flashlight's beam, independent of the ground's slope: a flashlight at head
 * height hits far, flat ground at a grazing angle, which real lighting leaves nearly black.
 */
const BEAM_GLOW = 0.5;
/** Line of sight: ray spacing along the ground and across, and the softness of the horizon (rise over run). */
const SIGHT_STEP = 0.25, SIGHT_SPREAD = 0.3, SIGHT_SOFT = 0.02;
/** Width of the soft edge around revealed ground, in world units. */
const FOG_EDGE = 0.9;

/**
 * Ground to reveal, in world units: a disc of `radius` around (x, z), or, with `dir`, a
 * flashlight beam: a teardrop from a small circle of radius `foot` where you stand, widening
 * smoothly to a round pool of radius `pool` where the light lands, `radius` out in total along
 * `dir` (a unit vector). `edge` widens the soft fade at its rim in the 3-D view (default FOG_EDGE).
 * With `eye` (the world height of the eye at (x, z)), only ground in line of sight is revealed.
 */
export interface RevealShape {
  x: number;
  z: number;
  radius: number;
  dir?: { x: number; z: number };
  foot?: number;
  pool?: number;
  edge?: number;
  eye?: number;
}

interface Bounds { x0: number; x1: number; z0: number; z1: number }

/** Signed distance to the shape's edge: positive inside, negative outside. */
export function shapeDistance(s: RevealShape): (px: number, pz: number) => number {
  const { x, z, radius: R, dir } = s;
  if (!dir) return (px, pz) => R - Math.hypot(px - x, pz - z);
  // The hull of two circles (an "uneven capsule"): r1 at the origin, r2 at distance h.
  const r1 = s.foot ?? 1, r2 = Math.max(r1, s.pool ?? r1), h = Math.max(1e-3, R - r2);
  const k = (r1 - r2) / h, c = Math.sqrt(Math.max(0, 1 - k * k));
  return (px, pz) => {
    const dx = px - x, dz = pz - z;
    const along = dx * dir.x + dz * dir.z, across = Math.abs(dx * dir.z - dz * dir.x);
    const t = -k * across + c * along;
    if (t < 0) return r1 - Math.hypot(across, along);
    if (t > c * h) return r2 - Math.hypot(across, along - h);
    return r1 - (c * across + k * along);
  };
}

function shapeBounds(s: RevealShape): Bounds {
  const { x, z, radius: R, dir } = s;
  if (!dir) return { x0: x - R, x1: x + R, z0: z - R, z1: z + R };
  const r1 = s.foot ?? 1, r2 = Math.max(r1, s.pool ?? r1), h = R - r2;
  const cx = x + dir.x * h, cz = z + dir.z * h;
  return {
    x0: Math.min(x - r1, cx - r2), x1: Math.max(x + r1, cx + r2),
    z0: Math.min(z - r1, cz - r2), z1: Math.max(z + r1, cz + r2),
  };
}
const GRAIN = 0.1;
const LANTERN = new THREE.Color('#ffb35c');
/** Mean linear luminance the night lighting was tuned for (the Spectrum palette). */
const REFERENCE_ALBEDO = 0.22;

interface Chunk {
  /** Vertex index ranges, inclusive; neighbouring chunks share their border row/column. */
  x0: number; x1: number; z0: number; z1: number;
  center: THREE.Vector3;
  mesh: THREE.Mesh | null;
  colors: THREE.BufferAttribute | null;
}

/**
 * The heightmap terrain, split into chunks that are generated lazily: nearest to the player
 * first, a few milliseconds per frame, so big maps never freeze the page. Heights anywhere
 * else are computed on demand (and cached) when something asks for them. Coloring by height
 * rank uses a coarse sample of the whole map, so chunks match before the rest exists.
 */
export class Terrain {
  readonly grid: number;
  readonly size: number;
  readonly heights: Float32Array; // [iz * grid + ix], valid where `hasHeight`
  readonly baseColors: Float32Array; // rgb per vertex, fully revealed (0 until generated)
  readonly explored: Float32Array; // 0..1 per vertex
  /** Everything to add to the scene. */
  readonly object = new THREE.Group();
  /** Estimated from a sample of the whole map. */
  minHeight = Infinity;
  maxHeight = -Infinity;
  /** Set whenever `explored` or the colors change, cleared by whoever consumes it (the minimap). */
  exploredDirty = true;
  /** Vertices revealed past the halfway mark. */
  exploredCount = 0;

  private hasHeight: Uint8Array;
  private rank: Float32Array; // 0..1 height rank per vertex
  private slope: Float32Array; // 0 = flat, 1 = vertical
  private sortedSample: Float32Array; // heights of the whole-map sample, ascending
  /** The whole-map sample as (rank, slope) pairs, for the palette's average brightness. */
  private sampleLook: Float32Array;
  private chunks: Chunk[] = [];
  private pending: number;
  private cell: number;
  private material: THREE.MeshStandardMaterial;
  private style!: TerrainStyle;
  /**
   * Fog of war for rendering: a texture at twice the vertex resolution, sampled per pixel with
   * bilinear filtering, so the edge of revealed ground is a smooth curve instead of following
   * the triangles. (`explored` is the per-vertex version, for the minimap and the % explored.)
   */
  private fogData: Uint8Array<ArrayBuffer>;
  private fogTex: THREE.DataTexture;
  private fogRes: number;
  private uniforms = {
    uFog: { value: null as THREE.Texture | null },
    uFogRes: { value: 1 },
    uSize: { value: 50 },
    uUnexplored: { value: UNEXPLORED },
    uContour: { value: 1 },
    uLines: { value: 1 },
    uDay: { value: 0 },
    uGlow: { value: 1 },
    uGrain: { value: GRAIN },
    // The flashlight: where it is, where it points, its cone (cos of the half angle) and range.
    uSpillPos: { value: new THREE.Vector3() },
    uSpillDir: { value: new THREE.Vector3(0, -1, 0) },
    uSpillCos: { value: 1 },
    uSpillRange: { value: 0 },
    uSpillNear: { value: 0 },
  };
  /**
   * Night light multiplier for the current palette: pale ground (snow, desert) gets a dimmer
   * lantern and glow so it isn't blinding, dark ground (ash) a stronger one.
   */
  nightLight = 1;
  readonly lanternColor = LANTERN.clone();

  constructor(
    readonly landscape: Landscape,
    style: TerrainStyle,
    /** World units across. `eager` builds every chunk right away (tests, small maps). */
    opts: { size?: number; eager?: boolean } = {},
  ) {
    this.size = opts.size ?? 50;
    const N = (this.grid = gridFor(this.size));
    this.cell = this.size / (N - 1);
    this.heights = new Float32Array(N * N);
    this.hasHeight = new Uint8Array(N * N);
    this.baseColors = new Float32Array(N * N * 3);
    this.explored = new Float32Array(N * N);
    this.rank = new Float32Array(N * N);
    this.slope = new Float32Array(N * N);

    // Whole-map sample: height range, the rank lookup, and the palette's average brightness.
    const S = 96, sample = new Float32Array(S * S);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const x = landscape.xRange[0] + (i / (S - 1)) * (landscape.xRange[1] - landscape.xRange[0]);
        const z = landscape.zRange[0] + (j / (S - 1)) * (landscape.zRange[1] - landscape.zRange[0]);
        sample[j * S + i] = landscape.height(landscape.f(x, z));
      }
    this.sortedSample = sample.slice().sort();
    this.minHeight = this.sortedSample[0];
    this.maxHeight = this.sortedSample[this.sortedSample.length - 1];
    this.uniforms.uContour.value = 28 / (this.maxHeight - this.minHeight || 1);
    this.sampleLook = new Float32Array(S * S * 2);
    const step = this.size / (S - 1);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const at = (a: number, b: number) => sample[Math.min(S - 1, Math.max(0, b)) * S + Math.min(S - 1, Math.max(0, a))];
        const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * step), dz = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
        this.sampleLook[(j * S + i) * 2] = this.rankOf(sample[j * S + i]);
        this.sampleLook[(j * S + i) * 2 + 1] = 1 - 1 / Math.hypot(dx, 1, dz);
      }

    const across = Math.ceil((N - 1) / CHUNK);
    for (let cz = 0; cz < across; cz++)
      for (let cx = 0; cx < across; cx++) {
        const x0 = cx * CHUNK, z0 = cz * CHUNK;
        const x1 = Math.min(N - 1, x0 + CHUNK), z1 = Math.min(N - 1, z0 + CHUNK);
        const center = new THREE.Vector3(
          ((x0 + x1) / 2) * this.cell - this.size / 2,
          0,
          ((z0 + z1) / 2) * this.cell - this.size / 2,
        );
        this.chunks.push({ x0, x1, z0, z1, center, mesh: null, colors: null });
      }
    this.pending = this.chunks.length;
    const F = (this.fogRes = Math.min(2048, 2 * (N - 1) + 1));
    this.fogData = new Uint8Array(F * F);
    this.fogTex = new THREE.DataTexture(this.fogData, F, F, THREE.RedFormat, THREE.UnsignedByteType);
    this.fogTex.magFilter = this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.unpackAlignment = 1;
    this.fogTex.needsUpdate = true;
    this.uniforms.uFog.value = this.fogTex;
    this.uniforms.uFogRes.value = F;
    this.uniforms.uSize.value = this.size;
    this.material = this.makeMaterial();
    this.setStyle(style);
    if (opts.eager) for (const c of this.chunks) this.buildChunk(c);
  }

  /** Whether every chunk has been built. */
  get complete() {
    return this.pending === 0;
  }

  /**
   * Builds the chunks nearest to (wx, wz) for up to `budgetMs`, and shows only chunks within
   * `viewDistance` of it. Call once a frame.
   */
  update(wx: number, wz: number, budgetMs: number, viewDistance: number) {
    const halfDiag = CHUNK * this.cell * 0.75;
    for (const c of this.chunks) {
      if (!c.mesh) continue;
      c.mesh.visible = Math.hypot(c.center.x - wx, c.center.z - wz) < viewDistance + halfDiag;
    }
    if (!this.pending) return;
    const start = performance.now();
    while (this.pending && performance.now() - start < budgetMs) {
      let best: Chunk | null = null, bestD = Infinity;
      for (const c of this.chunks) {
        if (c.mesh) continue;
        const d = Math.hypot(c.center.x - wx, c.center.z - wz);
        if (d < bestD) (best = c), (bestD = d);
      }
      this.buildChunk(best!);
    }
  }

  /** Builds every chunk within `radius` of (wx, wz) right now (e.g. around a fresh spawn). */
  prime(wx: number, wz: number, radius: number) {
    const halfDiag = CHUNK * this.cell * 0.75;
    for (const c of this.chunks)
      if (!c.mesh && Math.hypot(c.center.x - wx, c.center.z - wz) < radius + halfDiag) this.buildChunk(c);
  }

  /** Recolors the terrain, keeping what has been explored. */
  setStyle(style: TerrainStyle) {
    this.style = style;
    this.uniforms.uLines.value = style.contours ? 1 : 0;
    const theme = style.theme === 'solid' ? null : RAMPS[style.theme];

    // Average brightness over the whole-map sample, for the night lighting.
    const c = new THREE.Color();
    let albedo = 0, n = 0;
    for (let k = 0; k < this.sampleLook.length; k += 2, n++) {
      this.color(c, this.sampleLook[k], this.sampleLook[k + 1], k);
      albedo += 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    }
    albedo /= n;
    // Softened (^0.75) so snow still reads as brighter than rock, just not glaring.
    this.nightLight = Math.min(1.35, Math.max(0.3, (REFERENCE_ALBEDO / albedo) ** 0.75));
    this.uniforms.uGlow.value = this.nightLight;
    this.lanternColor.copy(theme?.lantern ?? LANTERN);
    this.uniforms.uGrain.value = theme?.grain ?? (theme?.cliff ? GRAIN : GRAIN * 0.5);

    for (const ch of this.chunks) if (ch.mesh) this.colorChunkBase(ch);
    this.refreshColors();
  }

  /** Base color for a vertex with height rank `t`, steepness `slope` and index `i` (for grain). */
  private color(out: THREE.Color, t: number, slope: number, i: number) {
    const style = this.style;
    const theme = style.theme === 'solid' ? null : RAMPS[style.theme];
    if (!theme) return out.set(style.solid);
    sample(theme.ramp, t, out);
    if (theme.cliff) {
      // Bare rock shows through on steep slopes; slight grain everywhere.
      out.lerp(theme.cliff, Math.min(1, Math.max(0, (slope - 0.35) / 0.35)));
      out.multiplyScalar(1 + noise(i) * 0.05);
    }
    return out;
  }

  private colorChunkBase(ch: Chunk) {
    const N = this.grid, c = new THREE.Color();
    for (let iz = ch.z0; iz <= ch.z1; iz++)
      for (let ix = ch.x0; ix <= ch.x1; ix++) {
        const i = iz * N + ix;
        this.color(c, this.rank[i], this.slope[i], i);
        this.baseColors[i * 3] = c.r;
        this.baseColors[i * 3 + 1] = c.g;
        this.baseColors[i * 3 + 2] = c.b;
      }
  }

  /**
   * The flashlight, so its light shows on ground it hasn't revealed: fully out to `near` (where
   * it's aimed), then fading to nothing at `range`. Null when off.
   */
  setSpill(light: { pos: THREE.Vector3; dir: THREE.Vector3; angle: number; near: number; range: number } | null) {
    const u = this.uniforms;
    u.uSpillRange.value = light ? light.range : 0;
    if (!light) return;
    u.uSpillNear.value = light.near;
    u.uSpillPos.value.copy(light.pos);
    u.uSpillDir.value.copy(light.dir).normalize();
    u.uSpillCos.value = Math.cos(light.angle);
  }

  /** Daylight: the whole surface is visible; fog of war then only applies to the minimap. */
  setLit(lit: boolean) {
    this.uniforms.uDay.value = lit ? 1 : 0;
  }

  private refreshColors() {
    for (const ch of this.chunks) if (ch.mesh) this.shadeChunk(ch);
    this.exploredDirty = true;
  }

  /** Writes a built chunk's vertex colors (fog of war is applied in the shader). */
  private shadeChunk(ch: Chunk) {
    const N = this.grid, col = ch.colors!.array as Float32Array;
    let j = 0;
    for (let iz = ch.z0; iz <= ch.z1; iz++)
      for (let ix = ch.x0; ix <= ch.x1; ix++, j += 3) {
        const i = (iz * N + ix) * 3;
        col[j] = this.baseColors[i];
        col[j + 1] = this.baseColors[i + 1];
        col[j + 2] = this.baseColors[i + 2];
      }
    ch.colors!.needsUpdate = true;
  }

  /** Height rank in [0, 1], from the whole-map sample. */
  private rankOf(h: number) {
    const a = this.sortedSample;
    let lo = 0, hi = a.length - 1;
    if (h <= a[0]) return 0;
    if (h >= a[hi]) return 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= h) lo = mid;
      else hi = mid;
    }
    return (lo + (h - a[lo]) / (a[hi] - a[lo] || 1)) / (a.length - 1);
  }

  /** Height at a grid vertex, computing and caching it if needed. */
  private h(ix: number, iz: number) {
    const N = this.grid;
    ix = Math.min(N - 1, Math.max(0, ix));
    iz = Math.min(N - 1, Math.max(0, iz));
    const i = iz * N + ix;
    if (!this.hasHeight[i]) {
      const { x, z } = this.gridToFn(ix, iz);
      this.heights[i] = this.landscape.height(this.landscape.f(x, z));
      this.hasHeight[i] = 1;
    }
    return this.heights[i];
  }

  private buildChunk(ch: Chunk) {
    if (ch.mesh) return;
    const N = this.grid, cell = this.cell, half = this.size / 2;
    const w = ch.x1 - ch.x0 + 1, d = ch.z1 - ch.z0 + 1;
    const pos = new Float32Array(w * d * 3), nor = new Float32Array(w * d * 3);
    let j = 0;
    for (let iz = ch.z0; iz <= ch.z1; iz++)
      for (let ix = ch.x0; ix <= ch.x1; ix++, j += 3) {
        const i = iz * N + ix, y = this.h(ix, iz);
        pos[j] = ix * cell - half;
        pos[j + 1] = y;
        pos[j + 2] = iz * cell - half;
        // Central differences (one past the chunk edge), so normals match across chunk seams.
        const dx = (this.h(ix + 1, iz) - this.h(ix - 1, iz)) / ((Math.min(N - 1, ix + 1) - Math.max(0, ix - 1)) * cell);
        const dz = (this.h(ix, iz + 1) - this.h(ix, iz - 1)) / ((Math.min(N - 1, iz + 1) - Math.max(0, iz - 1)) * cell);
        const len = Math.hypot(dx, 1, dz);
        nor[j] = -dx / len;
        nor[j + 1] = 1 / len;
        nor[j + 2] = -dz / len;
        this.slope[i] = 1 - 1 / len;
        this.rank[i] = this.rankOf(y);
      }
    // Same diagonal split as PlaneGeometry, which heightAt() interpolates over.
    const idx: number[] = [];
    for (let z = 0; z < d - 1; z++)
      for (let x = 0; x < w - 1; x++) {
        const a = z * w + x, b = (z + 1) * w + x, c = (z + 1) * w + x + 1, e = z * w + x + 1;
        idx.push(a, b, e, b, c, e);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    ch.colors = new THREE.BufferAttribute(new Float32Array(w * d * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', ch.colors);
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    ch.mesh = new THREE.Mesh(geo, this.material);
    ch.mesh.receiveShadow = true;
    this.object.add(ch.mesh);
    this.colorChunkBase(ch);
    this.shadeChunk(ch);
    this.pending--;
    this.exploredDirty = true;
  }

  private makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vH;\nvarying vec2 vXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;\nvXZ = position.xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying float vH;
          varying vec2 vXZ;
          uniform sampler2D uFog;
          uniform float uFogRes;
          uniform float uSize;
          uniform float uUnexplored;
          uniform float uContour;
          uniform float uLines;
          uniform float uDay;
          uniform float uGlow;
          uniform float uGrain;
          uniform vec3 uSpillPos;
          uniform vec3 uSpillDir;
          uniform float uSpillCos;
          uniform float uSpillRange;
          uniform float uSpillNear;
          float grainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float valueNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(grainHash(i), grainHash(i + vec2(1, 0)), u.x),
                       mix(grainHash(i + vec2(0, 1)), grainHash(i + vec2(1, 1)), u.x), u.y);
          }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // Surface texture: patches, clumps and grit, finer octaves fading out with distance
          // so they don't shimmer.
          float fw = length(fwidth(vXZ));
          float g = 0.5 * valueNoise(vXZ * 0.7)
                  + 0.3 * valueNoise(vXZ * 2.9 + 17.0) * clamp(1.6 - fw * 2.9, 0.0, 1.0)
                  + 0.2 * valueNoise(vXZ * 11.0 + 41.0) * clamp(1.6 - fw * 11.0, 0.0, 1.0);
          float grain = 1.0 + uGrain * (2.0 * g - 1.0);
          // Fog of war, per pixel: unexplored ground is nearly black (by day, all is visible).
          vec2 fogUv = ((vXZ / uSize + 0.5) * (uFogRes - 1.0) + 0.5) / uFogRes;
          float seen = smoothstep(0.0, 1.0, texture2D(uFog, fogUv).r);
          float fogK = mix(uUnexplored + (1.0 - uUnexplored) * seen, 1.0, uDay);
          // The flashlight lights unrevealed ground in its cone as it does revealed ground, fully
          // out to where it's aimed and then fading away to the end of its range, so the beam
          // reads as one light (only the pool where it lands reveals, though).
          vec3 toP = vec3(vXZ.x, vH, vXZ.y) - uSpillPos;
          float spillD = length(toP);
          float cone = uSpillRange > 0.0
            ? smoothstep(uSpillCos, mix(uSpillCos, 1.0, 0.5), dot(toP / max(spillD, 1e-4), uSpillDir)) : 0.0;
          float beamLit = cone * (1.0 - smoothstep(uSpillNear, uSpillRange, spillD));
          float litBase = max(uUnexplored, beamLit);
          diffuseColor.rgb *= grain * mix(litBase + (1.0 - litBase) * seen, 1.0, uDay);
          float beamGlow = cone * max(0.0, 1.0 - spillD / max(uSpillRange, 1e-4)) * (1.0 - uDay);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          // At night explored ground glows faintly so you can see where you've been from afar,
          // and contour lines glow; by day the lines are drawn darker instead.
          float hc = vH * uContour;
          float line = uLines * (1.0 - min(abs(fract(hc - 0.5) - 0.5) / fwidth(hc), 1.0));
          totalEmissiveRadiance += vColor.rgb * grain * fogK * uGlow * (1.0 - uDay) * (0.22 + 0.9 * line);
          totalEmissiveRadiance += vColor.rgb * grain * uGlow * ${BEAM_GLOW.toFixed(2)} * beamGlow * max(litBase, seen);
          diffuseColor.rgb *= 1.0 - uDay * 0.45 * line;`,
        );
    };
    return mat;
  }

  // ----- coordinate mapping -----

  gridToFn(ix: number, iz: number): Point2 {
    const L = this.landscape, N = this.grid;
    return {
      x: L.xRange[0] + (ix / (N - 1)) * (L.xRange[1] - L.xRange[0]),
      z: L.zRange[0] + (iz / (N - 1)) * (L.zRange[1] - L.zRange[0]),
    };
  }

  worldToFn(wx: number, wz: number): Point2 {
    const L = this.landscape;
    return {
      x: L.xRange[0] + (wx / this.size + 0.5) * (L.xRange[1] - L.xRange[0]),
      z: L.zRange[0] + (wz / this.size + 0.5) * (L.zRange[1] - L.zRange[0]),
    };
  }

  fnToWorld(fx: number, fz: number): Point2 {
    const L = this.landscape;
    return {
      x: ((fx - L.xRange[0]) / (L.xRange[1] - L.xRange[0]) - 0.5) * this.size,
      z: ((fz - L.zRange[0]) / (L.zRange[1] - L.zRange[0]) - 0.5) * this.size,
    };
  }

  /** Height of the rendered mesh at a world position (matches the triangle split). */
  heightAt(wx: number, wz: number): number {
    const N = this.grid;
    const gx = Math.min(N - 1.0001, Math.max(0, (wx / this.size + 0.5) * (N - 1)));
    const gz = Math.min(N - 1.0001, Math.max(0, (wz / this.size + 0.5) * (N - 1)));
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const u = gx - ix, v = gz - iz;
    const a = this.h(ix, iz);
    const b = this.h(ix, iz + 1);
    const c = this.h(ix + 1, iz + 1);
    const d = this.h(ix + 1, iz);
    return u + v <= 1
      ? a + (d - a) * u + (b - a) * v
      : c + (b - c) * (1 - u) + (d - c) * (1 - v);
  }

  // ----- fog of war -----

  reveal(wx: number, wz: number, radius: number) {
    this.revealShape({ x: wx, z: wz, radius });
  }

  /** Reveals a disc or a flashlight beam (see RevealShape), only what's in sight with `eye`. */
  revealShape(shape: RevealShape) {
    const sd = shapeDistance(shape);
    const b = shapeBounds(shape);
    const edge = Math.max(FOG_EDGE, shape.edge ?? 0);
    const sight = shape.eye === undefined ? null : this.lineOfSight(shape.x, shape.z, shape.eye, shape.radius, sd, edge / 2);
    const N = this.grid, S = this.size, step = S / (N - 1);
    const x0 = Math.max(0, Math.floor((b.x0 / S + 0.5) * (N - 1)));
    const x1 = Math.min(N - 1, Math.ceil((b.x1 / S + 0.5) * (N - 1)));
    const z0 = Math.max(0, Math.floor((b.z0 / S + 0.5) * (N - 1)));
    const z1 = Math.min(N - 1, Math.ceil((b.z1 / S + 0.5) * (N - 1)));
    // Per-vertex exploration (minimap, % explored): full most of the way in, soft at the rim.
    const soft = Math.min(0.35 * shape.radius, 1.6);
    let changed = false;
    for (let iz = z0; iz <= z1; iz++) {
      const pz = iz * step - S / 2;
      for (let ix = x0; ix <= x1; ix++) {
        const px = ix * step - S / 2, d = sd(px, pz);
        if (d <= 0) continue;
        const i = iz * N + ix;
        let v = Math.min(1, d / soft);
        if (v <= this.explored[i]) continue; // already this explored, in sight or not
        if (sight) v *= sight(px, pz);
        if (v <= this.explored[i]) continue;
        if (this.explored[i] < 0.5 && v >= 0.5) this.exploredCount++;
        this.explored[i] = v;
        changed = true;
      }
    }
    this.revealFog(sd, b, edge, sight);
    if (!changed) return;
    // Revealed ground must exist (the minimap shows its colors).
    for (const ch of this.chunks) {
      if (ch.x1 < x0 || ch.x0 > x1 || ch.z1 < z0 || ch.z0 > z1) continue;
      if (!ch.mesh) this.buildChunk(ch);
    }
    this.exploredDirty = true;
  }

  /**
   * Stamps a shape into the fog texture as a linear ramp `edge` wide, centered on its rim.
   * Bilinear filtering reproduces a linear ramp exactly, so the rendered edge is a clean curve.
   */
  private revealFog(sd: (x: number, z: number) => number, b: Bounds, edge: number, sight: ((x: number, z: number) => number) | null) {
    const F = this.fogRes, S = this.size, texel = S / (F - 1), pad = edge / 2;
    const x0 = Math.max(0, Math.floor(((b.x0 - pad) / S + 0.5) * (F - 1)));
    const x1 = Math.min(F - 1, Math.ceil(((b.x1 + pad) / S + 0.5) * (F - 1)));
    const z0 = Math.max(0, Math.floor(((b.z0 - pad) / S + 0.5) * (F - 1)));
    const z1 = Math.min(F - 1, Math.ceil(((b.z1 + pad) / S + 0.5) * (F - 1)));
    let changed = false;
    for (let iz = z0; iz <= z1; iz++) {
      const pz = iz * texel - S / 2;
      for (let ix = x0; ix <= x1; ix++) {
        const px = ix * texel - S / 2, d = sd(px, pz);
        if (d <= -pad) continue;
        const i = iz * F + ix;
        const full = Math.min(1, d / edge + 0.5);
        if (Math.round(255 * full) <= this.fogData[i]) continue; // already this revealed
        const v = Math.round(255 * full * (sight ? sight(px, pz) : 1));
        if (v > this.fogData[i]) {
          this.fogData[i] = v;
          changed = true;
        }
      }
    }
    if (changed) this.fogTex.needsUpdate = true;
  }

  /**
   * What an eye at height `eyeY` over (ex, ez) can see of the ground in a convex shape around
   * it (signed distance `sd`, reaching at most `radius` out, plus `pad`). Rays fan out from the
   * eye, each tracking the steepest rise it has passed (its horizon); ground that sits below
   * that horizon is hidden behind it. Returns visibility 0..1 at a point, soft at the horizon
   * and blended between neighboring rays and steps.
   */
  private lineOfSight(ex: number, ez: number, eyeY: number, radius: number, sd: (x: number, z: number) => number, pad: number) {
    const R = radius + pad + SIGHT_STEP;
    const S = Math.ceil(R / SIGHT_STEP) + 2;
    const N = Math.min(720, Math.max(48, Math.ceil((2 * Math.PI * R) / SIGHT_SPREAD)));
    const vis = new Float32Array(N * S);
    for (let k = 0; k < N; k++) {
      const a = (2 * Math.PI * k) / N, dx = Math.sin(a), dz = Math.cos(a);
      let horizon = -Infinity, v = 1, i = 0;
      vis[k * S] = 1;
      // The shape is convex and holds the eye, so each ray leaves it once: stop just past that.
      for (i = 1; i < S; i++) {
        const r = i * SIGHT_STEP, x = ex + dx * r, z = ez + dz * r;
        if (sd(x, z) < -pad - SIGHT_STEP) break;
        const e = (this.heightAt(x, z) - eyeY) / r;
        const t = Math.min(1, Math.max(0, (e - horizon) / (2 * SIGHT_SOFT) + 0.5));
        v = t * t * (3 - 2 * t);
        vis[k * S + i] = v;
        if (e > horizon) horizon = e;
      }
      for (; i < S; i++) vis[k * S + i] = v;
    }
    return (x: number, z: number) => {
      const dx = x - ex, dz = z - ez, r = Math.hypot(dx, dz);
      if (r < SIGHT_STEP) return 1;
      let a = (Math.atan2(dx, dz) / (2 * Math.PI)) * N;
      if (a < 0) a += N;
      const k0 = Math.floor(a) % N, k1 = (k0 + 1) % N, fa = a - Math.floor(a);
      const fi = Math.min(S - 1.001, r / SIGHT_STEP), i0 = Math.floor(fi), fr = fi - i0;
      const at = (k: number) => vis[k * S + i0] + (vis[k * S + i0 + 1] - vis[k * S + i0]) * fr;
      return at(k0) + (at(k1) - at(k0)) * fa;
    };
  }

  resetFog() {
    this.explored.fill(0);
    this.exploredCount = 0;
    this.fogData.fill(0);
    this.fogTex.needsUpdate = true;
    this.exploredDirty = true;
  }

  dispose() {
    for (const ch of this.chunks) ch.mesh?.geometry.dispose();
    this.material.dispose();
    this.fogTex.dispose();
  }
}
