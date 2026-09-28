import * as THREE from 'three';
import {
  LANDSCAPES,
  LANDSCAPE_ORDER,
  OPTIMIZERS,
  PLACEMENTS,
  placeMinimum,
  makeLandscape,
  findLocalMin,
  type LocalMin,
  gradient,
  OptimizerRun,
  SCHEDULES,
  type OptTricks,
  type Schedule,
  type Landscape,
  type LandscapeId,
  type MinPlacement,
  type OptimizerId,
  type Point2,
} from './landscapes';
import { MAP_SIZES, THEMES, Terrain, shapeDistance, themeSwatch, type MapSizeId, type RevealShape, type TerrainStyle } from './terrain';
import { PlayerController, wrapAngle, type ViewMode } from './controls';
import { Trail, makeAvatar, makeBeacon, makeStars } from './objects';
import { Minimap, sectorName } from './minimap';
import { startTour, tourSeen } from './tour';

/** Default radius of the ground you light up (and discover) around you. */
const REVEAL_RADIUS = 4.5;
const OPT_REVEAL_RADIUS = 1.6;
/** Flashlight beam: reach as a multiple of the light radius (about the same area), half-width, foot glow. */
const FLASH_REACH = 3, FLASH_HALF = 0.4, FLASH_FOOT = 1.2;
/**
 * The pool of light where the beam lands has this radius per unit of distance to it (roughly
 * the spotlight's spread), so it shrinks as you look down at your feet. Only the pool and the
 * teardrop leading to it get revealed; the light itself spills faintly farther.
 */
const FLASH_POOL = 0.42;
/** Closest the pool gets when you look straight down. */
const FLASH_MIN_AIM = 1.5;
/** Width of the beam's soft rim in the 3-D view, as a fraction of the pool's radius. */
const FLASH_EDGE = 0.8;
type LightKind = 'lantern' | 'flashlight';
/** Optimizer playback speed, steps per second: the slider runs log-scaled between these. */
const OPT_SPEED_MIN = 5, OPT_SPEED_MAX = 600;
const TRAIL_OFFSET = 0.12;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- renderer & scene ----------

const viewport = $('viewport');
const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const sky = new THREE.Color();
const fog = new THREE.Fog('#06070c', 30, 95);
scene.background = sky;
scene.fog = fog;
const hemi = new THREE.HemisphereLight();
const stars = makeStars();
const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
sun.position.set(30, 45, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
// Only the avatar casts shadows, so a small box that follows the player (see frame()) is
// enough, and keeps the shadow texels small.
const SUN_BOX = 12;
Object.assign(sun.shadow.camera, { left: -SUN_BOX, right: SUN_BOX, top: SUN_BOX, bottom: -SUN_BOX, near: 1, far: 200 });
const SUN_OFFSET = new THREE.Vector3(30, 45, 20);
// The shadow camera's axes: it looks along -SUN_OFFSET.
const SUN_FWD = SUN_OFFSET.clone().negate().normalize();
const SUN_RIGHT = new THREE.Vector3().crossVectors(SUN_FWD, new THREE.Vector3(0, 1, 0)).normalize();
const SUN_UP = new THREE.Vector3().crossVectors(SUN_RIGHT, SUN_FWD);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.05;
scene.add(hemi, stars, sun, sun.target);

const clock = new THREE.Clock();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);

const avatar = makeAvatar();
scene.add(avatar.group, avatar.flashlight.target);

const trail = new Trail('#19e0ff', 40000, 0.75);
const optTrail = new Trail('#ff406e', 200000, 0.95);
scene.add(trail.line, optTrail.line);
const optHead = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial({ color: '#ff406e' }));
optHead.add(new THREE.PointLight('#ff406e', 12, 8, 1.5));
optHead.visible = false;
scene.add(optHead);

const localBeacons = new THREE.Group();
const foundBeacons = new THREE.Group(); // global minima you've reached
const globalBeacons = new THREE.Group();
scene.add(localBeacons, foundBeacons, globalBeacons);

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}).observe(viewport);

// ---------- state ----------

const player = new PlayerController(canvas, camera);
const minimap = new Minimap($<HTMLCanvasElement>('minimap'));
minimap.onViewChange = () => {
  $('map-zoom').textContent = `×${minimap.zoom}`;
  $('map-follow').classList.toggle('on', minimap.followMode);
  $('map-follow').title = minimap.followMode
    ? 'Following you (pan or zoom away; moving snaps back). Click to stop following.'
    : 'Not following: the map stays put. Click to follow you again.';
};
$('map-zoom-in').onclick = () => minimap.zoomBy(1);
$('map-zoom-out').onclick = () => minimap.zoomBy(-1);
$('map-follow').onclick = () => {
  minimap.setFollow(!minimap.followMode);
};

let L: Landscape = LANDSCAPES.wilds;
let terrain: Terrain;
let trailPts: Point2[] = [];
let optimizer: OptimizerId = 'adam';
let optWorld: THREE.Vector3[] = [];
/** The optimizer's live state, so "Continue" picks up where it stopped. */
let optRun: OptimizerRun | null = null;
/** Steps per optimizer used on this path, for the result line. */
let optLegs: { opt: OptimizerId; steps: number }[] = [];
let optShown = 0; // fractional index into optWorld while animating
let found = new Map<string, { p: Point2; global: boolean }>();
let showGlobal = false;
let detectRadius = 1;
let detectTimer = 0;
let movedSinceDetect = true;

const PREFS_KEY = 'lle.prefs';
const prefs = { lights: false, path: true, minAt: 'random' as MinPlacement, minU: 0.5, minV: 0.5, localMins: false, mapSize: 'medium' as MapSizeId, revealRadius: REVEAL_RADIUS, mouseLookFirst: true, mouseLookThird: false, hills: true, light: 'flashlight' as LightKind, schedule: 'constant' as Schedule, noise: 0, sam: false, optSpeed: 10, optWatch: true, defaults: 3 };
/**
 * Every pref gets saved, so an old default is indistinguishable from a choice. When the defaults
 * change, prefs saved under the old ones drop the values that still match those old defaults.
 */
