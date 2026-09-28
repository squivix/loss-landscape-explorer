import * as THREE from 'three';
import type { Terrain } from './terrain';

export type ViewMode = 'first' | 'third';

const WALK_SPEED = 7; // world units / second
const SPRINT_MULT = 2.2;
const KEY_TURN_SPEED = 2.2; // rad / second, for Q/E and tank turning
const EYE_HEIGHT = 1.7;
const THIRD_PERSON_TARGET = 1.1;
const CAMERA_CLEARANCE = 0.35;
const MIN_PITCH = -1.5; // nearly straight down
const MAX_ZOOM = 14;
const JUMP_SPEED = 7.5; // world units / second, straight up
const GRAVITY = 24; // so a jump peaks about 1.2 units up and lasts about 0.6 s

const KEYMAP: Record<string, string> = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyQ: 'turnL', KeyE: 'turnR',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Space: 'jump',
};

export function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

const SLOPE_PROBE = 0.4; // world units ahead/behind, wider than a grid cell to smooth facets
const MIN_SLOPE_FACTOR = 0.35; // never crawling, even up a cliff

/**
 * Horizontal speed multiplier for moving along `dir` from `pos`. Steep ground covers less map
 * either way (a softened version of measuring speed along the ground), climbing costs a little
 * extra, and gentle descents are a little quicker. `s` is rise over run along `dir`.
 */
function slopeFactor(terrain: Terrain, pos: THREE.Vector3, dir: THREE.Vector2) {
  const len = dir.length();
  const dx = (dir.x / len) * SLOPE_PROBE, dz = (dir.y / len) * SLOPE_PROBE;
  const s =
    (terrain.heightAt(pos.x + dx, pos.z + dz) - terrain.heightAt(pos.x - dx, pos.z - dz)) /
    (2 * SLOPE_PROBE); // rise over run, > 0 uphill
  // Downhill boost peaks around a 1:4 grade and fades away on steep descents (you brake).
  const effort = s > 0 ? 1 / (1 + 0.25 * s) : 1 - 1.2 * s * Math.exp(4 * s);
  return Math.max(MIN_SLOPE_FACTOR, effort / (1 + s * s) ** 0.3);
}

/**
 * Game-style controller. Yaw/pitch belong to the camera; `heading` is where the avatar faces.
 * Forward is (sin yaw, cos yaw) on the XZ plane; right is (-cos yaw, sin yaw).
 *
 * - Mouse capture (set per view): click to lock the pointer, then the mouse turns the camera.
 *   Off: drag to look instead. (`mouseLook` means "captured" in this file.)
 * - First person: WASD walks/strafes relative to view.
 * - Third person: wheel zooms, WASD moves relative to the camera and the avatar turns to face
 *   where it's going.
 * - `tank`, in either view: A/D turn instead of strafing, W/S drive forward and back.
 * - Space jumps (held, it hops again on landing). You keep steering in the air.
 */
export class PlayerController {
  readonly pos = new THREE.Vector3();
  heading = 0;
  yaw = 0;
  pitch = 0;
  distance = 9;
  mode: ViewMode = 'first';
  tank = false;
  mouseLookFirst = true;
  mouseLookThird = false;
  /** Slopes slow climbs and speed gentle descents. */
  hills = true;
  sensitivity = 0.0022;