let savedUnderOldDefaults = false;
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  if (saved.revealRadius === 3.2) delete saved.revealRadius;
  if ((saved.defaults ?? 1) < 2) {
    savedUnderOldDefaults = true;
    if (saved.light === 'lantern') delete saved.light;
    if (saved.mapSize === 'large') delete saved.mapSize;
  }
  if ((saved.defaults ?? 1) < 3 && saved.optSpeed === 30) delete saved.optSpeed;
  delete saved.defaults;
  Object.assign(prefs, saved);
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); // records which defaults they're under
} catch {}

function setPrefs(patch: Partial<typeof prefs>) {
  Object.assign(prefs, patch);
  applyPrefs();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

function applyPrefs() {
  const day = prefs.lights;
  sky.set(day ? '#a9c8e6' : '#06070c');
  fog.color.copy(sky);
  fog.near = day ? 60 : 30;
  fog.far = day ? 170 : 95;
  $<HTMLInputElement>('light-radius').value = String(prefs.revealRadius);
  const flash = prefs.light === 'flashlight';
  $('light-radius-label').textContent = flash ? 'Beam reach' : 'Light radius';
  $('light-radius-out').textContent = (prefs.revealRadius * (flash ? FLASH_REACH : 1)).toFixed(1);
  for (const b of $('light-kind').querySelectorAll<HTMLButtonElement>('button'))
    b.classList.toggle('active', b.dataset.kind === prefs.light);
  // With the flashlight, the lantern stays as a faint glow around you, without its shadow.
  avatar.lantern.castShadow = !flash;
  avatar.flashlight.visible = flash;
  revealYaw = NaN; // re-reveal with the new light on the next frame
  hemi.color.set(day ? '#dbe9ff' : '#4a5a9a');
  hemi.groundColor.set(day ? '#5a4a3a' : '#08080f');
  hemi.intensity = day ? 1.1 : 0.35;
  sun.visible = day;
  stars.visible = !day;
  terrain?.setLit(day);
  trail.line.visible = prefs.path;
  localBeacons.visible = prefs.localMins;
  $<HTMLInputElement>('local-mins').checked = prefs.localMins;
  player.mouseLookFirst = prefs.mouseLookFirst;
  player.mouseLookThird = prefs.mouseLookThird;
  syncMouseLook();
  player.hills = prefs.hills;
  $<HTMLInputElement>('noise').value = String(prefs.noise);
  $('noise-out').textContent = prefs.noise ? prefs.noise.toFixed(2) : 'off';
  $<HTMLInputElement>('sam').checked = prefs.sam;
  $<HTMLInputElement>('opt-speed').value = String(Math.log(prefs.optSpeed / OPT_SPEED_MIN) / Math.log(OPT_SPEED_MAX / OPT_SPEED_MIN));
  $('opt-speed-out').textContent = `${Math.round(prefs.optSpeed)} steps/s`;
  $<HTMLInputElement>('opt-watch').checked = prefs.optWatch;
  // Shown on the folded "Escaping local minima" heading, so active tricks aren't hidden.
  const on = [
    prefs.schedule !== 'constant' && SCHEDULES.find((sc) => sc.id === prefs.schedule)!.label.toLowerCase(),
    prefs.noise > 0 && 'noise',
    prefs.sam && 'SAM',
  ].filter(Boolean);
  $('tricks-on').textContent = on.length ? `· ${on.join(', ')}` : '';
  $<HTMLInputElement>('hills').checked = prefs.hills;
  renderKeyHelp();
  $<HTMLInputElement>('lights').checked = day;
  $<HTMLInputElement>('show-path').checked = prefs.path;
}

const STYLE_KEY = 'lle.terrainStyle';
const style: TerrainStyle = { theme: 'grass', solid: '#6f8fb0', contours: false };
try {
  const saved = JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}');
  if (savedUnderOldDefaults && saved.contours === true) delete saved.contours; // was the default
  Object.assign(style, saved);
} catch {}
if (!THEMES.some((t) => t.id === style.theme)) style.theme = 'spectrum';

function setStyle(patch: Partial<TerrainStyle>) {
  Object.assign(style, patch);
  terrain.setStyle(style);
  renderThemeControls();
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(style));
  } catch {}
}

function loadLandscape(id: LandscapeId) {
  L = LANDSCAPES[id];
  setLrDefault();
  renderLandscapeButtons();
  buildWorld(true);
}

/** (Re)builds the terrain with the global minimum placed per the current setting, then respawns. */
let seed = 1;

function buildWorld(reroll: boolean) {
  if (reroll) seed = (Math.random() * 2 ** 31) | 0;
  const size = mapSize();
  const base = makeLandscape(L.id, seed, size);
  if (prefs.minAt === 'random' && reroll) {
    prefs.minU = 0.12 + Math.random() * 0.76;
    prefs.minV = 0.12 + Math.random() * 0.76;
  }
  L =
    prefs.minAt === 'natural' ? base
    : prefs.minAt === 'center' ? placeMinimum(base, 0.5, 0.5)
    : placeMinimum(base, prefs.minU, prefs.minV);
  if (terrain) {
    scene.remove(terrain.object);
    terrain.dispose();
  }
  // Chunks are built lazily around the player (see respawn() and frame()).
  if (!terrain || terrain.size !== size) minimap.reset(size);
  // A new world means a new spawn point, so the map picks you up again.
  if (!minimap.followMode) minimap.setFollow(true);
  terrain = new Terrain(L, style, { size });
  terrain.setLit(prefs.lights);
  scene.add(terrain.object);
  buildGlobalBeacons();
  respawn();
}

function mapSize() {
  return (MAP_SIZES.find((m) => m.id === prefs.mapSize) ?? MAP_SIZES[1]).size;
}