  /** Actions currently held, from the keyboard or the on-screen buttons. */
  readonly held = new Set<string>();
  private vel = new THREE.Vector2();
  /** Vertical speed while in the air; null when standing on the ground. */
  private vy: number | null = null;
  private camDist = 9;
  /** Extra downward tilt (≤ 0) added in third person to see over terrain. */
  private pitchLift = 0;
  private dragging = false;
  onModeChange?: (mode: ViewMode) => void;
  onLockChange?: (locked: boolean) => void;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: THREE.PerspectiveCamera,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.held.clear());

    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => this.onLockChange?.(this.locked));
  }

  /** Whether mouse look is on for the current view. */
  get mouseLook() {
    return this.mode === 'first' ? this.mouseLookFirst : this.mouseLookThird;
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  setMode(mode: ViewMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'first') {
      this.yaw = this.heading;
      this.pitch = 0;
    } else {
      this.heading = this.yaw;
      this.pitch = -0.35;
    }
    if (!this.mouseLook && this.locked) document.exitPointerLock();
    this.onModeChange?.(mode);
  }

  spawn(x: number, z: number, heading: number) {
    this.pos.set(x, 0, z);
    this.heading = this.yaw = heading;
    this.vel.set(0, 0);
    this.vy = null;
  }

  get airborne() {
    return this.vy !== null;
  }

  private isTyping(e: Event) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.code === 'KeyC' || e.code === 'KeyV') && !e.repeat) {
      this.setMode(this.mode === 'first' ? 'third' : 'first');
      return;
    }
    const action = KEYMAP[e.code];
    if (action) {
      this.held.add(action);
      e.preventDefault(); // no page scrolling on arrows or Space
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const action = KEYMAP[e.code];
    if (!action) return;
    this.held.delete(action);
    // Space would otherwise also click whichever sidebar button was clicked last.
    if (e.code === 'Space') e.preventDefault();
  };

  private onMouseDown = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!this.mouseLook) this.dragging = true;
    else if (!this.locked) this.canvas.requestPointerLock();
  };

  private onMouseMove = (e: MouseEvent) => {
    const looking = this.mouseLook ? this.locked : this.dragging;
    if (!looking) return;
    this.yaw -= e.movementX * this.sensitivity;
    this.pitch -= e.movementY * this.sensitivity;
    const [lo, hi] = this.mode === 'first' ? [-1.5, 1.5] : [-1.45, 0.35];
    this.pitch = Math.min(hi, Math.max(lo, this.pitch));
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.mode !== 'third') return;
    // Capped low on purpose: zooming far out would let you survey the map from the sky.
    this.distance = Math.min(MAX_ZOOM, Math.max(3, this.distance * Math.exp(e.deltaY * 0.001)));
  };

  /** Advances the simulation. Returns how far the avatar moved (world units). */
  update(dt: number, terrain: Terrain): number {
    const h = this.held;
    const fwd = (h.has('fwd') ? 1 : 0) - (h.has('back') ? 1 : 0);
    const side = (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);
    const turn = (h.has('turnL') ? 1 : 0) - (h.has('turnR') ? 1 : 0);
    const speed = WALK_SPEED * (h.has('sprint') ? SPRINT_MULT : 1);
    const tank = this.tank;

    this.yaw += turn * KEY_TURN_SPEED * dt;

    const target = new THREE.Vector2();
    if (tank && this.mode === 'first') {
      this.yaw -= side * KEY_TURN_SPEED * dt;
      target.set(Math.sin(this.yaw), Math.cos(this.yaw)).multiplyScalar(fwd * speed);
    } else if (tank) {
      this.heading -= side * KEY_TURN_SPEED * dt;
      target.set(Math.sin(this.heading), Math.cos(this.heading)).multiplyScalar(fwd * speed);
      // Camera swings around behind the avatar.
      this.yaw += wrapAngle(this.heading - this.yaw) * (1 - Math.exp(-4 * dt));
    } else {
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      target.set(sy * fwd - cy * side, cy * fwd + sy * side);
      if (target.lengthSq() > 0) target.normalize().multiplyScalar(speed);
    }

    if (this.hills && target.lengthSq() > 0) target.multiplyScalar(slopeFactor(terrain, this.pos, target));

    // Snappy but not instant acceleration, framerate independent.
    this.vel.lerp(target, 1 - Math.exp(-14 * dt));
    if (target.lengthSq() === 0 && this.vel.lengthSq() < 1e-4) this.vel.set(0, 0);

    const before = this.pos.clone();
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.y * dt;
    const lim = terrain.size / 2 - 0.5;
    this.pos.x = Math.min(lim, Math.max(-lim, this.pos.x));
    this.pos.z = Math.min(lim, Math.max(-lim, this.pos.z));
    const ground = terrain.heightAt(this.pos.x, this.pos.z);
    if (this.vy === null && h.has('jump')) this.vy = JUMP_SPEED;
    if (this.vy === null) this.pos.y = ground;
    else {
      this.vy -= GRAVITY * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= ground) {
        this.pos.y = ground;
        this.vy = null;
      }
    }

    if (this.mode === 'first') {
      this.heading = this.yaw;
    } else if (!tank && this.vel.lengthSq() > 0.25) {
      const want = Math.atan2(this.vel.x, this.vel.y);
      this.heading += wrapAngle(want - this.heading) * (1 - Math.exp(-12 * dt));
    }

    this.placeCamera(dt, terrain);
    before.y = this.pos.y;
    return before.distanceTo(this.pos);
  }

  private placeCamera(dt: number, terrain: Terrain) {
    const cam = this.camera;

    if (this.mode === 'first') {
      const dir = this.viewDir(this.pitch);
      cam.position.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
      cam.lookAt(cam.position.clone().add(dir));
      return;
    }

    // Third person. When terrain blocks the view (walking into a hollow), lift the camera
    // over the rim instead of zooming in: find the smallest extra downward tilt that gives a
    // clear line of sight, rise toward it quickly and ease back down slowly afterwards. The
    // lift sits on top of the player's own pitch, so mouse input itself is never smoothed.
    const target = new THREE.Vector3(this.pos.x, this.pos.y + THIRD_PERSON_TARGET, this.pos.z);
    const p = new THREE.Vector3();
    const blockedAt = (pitch: number, dist: number) => {
      const dir = this.viewDir(pitch);
      for (let i = 1; i <= 24; i++) {
        const d = (i / 24) * dist;
        p.copy(target).addScaledVector(dir, -d);
        // Clearance grows along the sightline so the camera starts lifting a little early.
        if (p.y < terrain.heightAt(p.x, p.z) + CAMERA_CLEARANCE + 0.06 * d) return (i - 1) / 24;
      }
      return -1;
    };

    let need = this.pitch;
    while (need > MIN_PITCH && blockedAt(need, this.distance) >= 0) need -= 0.02;
    need = Math.max(MIN_PITCH, need);
    const want = need - this.pitch; // ≤ 0
    const rate = want < this.pitchLift ? 9 : 1.5;
    this.pitchLift += (want - this.pitchLift) * (1 - Math.exp(-rate * dt));
    const pitch = Math.max(MIN_PITCH, this.pitch + this.pitchLift);

    // Last resort, only if even looking almost straight down is blocked: pull in.
    const frac = blockedAt(need, this.distance);
    const allowed = frac < 0 ? this.distance : Math.max(1.2, frac * this.distance);
    this.camDist =
      allowed < this.camDist ? allowed : this.camDist + (allowed - this.camDist) * (1 - Math.exp(-4 * dt));

    cam.position.copy(target).addScaledVector(this.viewDir(pitch), -this.camDist);
    const floor = terrain.heightAt(cam.position.x, cam.position.z) + CAMERA_CLEARANCE;
    if (cam.position.y < floor) cam.position.y = floor;
    cam.lookAt(target);
  }

  /**
   * Turns the camera smoothly toward a point, for following something on its own. In first
   * person the view aims straight at it; in third person the camera swings round behind you,
   * facing it, and keeps its tilt. Mouse input still adds on top, but this wins over time.
   */
  lookToward(target: THREE.Vector3, dt: number) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    if (dx * dx + dz * dz < 0.01) return;
    const k = 1 - Math.exp(-5 * dt);
    this.yaw += wrapAngle(Math.atan2(dx, dz) - this.yaw) * k;
    if (this.mode !== 'first') return;
    const want = Math.atan2(target.y - (this.pos.y + EYE_HEIGHT), Math.hypot(dx, dz));
    this.pitch += (Math.min(1.5, Math.max(-1.5, want)) - this.pitch) * k;
  }

  private viewDir(pitch: number) {
    return new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(this.yaw) * Math.cos(pitch),
    );
  }
}