/** Sidebar sections fold away by clicking their heading; which ones are folded is remembered. */
function initCollapsibleSections() {
  const KEY = 'lle.collapsed';
  let closed: string[] = [];
  try {
    closed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {}
  for (const sec of document.querySelectorAll<HTMLElement>('.panel section[id]')) {
    sec.classList.toggle('collapsed', closed.includes(sec.id));
    sec.querySelector('h2')!.onclick = () => {
      sec.classList.toggle('collapsed');
      const now = [...document.querySelectorAll('.panel section.collapsed')].map((e) => e.id);
      try {
        localStorage.setItem(KEY, JSON.stringify(now));
      } catch {}
    };
  }
}

function renderMapSizes() {
  $('map-size').replaceChildren(
    ...MAP_SIZES.map((m) => {
      const b = document.createElement('button');
      b.textContent = m.label;
      b.title = `${m.size} × ${m.size}`;
      b.classList.toggle('active', m.id === prefs.mapSize);
      b.onclick = () => {
        if (m.id === prefs.mapSize) return;
        setPrefs({ mapSize: m.id });
        renderMapSizes();
        buildWorld(false);
      };
      return b;
    }),
  );
}

function renderPlacement() {
  for (const b of $('min-at').querySelectorAll<HTMLButtonElement>('button'))
    b.classList.toggle('active', b.dataset.id === prefs.minAt);
  $('min-hint').textContent = PLACEMENTS.find((p) => p.id === prefs.minAt)!.hint;
  $('minimap').classList.toggle('picking', prefs.minAt === 'pick');
  $('respawn').textContent = prefs.minAt === 'random' ? 'New game (new terrain & minimum)' : 'New game (new terrain)';
}

/** "Play again": fresh terrain variety and spawn, and a fresh minimum location when it's random. */
function newGame() {
  buildWorld(true);
}

let gameStart = 0;
let walked = 0;

/** Random spawn away from the global minima, with all progress cleared. */
function respawn() {
  hideWin();
  gameStart = clock.elapsedTime;
  walked = 0;
  const globals = L.globalMinima.map((g) => terrain.fnToWorld(g.x, g.z));
  let x = 0, z = 0;
  for (let tries = 0; tries < 50; tries++) {
    x = (Math.random() - 0.5) * terrain.size * 0.75;
    z = (Math.random() - 0.5) * terrain.size * 0.75;
    if (globals.every((g) => Math.hypot(g.x - x, g.z - z) > Math.max(10, 0.2 * terrain.size))) break;
  }
  player.spawn(x, z, Math.random() * Math.PI * 2);
  terrain.prime(x, z, 30);

  terrain.resetFog();
  trail.clear();
  trailPts = [];
  clearOpt();
  found.clear();
  spotCache.clear();
  spotQueue = [];
  localBeacons.clear();
  foundBeacons.clear();
  updateProgress();
  movedSinceDetect = true;
}

function clearOpt() {
  optRun = null;
  optLegs = [];
  optWorld = [];
  optShown = 0;
  optTrail.clear();
  optHead.visible = false;
  $('opt-result').textContent = '';
  renderOptButtons();
}

function buildGlobalBeacons() {
  globalBeacons.clear();
  for (const g of L.globalMinima) {
    const w = terrain.fnToWorld(g.x, g.z);
    const b = makeBeacon('#3dff9e');
    b.position.set(w.x, terrain.heightAt(w.x, w.z), w.z);
    globalBeacons.add(b);
  }
  globalBeacons.visible = showGlobal;
}

// ---------- minima detection ----------

/** Counts the minimum whose basin you're standing in, once you're within `detectRadius` of it. */
function detectMinimum() {
  const p = terrain.worldToFn(player.pos.x, player.pos.z);
  const m = findLocalMin(L, p.x, p.z);
  if (!m.converged) return;
  const mw = terrain.fnToWorld(m.x, m.z);
  if (Math.hypot(mw.x - player.pos.x, mw.z - player.pos.z) > detectRadius) return;
  recordMinimum(m, mw);
}

/**
 * Spotting with the flashlight: a local minimum inside the lit beam counts as found (the global
 * minimum only counts once you walk up to it, via detectMinimum). The beam is
 * covered with seeds on a fixed world grid; each slides downhill to its own minimum. Results are
 * cached per grid cell (sweeping back over ground is free) and new cells are worked through a
 * little each frame, since on Wilds each slide is fairly expensive.
 */
const SPOT_CELL = 1.5;
const spotCache = new Map<string, { m: LocalMin; mw: Point2 } | null>();
let spotQueue: { key: string; x: number; z: number }[] = [];

function queueBeamSeeds(beam: RevealShape) {
  const lit = shapeDistance(beam);
  spotQueue = [];
  const r = beam.radius, i0 = Math.floor((beam.x - r) / SPOT_CELL), i1 = Math.ceil((beam.x + r) / SPOT_CELL);
  const j0 = Math.floor((beam.z - r) / SPOT_CELL), j1 = Math.ceil((beam.z + r) / SPOT_CELL);
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const x = (i + 0.5) * SPOT_CELL, z = (j + 0.5) * SPOT_CELL;
      if (lit(x, z) <= 0) continue;
      const key = `${i},${j}`;
      const hit = spotCache.get(key);
      if (hit === undefined) spotQueue.push({ key, x, z });
      else if (hit && lit(hit.mw.x, hit.mw.z) > 0) spotMinimum(hit);
    }
  // Nearest first: that's where you're looking most closely.
  spotQueue.sort((a, b) => Math.hypot(b.x - beam.x, b.z - beam.z) - Math.hypot(a.x - beam.x, a.z - beam.z));
}

function processBeamSeeds(budgetMs: number) {
  const beam = flashlightShape(player.pos);
  if (!beam) return void (spotQueue = []);
  const lit = shapeDistance(beam);
  const t0 = performance.now();
  while (spotQueue.length && performance.now() - t0 < budgetMs) {
    const s = spotQueue.pop()!;
    const sp = terrain.worldToFn(s.x, s.z);
    const m = findLocalMin(L, sp.x, sp.z);
    const hit = m.converged ? { m, mw: terrain.fnToWorld(m.x, m.z) } : null;
    spotCache.set(s.key, hit);
    if (hit && lit(hit.mw.x, hit.mw.z) > 0) spotMinimum(hit);
  }
}

function spotMinimum(hit: { m: LocalMin; mw: Point2 }) {
  if (!isGlobalMin(hit.m)) recordMinimum(hit.m, hit.mw);
}

/** A minimum just off the map edge can leave near-zero loss at the edge; only on-map ones count. */
function isGlobalMin(m: LocalMin) {
  const tol = 0.05 * Math.min(10, L.xRange[1] - L.xRange[0]);
  return m.loss < 1e-3 && L.globalMinima.some((g) => Math.hypot(g.x - m.x, g.z - m.z) < tol);
}

function recordMinimum(m: LocalMin, mw: Point2) {
  // Same minimum if it's within a hair of one we've already found (rounding-based keys
  // split one minimum into several when it sits on a rounding boundary like ±0.00).
  for (const f of found.values()) if (Math.hypot(f.p.x - mw.x, f.p.z - mw.z) < 0.25) return;
  const global = isGlobalMin(m);
  found.set(`${found.size}`, { p: mw, global });

  const beacon = makeBeacon(global ? '#ffd24a' : '#19e0ff');
  beacon.position.set(mw.x, terrain.heightAt(mw.x, mw.z), mw.z);
  (global ? foundBeacons : localBeacons).add(beacon);
  updateProgress();
  if (global) showWin(m.loss);
  else if (prefs.localMins) localToast(m.loss, m);
}

function localToast(loss: number, at: Point2) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    <div class="t">⭐ Local minimum</div>
    <div class="s">loss ${loss.toFixed(4)} at (${at.x.toFixed(2)}, ${at.z.toFixed(2)}) · keep looking for something lower</div>`;
  $('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2200);
  setTimeout(() => el.remove(), 2700);
}

function showWin(loss: number) {
  if (player.locked) document.exitPointerLock(); // free the mouse for the buttons
  const secs = Math.round(clock.elapsedTime - gameStart);
  const nGlobal = [...found.values()].filter((f) => f.global).length;
  const nLocal = found.size - nGlobal;
  const of = L.globalMinima.length > 1 ? ` (${nGlobal} of ${L.globalMinima.length})` : '';
  $('win-title').textContent = `Global minimum found${of}!`;
  $('win-stats').innerHTML = [
    ['time', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`],
    ['walked', `${walked.toFixed(0)} units`],
    ['explored', $('explored').textContent!],
    ['local minima passed', String(nLocal)],
    ['loss', loss.toExponential(1)],
  ]
    .map(([k, v]) => `<div>${k} <b>${v}</b></div>`)
    .join('');
  $('win').hidden = false;
  $('play-again').focus();

  const box = $('toasts');
  for (let i = 0; i < 14; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.textContent = ['🎉', '🎊', '✨', '🎈'][i % 4];
    c.style.left = `${4 + i * 7}%`;
    c.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    c.style.animationDelay = `${Math.random() * 0.5}s`;
    box.append(c);
    setTimeout(() => c.remove(), 4500);
  }
}

function hideWin() {
  $('win').hidden = true;
  (document.activeElement as HTMLElement | null)?.blur?.();
}

function updateProgress() {
  let local = 0, glob = 0;
  for (const f of found.values()) f.global ? glob++ : local++;
  $('n-local').textContent = String(local);
  $('n-global').textContent = `${glob} / ${L.globalMinima.length}`;
}

// ---------- optimizer ----------

function toWorld(p: Point2) {
  const w = terrain.fnToWorld(p.x, p.z);
  return new THREE.Vector3(w.x, terrain.heightAt(w.x, w.z) + TRAIL_OFFSET, w.z);
}

/** Starts a fresh run from the player's position. */
function runOpt() {
  const start = terrain.worldToFn(player.pos.x, player.pos.z);
  optRun = new OptimizerRun(L, start, optimizer);
  optLegs = [];
  optWorld = [toWorld(start)];
  optTrail.setPoints(optWorld);
  optTrail.reveal(0);
  optShown = 0;
  optHead.visible = true;
  hideIntro(); // make room to watch
  continueOpt();
}

/**
 * Takes another batch of steps from wherever the optimizer is. Picking a different optimizer
 * in between carries on from the same spot with that optimizer's state starting fresh; a new
 * learning rate just applies from here on.
 */
function continueOpt() {
  if (!optRun) return runOpt();
  if (optRun.opt !== optimizer) optRun = new OptimizerRun(L, optRun.p, optimizer);
  const steps = optRun.step(lr(), Number($<HTMLInputElement>('steps').value), tricks());
  for (const s of steps) {
    const w = toWorld(s);
    optWorld.push(w);
    optTrail.push(w);
  }
  optTrail.reveal(Math.floor(optShown));
  const leg = optLegs[optLegs.length - 1];
  if (leg && leg.opt === optimizer) leg.steps += steps.length;
  else optLegs.push({ opt: optimizer, steps: steps.length });

  const label = (id: OptimizerId) => OPTIMIZERS.find((o) => o.id === id)!.label;
  const total = optLegs.reduce((n, l) => n + l.steps, 0);
  const who = optLegs.length === 1 ? label(optLegs[0].opt) : optLegs.map((l) => `${label(l.opt)} ${l.steps}`).join(' → ');
  const at = optRun.p, loss = L.f(at.x, at.z);
  $('opt-result').textContent =
    `${who}: ${total} steps → loss ${loss.toFixed(4)} at (${at.x.toFixed(2)}, ${at.z.toFixed(2)})` +
    trickSummary() +
    (optRun.diverged ? ' · diverged, lower the learning rate' : '');
  renderOptButtons();
}

function tricks(): OptTricks {
  return { schedule: prefs.schedule, period: Number($<HTMLInputElement>('steps').value), noise: prefs.noise, sam: prefs.sam };
}

function trickSummary() {
  const parts: string[] = [];
  if (prefs.schedule !== 'constant') parts.push(`${prefs.schedule} (lr now ×${optRun!.lrFactor.toFixed(2)})`);
  if (prefs.noise > 0) parts.push(`noise ${prefs.noise.toFixed(2)}`);
  if (prefs.sam) parts.push('SAM');
  // Jumpy runs can leave a good spot behind, so say where the best one was.
  const b = optRun!.best;
  if (b.t !== optRun!.t && b.loss < L.f(optRun!.p.x, optRun!.p.z) - 1e-6) parts.push(`best ${b.loss.toFixed(4)} at step ${b.t}`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

function renderSchedules() {
  $('schedule').replaceChildren(
    ...SCHEDULES.map((sc) => {
      const b = document.createElement('button');
      b.textContent = sc.label;
      b.classList.toggle('active', sc.id === prefs.schedule);
      b.onclick = () => {
        setPrefs({ schedule: sc.id });
        renderSchedules();
      };
      return b;
    }),
  );
  $('schedule-hint').textContent = SCHEDULES.find((sc) => sc.id === prefs.schedule)!.hint;
}

function renderOptButtons() {
  const n = $<HTMLInputElement>('steps').value;
  $('continue').hidden = !optRun;
  $('continue').textContent = `⏩ Continue ${n} more steps`;
}

const optPlaying = () => optWorld.length > 0 && optShown < optWorld.length;

function stepOptAnimation(dt: number) {
  $('opt-skip').hidden = !optPlaying();
  if (!optPlaying()) return;
  const prev = Math.floor(optShown);
  optShown = Math.min(optWorld.length, optShown + (Number.isFinite(dt) ? dt * prefs.optSpeed : Infinity));
  const now = Math.floor(optShown);
  for (let i = prev; i < now; i++) terrain.reveal(optWorld[i].x, optWorld[i].z, OPT_REVEAL_RADIUS);
  optTrail.reveal(now);
  // The ball glides between steps (along the ground), so slow playback still looks smooth.
  const f = Math.max(0, optShown - 1), i0 = Math.floor(f), i1 = Math.min(optWorld.length - 1, i0 + 1);
  optHead.position.lerpVectors(optWorld[i0], optWorld[i1], f - i0);
  optHead.position.y = terrain.heightAt(optHead.position.x, optHead.position.z) + TRAIL_OFFSET;
}

/**
 * Where the optimizer is, for as long as there's a run: a marker with its distance above the
 * ball when it's in view, or an arrow at the edge of the view pointing to it when it's off
 * screen or behind you.
 */
const optPointer = $('opt-pointer');
const camSpace = new THREE.Vector3(), ndc = new THREE.Vector3();
function updateOptPointer() {
  if (!optHead.visible) return void (optPointer.hidden = true);
  camera.updateMatrixWorld();
  camSpace.copy(optHead.position).applyMatrix4(camera.matrixWorldInverse); // x right, y up, -z ahead
  ndc.copy(optHead.position).project(camera);
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const d = optHead.position.distanceTo(player.pos);
  optPointer.hidden = false;
  const label = optPointer.querySelector('span')!;
  label.textContent = `optimizer · ${d < 10 ? d.toFixed(1) : Math.round(d)} m`;
  // Centered under the arrow, but kept inside the view near its left and right edges.
  const place = (x: number, y: number) => {
    optPointer.style.transform = `translate(${x}px, ${y}px)`;
    const half = label.offsetWidth / 2 + 6;
    label.style.marginLeft = `${Math.min(0, w - x - half) + Math.max(0, half - x)}px`;
  };
  const inView = camSpace.z < 0 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
  optPointer.classList.toggle('above', inView);
  if (inView) {
    // Pointing down at the ball from just above its top (it looks big up close).
    const top = ndc.copy(optHead.position).setY(optHead.position.y + 0.25).project(camera);
    place(((top.x + 1) / 2) * w, ((1 - top.y) / 2) * h - 12);
    optPointer.style.setProperty('--angle', `${Math.PI / 2}rad`);
    return;
  }
  let dx = camSpace.x, dy = camSpace.y;
  // Behind you: on the left or right edge, whichever way is the shorter turn.
  if (camSpace.z > 0) (dx = dx < 0 ? -1 : 1), (dy = 0);
  const m = 40, t = Math.min((w / 2 - m) / Math.abs(dx || 1e-9), (h / 2 - m) / Math.abs(dy || 1e-9));
  place(w / 2 + dx * t, h / 2 - dy * t);
  optPointer.style.setProperty('--angle', `${Math.atan2(-dy, dx)}rad`);
}

// ---------- UI ----------

function renderLandscapeButtons() {
  const box = $('landscapes');
  box.replaceChildren(
    ...LANDSCAPE_ORDER.map((id) => {
      const b = document.createElement('button');
      b.className = `card${id === L.id ? ' active' : ''}`;
      b.innerHTML = `<b>${LANDSCAPES[id].name}</b><span>${LANDSCAPES[id].description}</span>`;
      b.onclick = () => id !== L.id && loadLandscape(id);
      return b;
    }),
  );
}

function renderThemeControls() {
  $('themes').replaceChildren(
    ...THEMES.map((t) => {
      const b = document.createElement('button');
      b.className = `chip${t.id === style.theme ? ' active' : ''}`;
      b.innerHTML = `<i style="background: ${themeSwatch(t.id, style.solid)}"></i>${t.label}`;
      b.onclick = () => setStyle({ theme: t.id });
      return b;
    }),
  );
  $('solid-row').classList.toggle('hidden', style.theme !== 'solid');
  $<HTMLInputElement>('solid-color').value = style.solid;
  $<HTMLInputElement>('contours').checked = style.contours;
}

function renderOptimizerButtons() {
  $('optimizers').replaceChildren(
    ...OPTIMIZERS.map((o) => {
      const b = document.createElement('button');
      b.className = `opt${o.id === optimizer ? ' active' : ''}`;
      b.textContent = o.label;
      b.onclick = () => {
        optimizer = o.id;
        setLrDefault();
        renderOptimizerButtons();
      };
      return b;
    }),
  );
}

const lrInput = $<HTMLInputElement>('lr');
const lr = () => 10 ** Number(lrInput.value);
function setLrDefault() {
  lrInput.value = String(Math.log10(L.lr[optimizer]));
  syncOutputs();
}

function syncOutputs() {
  const v = lr();
  $('lr-out').textContent = v >= 0.01 ? v.toFixed(3) : v.toExponential(1);
  $('steps-out').textContent = $<HTMLInputElement>('steps').value;
  $('det-out').textContent = detectRadius.toFixed(2);
  $('sens-out').textContent = `${$<HTMLInputElement>('sens').value}×`;
}

/** Mouse look is per view, so this runs on both setting and view changes. */
function syncMouseLook() {
  if (!player.mouseLook && player.locked) document.exitPointerLock();
  viewport.classList.toggle('mouselook', player.mouseLook);
  $<HTMLInputElement>('capture').checked = player.mouseLook;
  $('capture-view').textContent = player.mode === 'first' ? 'first person' : 'third person';
}

function applyMode(mode: ViewMode) {
  viewport.classList.toggle('first', mode === 'first');
  syncMouseLook();
  $('hud-mode').textContent = mode === 'first' ? 'FIRST PERSON' : 'THIRD PERSON';
  for (const b of $('view-mode').querySelectorAll<HTMLButtonElement>('button'))
    b.classList.toggle('active', b.dataset.mode === mode);
  renderKeyHelp();
}

function keyRows(): [string, string][] {
  const first = player.mode === 'first';
  const look: [string, string] = player.mouseLook
    ? ['Mouse', `${first ? 'look' : 'orbit camera'} (click view to capture)`]
    : ['Drag', first ? 'look' : 'orbit camera'];
  const move: [string, string][] = player.tank
    ? [['W / S', 'forward / back'], [first ? 'A / D · Q / E' : 'A / D', 'turn']]
    : [['W A S D', first ? 'walk / strafe' : 'move, relative to camera']];
  const rows: [string, string][] = [look, ...move];
  if (!first) rows.push(['Wheel · Q / E', 'zoom · turn camera']);
  else if (!player.tank) rows.push(['Q / E', 'turn']);
  rows.push(['Space', 'jump']);
  rows.push(['Shift', 'sprint']);
  rows.push(['C', 'first / third person']);
  rows.push(['F', 'lantern / flashlight']);
  rows.push(['O', 'full screen']);
  if (player.mouseLook) rows.push(['Esc', 'release mouse']);
  return rows;
}

const keyList = (rows: [string, string][]) =>
  rows.map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join('');

function renderKeyHelp() {
  $('key-help').innerHTML = keyList(keyRows());
  $('intro-keys').innerHTML = keyList(keyRows().filter(([k]) => k !== 'Esc'));
}

/**
 * The goal and controls, shown over the view when the page opens (after the tour, on a first
 * visit). It fades out after a while, sooner once you've walked a few steps, and the same key
 * list stays in the sidebar.
 */
const INTRO_SECONDS = 10, INTRO_WALK = 6;
let introUntil: { t: number; walked: number } | null = null;
function showIntro() {
  introUntil = { t: clock.elapsedTime + INTRO_SECONDS, walked: walked + INTRO_WALK };
  $('intro').classList.add('show');
}
function hideIntro() {
  introUntil = null;
  $('intro').classList.remove('show');
}
function runTour() {
  hideIntro();
  player.held.clear(); // the tour swallows key releases
  if (document.pointerLockElement) document.exitPointerLock();
  startTour();
}
$('tour-btn').onclick = runTour;

player.onModeChange = applyMode;
player.onLockChange = (locked) => viewport.classList.toggle('locked', locked);
canvas.addEventListener('mousedown', () => !player.mouseLook && viewport.classList.add('dragging'));
window.addEventListener('mouseup', () => viewport.classList.remove('dragging'));

for (const b of $('view-mode').querySelectorAll<HTMLButtonElement>('button'))
  b.onclick = () => player.setMode(b.dataset.mode as ViewMode);
$<HTMLInputElement>('tank').onchange = (e) => {
  player.tank = (e.target as HTMLInputElement).checked;
  renderKeyHelp();
};
for (const b of $('light-kind').querySelectorAll<HTMLButtonElement>('button'))
  b.onclick = () => setPrefs({ light: b.dataset.kind as LightKind });
$<HTMLInputElement>('light-radius').oninput = (e) =>
  setPrefs({ revealRadius: Number((e.target as HTMLInputElement).value) });
$<HTMLInputElement>('sens').oninput = (e) => {
  player.sensitivity = 0.0022 * Number((e.target as HTMLInputElement).value);
  syncOutputs();
};
lrInput.oninput = syncOutputs;
$<HTMLInputElement>('noise').oninput = (e) => setPrefs({ noise: Number((e.target as HTMLInputElement).value) });
$<HTMLInputElement>('sam').onchange = (e) => setPrefs({ sam: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>('opt-speed').oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  setPrefs({ optSpeed: OPT_SPEED_MIN * (OPT_SPEED_MAX / OPT_SPEED_MIN) ** v });
};
$<HTMLInputElement>('opt-watch').onchange = (e) => setPrefs({ optWatch: (e.target as HTMLInputElement).checked });
$('opt-skip').onclick = () => stepOptAnimation(Infinity); // plays the rest at once
$<HTMLInputElement>('steps').oninput = () => {
  syncOutputs();
  renderOptButtons();
};
$<HTMLInputElement>('det').oninput = (e) => {
  detectRadius = Number((e.target as HTMLInputElement).value);
  movedSinceDetect = true;
  syncOutputs();
};
$<HTMLInputElement>('solid-color').oninput = (e) => setStyle({ solid: (e.target as HTMLInputElement).value });
$<HTMLInputElement>('contours').onchange = (e) => setStyle({ contours: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>('lights').onchange = (e) => setPrefs({ lights: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>('show-path').onchange = (e) => setPrefs({ path: (e.target as HTMLInputElement).checked });
// ---------- full screen ----------

// The 3-D view goes full screen on its own; the map and status readout move into a corner of
// it (keeping their ids, so they update as usual) and go back to the sidebar afterwards.
const fsMoved = [document.querySelector('.minimap-wrap')!, $('sec-status').querySelector('.readout')!];
const fsHomes = fsMoved.map((el) => ({ parent: el.parentElement!, next: el.nextSibling }));
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (viewport.requestFullscreen)
    viewport.requestFullscreen().then(() => void resumeLook(), () => {});
}
document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === viewport;
  viewport.classList.toggle('fullscreen', on);
  $('fullscreen').title = on ? 'Exit full screen (O)' : 'Full screen (O)';
  if (on) $('fs-hud').append(...fsMoved);
  else fsMoved.forEach((el, i) => fsHomes[i].parent.insertBefore(el, fsHomes[i].next));
});
$('fullscreen').onclick = toggleFullscreen;

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!$('win').hidden && (e.code === 'Enter' || e.code === 'Escape')) {
    e.preventDefault();
    e.code === 'Enter' ? newGame() : hideWin();
    return;
  }
  if (e.code === 'KeyL') setPrefs({ lights: !prefs.lights });
  if (e.code === 'KeyP') setPrefs({ path: !prefs.path });
  if (e.code === 'KeyF') setPrefs({ light: prefs.light === 'lantern' ? 'flashlight' : 'lantern' });
  if (e.code === 'KeyO') toggleFullscreen();
});
$('run').onclick = runOpt;
$('continue').onclick = continueOpt;
$('respawn').onclick = newGame;
// Clicking a button counts as a user gesture, so mouse look can be re-captured right away.
const resumeLook = () => player.mouseLook && canvas.requestPointerLock();
$('play-again').onclick = () => (newGame(), resumeLook());
$('keep-exploring').onclick = () => (hideWin(), resumeLook());
// One checkbox, remembered separately for each view.
$<HTMLInputElement>('capture').onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked;
  setPrefs(player.mode === 'first' ? { mouseLookFirst: on } : { mouseLookThird: on });
};
$<HTMLInputElement>('hills').onchange = (e) => setPrefs({ hills: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>('local-mins').onchange = (e) => setPrefs({ localMins: (e.target as HTMLInputElement).checked });
$('min-at').replaceChildren(
  ...PLACEMENTS.map((p) => {
    const b = document.createElement('button');
    b.dataset.id = p.id;
    b.textContent = p.label;
    b.onclick = () => {
      setPrefs({ minAt: p.id });
      renderPlacement();
      buildWorld(true);
    };
    return b;
  }),
);
$('minimap').addEventListener('click', (e) => {
  if (prefs.minAt !== 'pick' || !minimap.isMapClick(e.offsetX, e.offsetY)) return;
  const { u, v } = minimap.toMapFraction(e.offsetX, e.offsetY);
  setPrefs({ minU: Math.min(1, Math.max(0, u)), minV: Math.min(1, Math.max(0, v)) });
  buildWorld(false);
});
$('show-global').onclick = (e) => {
  showGlobal = !showGlobal;
  globalBeacons.visible = showGlobal;
  const b = e.currentTarget as HTMLElement;
  b.classList.toggle('on', showGlobal);
  b.textContent = showGlobal ? '★ Hide global minima' : '★ Show global minima';
};

// On-screen movement pad (touch / mouse).
for (const b of document.querySelectorAll<HTMLButtonElement>('.pad button')) {
  const a = b.dataset.action!;
  const up = () => (player.held.delete(a), b.classList.remove('held'));
  b.onpointerdown = (e) => (b.setPointerCapture(e.pointerId), player.held.add(a), b.classList.add('held'));
  b.onpointerup = up;
  b.onpointercancel = up;
}

// ---------- loop ----------

let readoutTimer = 0;
const minimapState = () => ({
  trail: prefs.path ? trailPts : [],
  optPath: optWorld.slice(0, Math.floor(optShown)).map((v) => ({ x: v.x, z: v.z })),
  found: [...found.values()].filter((f) => f.global || prefs.localMins),
  globalMinima: showGlobal ? L.globalMinima.map((g) => terrain.fnToWorld(g.x, g.z)) : null,
  avatar: { x: player.pos.x, z: player.pos.z },
  heading: player.heading,
  yaw: player.yaw,
  fov: 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect),
});

/** Where the last reveal was aimed, so the flashlight knows when you've turned. */
let revealYaw = NaN;

/** Beam reach where it was last revealed, so looking up or down re-reveals too. */
let revealReach = NaN;

/**
 * Where the flashlight points: the ground spot it's aimed at and how far the lit beam reaches.
 * In first person it follows your view up and down: the pool of light is centered where the
 * center of the view meets the ground, and it's bigger the farther away that is, up to the full
 * reach when you look at the horizon or sky. In third person the camera's tilt is just the
 * orbit, so it aims level, as far as it goes.
 */
const beamAim = { reach: 0, pool: 0, x: 0, z: 0 };
const aimDir = new THREE.Vector3();

function updateBeamAim(pos: THREE.Vector3) {
  // The farthest the pool can land, with its far rim at the full reach.
  const far = (prefs.revealRadius * FLASH_REACH) / (1 + FLASH_POOL);
  let d = far;
  if (player.mode === 'first') {
    camera.getWorldDirection(aimDir);
    const o = camera.position, flat = Math.hypot(aimDir.x, aimDir.z);
    // March along the view ray until it dips below the ground; looking at the sky or past
    // the farthest landing spot aims it as far as it goes.
    if (aimDir.y < 0 && flat > 1e-6)
      for (let t = 0.25; t * flat <= far; t += 0.25) {
        const x = o.x + aimDir.x * t, z = o.z + aimDir.z * t;
        if (o.y + aimDir.y * t > terrain.heightAt(x, z)) continue;
        d = Math.max(FLASH_MIN_AIM, t * flat);
        break;
      }
  }
  beamAim.pool = Math.max(FLASH_FOOT, FLASH_POOL * d);
  beamAim.reach = d + beamAim.pool;
  beamAim.x = pos.x + Math.sin(player.yaw) * d;
  beamAim.z = pos.z + Math.cos(player.yaw) * d;
}

function revealAround(pos: THREE.Vector3) {
  revealYaw = player.yaw;
  revealReach = beamAim.reach;
  const beam = flashlightShape(pos);
  if (beam) terrain.revealShape(beam);
  else terrain.reveal(pos.x, pos.z, prefs.revealRadius);
}

/** The flashlight's lit area right now, or null with the lantern. */
function flashlightShape(pos: Point2): RevealShape | null {
  if (prefs.light !== 'flashlight') return null;
  return {
    x: pos.x,
    z: pos.z,
    radius: beamAim.reach,
    dir: { x: Math.sin(player.yaw), z: Math.cos(player.yaw) },
    foot: FLASH_FOOT,
    pool: beamAim.pool,
    // A wide fade at the rim, so the lit pool melts into the dark instead of ending in a hard circle.
    edge: FLASH_EDGE * beamAim.pool,
  };
}

/** Points the spotlight down the beam, onto the ground about two thirds of the way out. */
function aimFlashlight(lantern: number) {
  const f = avatar.flashlight, reach = beamAim.reach;
  f.target.position.set(beamAim.x, terrain.heightAt(beamAim.x, beamAim.z), beamAim.z);
  f.color.copy(terrain.lanternColor);
  // A wide cone with the full penumbra fades smoothly from the middle out, so the pool has no
  // hard rim, and the lantern's faint glow keeps the ground around it from going black.
  f.angle = FLASH_HALF * 1.7;
  f.distance = reach * 2;
  // Light spills past the revealed beam, fading out by twice its reach. It doesn't dim with
  // distance before that, so the pool is equally bright near or far and never glares up close.
  f.intensity = lantern * 0.06;
  avatar.lantern.intensity *= 0.3;
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (prefs.optWatch && optPlaying() && optHead.visible) player.lookToward(optHead.position, dt);
  const moved = player.update(dt, terrain);
  const pos = player.pos;
  // Build a little more of the map each frame, nearest first, and skip drawing what the fog hides.
  terrain.update(pos.x, pos.z, 4, fog.far);
  // Snapped to whole shadow texels (along the shadow map's own axes), so shadow edges don't
  // crawl as the box follows you.
  const texel = (2 * SUN_BOX) / sun.shadow.mapSize.x;
  const a = Math.round(pos.dot(SUN_RIGHT) / texel) * texel, b = Math.round(pos.dot(SUN_UP) / texel) * texel;
  sun.target.position.copy(SUN_FWD).multiplyScalar(pos.dot(SUN_FWD)).addScaledVector(SUN_RIGHT, a).addScaledVector(SUN_UP, b);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  stars.position.copy(camera.position);
  walked += moved;
  if (introUntil && (t > introUntil.t || walked > introUntil.walked)) hideIntro();
  // The flashlight reveals as you turn, not just as you walk.
  if (prefs.light === 'flashlight') updateBeamAim(pos);
  const turned = Number.isNaN(revealYaw) ||
    (prefs.light === 'flashlight' &&
      (Math.abs(wrapAngle(player.yaw - revealYaw)) > 0.004 || Math.abs(beamAim.reach - revealReach) > 0.05));
  if (moved > 0 || turned || trailPts.length === 0) revealAround(pos);
  const beam = (moved > 0 || turned) && flashlightShape(pos);
  if (beam) queueBeamSeeds(beam);
  processBeamSeeds(1.5);
  if (moved > 0 || trailPts.length === 0) {
    movedSinceDetect = true;
    const last = trailPts[trailPts.length - 1];
    if (!last || Math.hypot(last.x - pos.x, last.z - pos.z) > 0.35) {
      trailPts.push({ x: pos.x, z: pos.z });
      trail.push(new THREE.Vector3(pos.x, terrain.heightAt(pos.x, pos.z) + TRAIL_OFFSET, pos.z));
    }
  }

  avatar.group.position.copy(pos);
  avatar.group.rotation.y = player.heading;
  avatar.body.visible = player.mode === 'third';
  const lantern = prefs.lights ? 10 : 60 * terrain.nightLight;
  avatar.lantern.color.copy(terrain.lanternColor);
  avatar.lantern.intensity = lantern * (1 + Math.sin(t * 9) * 0.033 + Math.sin(t * 23) * 0.025); // flicker
  if (prefs.light === 'flashlight') aimFlashlight(lantern);

  stepOptAnimation(dt);

  for (const g of [localBeacons, foundBeacons, globalBeacons])
    for (const b of g.children) {
      const gem = b.userData.gem as THREE.Mesh;
      gem.rotation.y = t * 1.5;
      gem.position.y = 1.4 + Math.sin(t * 2 + b.position.x) * 0.15;
    }

  detectTimer -= dt;
  if (detectTimer <= 0 && movedSinceDetect) {
    detectTimer = 0.15;
    movedSinceDetect = false;
    detectMinimum();
  }

  readoutTimer -= dt;
  if (readoutTimer <= 0) {
    readoutTimer = 0.1;
    const p = terrain.worldToFn(pos.x, pos.z);
    const g = gradient(L, p.x, p.z);
    $('px').textContent = p.x.toFixed(3);
    $('pz').textContent = p.z.toFixed(3);
    $('ploss').textContent = L.f(p.x, p.z).toFixed(4);
    $('pgrad').textContent = Math.hypot(g.x, g.z).toFixed(3);
    const sector = sectorName(pos.x, pos.z, terrain.size);
    $('sector-row').hidden = !sector;
    $('psector').textContent = sector;
    const pct = (100 * terrain.exploredCount) / terrain.explored.length;
    $('explored').textContent = `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
  }

  updateOptPointer();
  minimap.draw(terrain, minimapState());
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

renderOptimizerButtons();
renderThemeControls();
renderPlacement();
renderMapSizes();
renderSchedules();
initCollapsibleSections();
loadLandscape('wilds');
applyPrefs();
applyMode(player.mode);
if (tourSeen()) showIntro();
else runTour();
syncOutputs();
requestAnimationFrame(frame);
