import type { Terrain } from './terrain';
import type { Point2 } from './landscapes';

export interface MinimapState {
  trail: Point2[]; // world coords
  optPath: Point2[]; // world coords, already sliced to the animated length
  found: { p: Point2; global: boolean }[]; // world coords
  globalMinima: Point2[] | null; // world coords, when "show" is on
  avatar: Point2;
  heading: number;
  yaw: number;
  fov: number; // horizontal, radians
}

export const MINIMAP_ZOOMS = [1, 2, 4, 8];

/** Sectors across for a map size: none on small maps, roughly 25 world units each otherwise. */
export function sectorsFor(size: number) {
  return size < 100 ? 0 : Math.round(size / 25);
}

/** Sector name like "C4" (column letter left → right, row number top → bottom), or "". */
export function sectorName(wx: number, wz: number, size: number) {
  const n = sectorsFor(size);
  if (!n) return '';
  const col = Math.min(n - 1, Math.max(0, Math.floor((wx / size + 0.5) * n)));
  const row = Math.min(n - 1, Math.max(0, Math.floor((wz / size + 0.5) * n)));
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private fog: HTMLCanvasElement;
  private fogCtx: CanvasRenderingContext2D;
  private fogImg: ImageData | null = null;
  private fogTime = -Infinity;
  /** Index into MINIMAP_ZOOMS. */
  zoomLevel = 1;
  /**
   * Follow mode (the ⌖ toggle): the map keeps the player centered. You can still pan or zoom
   * away, but moving snaps it back. With follow off, the map stays wherever you leave it.
   */
  followMode = true;
  /** Whether the view is centered on the player right now. */
  following = true;
  private pan = { x: 0, z: 0 };
  private avatar = { x: 0, z: 0 };
  /** Where the player was when the view was last panned away, to notice them moving. */
  private panAvatar = { x: 0, z: 0 };
  onViewChange?: () => void;
  /** The world window shown in the last draw: center and width. */
  private view = { cx: 0, cz: 0, w: 50, size: 50 };
  /** The overview inset's rectangle in canvas pixels, when shown. */
  private inset: { x: number; y: number; s: number } | null = null;
  private drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
  /** True right after a drag, so the click that ends it doesn't count as a click. */
  private justDragged = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.fog = document.createElement('canvas');
    this.fogCtx = this.fog.getContext('2d')!;
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1 : -1, e.offsetX, e.offsetY);
      },
      { passive: false },
    );
    canvas.addEventListener('mousedown', (e) => {
      if (this.inInset(e.offsetX, e.offsetY)) return;
      this.drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cz: this.view.cz, moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      const d = this.drag;
      if (!d) return;
      if (!(e.buttons & 1)) {
        // Released outside the window, so no mouseup arrived.
        this.drag = null;
        canvas.classList.remove('panning');
        return;
      }
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      const perPx = this.view.w / this.canvas.clientWidth;
      this.panTo(d.cx - dx * perPx, d.cz - dy * perPx);
      canvas.classList.add('panning');
    });
    window.addEventListener('mouseup', () => {
      this.justDragged = !!this.drag?.moved;
      this.drag = null;
      canvas.classList.remove('panning');
    });
    // Clicking the overview inset jumps the view there.
    canvas.addEventListener('click', (e) => {
      const r = this.inset;
      if (!r || !this.inInset(e.offsetX, e.offsetY)) return;
      const dpr = this.canvas.width / this.canvas.clientWidth;
      const size = this.view.size;
      this.panTo(((e.offsetX * dpr - r.x) / r.s - 0.5) * size, ((e.offsetY * dpr - r.y) / r.s - 0.5) * size);
    });
  }

  /**
   * Whether a click at these CSS pixels should act on the map itself (not a pan that just ended,
   * not the inset). Used for placing the minimum in "pick" mode.
   */
  isMapClick(offsetX: number, offsetY: number) {
    const dragged = this.justDragged;
    this.justDragged = false;
    return !dragged && !this.inInset(offsetX, offsetY);
  }

  private inInset(offsetX: number, offsetY: number) {
    const r = this.inset;
    if (!r) return false;
    const dpr = this.canvas.width / this.canvas.clientWidth;
    const x = offsetX * dpr, y = offsetY * dpr;
    return x >= r.x && x <= r.x + r.s && y >= r.y && y <= r.y + r.s;
  }

  private panTo(x: number, z: number) {
    this.leave();
    this.pan = { x, z };
    this.onViewChange?.();
  }

  /** Stops centering on the player, remembering where they were. */
  private leave() {
    this.following = false;
    this.panAvatar = { ...this.avatar };
  }

  setFollow(on: boolean) {
    this.followMode = on;
    if (on) this.following = true;
    else {
      this.leave();
      this.pan = { x: this.view.cx, z: this.view.cz };
    }
    this.onViewChange?.();
  }

  /** A sensible starting zoom for a map size: zoomed in, a window roughly 60 units across. */
  static defaultZoomLevel(size: number) {
    return Math.min(2, Math.max(1, Math.round(Math.log2(size / 60))));
  }

  /** Default zoom for this map size, centered on the player (e.g. a new map). */
  reset(size: number) {
    this.following = true;
    this.zoomLevel = Minimap.defaultZoomLevel(size);
    this.onViewChange?.();
  }

  get zoom() {
    return MINIMAP_ZOOMS[this.zoomLevel];
  }

  /**
   * Zooms in or out by `steps` levels. With a cursor position (CSS pixels), the point under the
   * cursor stays put, like zooming a map app; without one (the buttons) it zooms about the
   * current center.
   */
  zoomBy(steps: number, offsetX?: number, offsetY?: number) {
    const z = Math.min(MINIMAP_ZOOMS.length - 1, Math.max(0, this.zoomLevel + steps));
    if (z === this.zoomLevel) return;
    const v = this.view, W = this.canvas.clientWidth;
    if (offsetX !== undefined && offsetY !== undefined && W > 0) {
      const fx = offsetX / W - 0.5, fz = offsetY / W - 0.5;
      const px = v.cx + fx * v.w, pz = v.cz + fz * v.w; // world point under the cursor
      const w = v.size / MINIMAP_ZOOMS[z];
      this.leave();
      this.pan = { x: px - fx * w, z: pz - fz * w };
    } else if (!this.following) {
      this.pan = { x: v.cx, z: v.cz };
    }
    this.zoomLevel = z;
    this.onViewChange?.();
  }

  /** Converts a click on the minimap (CSS pixels) to a fraction (u, v) of the whole map. */
  toMapFraction(offsetX: number, offsetY: number) {
    const W = this.canvas.clientWidth, v = this.view;
    const wx = v.cx + (offsetX / W - 0.5) * v.w, wz = v.cz + (offsetY / W - 0.5) * v.w;
    return { u: wx / v.size + 0.5, v: wz / v.size + 0.5 };
  }

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr);
    if (this.canvas.width !== w) {
      this.canvas.width = this.canvas.height = w;
    }
  }

  /** Rebuilds the explored-map image, capped in resolution so big maps stay cheap to redraw. */
  private updateFog(t: Terrain) {
    const N = t.grid, M = Math.min(N, 512);
    if (this.fog.width !== M) {
      this.fog.width = this.fog.height = M;
      this.fogImg = this.fogCtx.createImageData(M, M);
    }
    const img = this.fogImg!;
    const d = img.data;
    for (let py = 0; py < M; py++) {
      const iz = Math.round((py * (N - 1)) / (M - 1));
      for (let px = 0; px < M; px++) {
        const i = iz * N + Math.round((px * (N - 1)) / (M - 1));
        const e = t.explored[i];
        const o = (py * M + px) * 4;
        if (e < 0.02) {
          d[o] = 8; d[o + 1] = 10; d[o + 2] = 18;
        } else {
          const k = 255 * (0.12 + 0.88 * e);
          d[o] = t.baseColors[i * 3] * k;
          d[o + 1] = t.baseColors[i * 3 + 1] * k;
          d[o + 2] = t.baseColors[i * 3 + 2] * k;
        }
        d[o + 3] = 255;
      }
    }
    this.fogCtx.putImageData(img, 0, 0);
    t.exploredDirty = false;
  }

  draw(t: Terrain, s: MinimapState) {
    if (!this.canvas.clientWidth) return; // its section is folded away
    this.resize();
    // Redrawing the explored image is the expensive part; a few times a second is plenty.
    const now = performance.now();
    if (!this.fogImg || this.fog.width !== Math.min(t.grid, 512) || (t.exploredDirty && now - this.fogTime > 120)) {
      this.updateFog(t);
      this.fogTime = now;
    }

    const ctx = this.ctx;
    const W = this.canvas.width;
    const k = W / 320; // scale strokes with canvas size

    // The visible window: a square following the player, or wherever it was panned to.
    this.avatar = { x: s.avatar.x, z: s.avatar.z };
    if (this.followMode && !this.following && !this.drag &&
        Math.hypot(s.avatar.x - this.panAvatar.x, s.avatar.z - this.panAvatar.z) > 0.3) {
      this.following = true;
      this.onViewChange?.();
    }
    // Zoomed in, the view stays centered on the player even at the map's edge (the view runs past
    // it) rather than stopping short and letting the player drift off-center. Zoomed all the way
    // out it's the whole map, fixed.
    const size = t.size, vw = size / this.zoom, lim = this.zoom === 1 ? 0 : size / 2;
    const focus = this.following ? s.avatar : this.pan;
    const cx = Math.min(lim, Math.max(-lim, focus.x)), cz = Math.min(lim, Math.max(-lim, focus.z));
    this.view = { cx, cz, w: vw, size };
    const map = (p: Point2) => [((p.x - cx) / vw + 0.5) * W, ((p.z - cz) / vw + 0.5) * W] as const;

    ctx.fillStyle = '#030408';
    ctx.fillRect(0, 0, W, W);
    ctx.imageSmoothingEnabled = true; // blocky pixels read as jagged edges when zoomed in
    // Only the part of the view that's on the map: source rect clipped to the image, and the
    // destination shrunk to match.
    const M = this.fog.width, sw = M / this.zoom;
    const sx = ((cx - vw / 2) / size + 0.5) * M, sy = ((cz - vw / 2) / size + 0.5) * M;
    const x0 = Math.max(0, sx), x1 = Math.min(M, sx + sw), y0 = Math.max(0, sy), y1 = Math.min(M, sy + sw);
    if (x1 > x0 && y1 > y0) {
      ctx.drawImage(this.fog, x0, y0, x1 - x0, y1 - y0,
        ((x0 - sx) / sw) * W, ((y0 - sy) / sw) * W, ((x1 - x0) / sw) * W, ((y1 - y0) / sw) * W);
    }
    const [bx0, by0] = map({ x: -size / 2, z: -size / 2 });
    const [bx1, by1] = map({ x: size / 2, z: size / 2 });
    ctx.strokeStyle = 'rgba(223, 227, 240, 0.3)';
    ctx.lineWidth = 1 * k;
    ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
    this.drawSectors(size, map, W, k);

    const polyline = (pts: Point2[], style: string, width: number) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = style;
      ctx.lineWidth = width * k;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = map(p);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    };
    polyline(s.trail, 'rgba(25, 224, 255, 0.55)', 1.5);
    polyline(s.optPath, 'rgba(255, 64, 110, 0.9)', 2);
    if (s.optPath.length) {
      const [x, y] = map(s.optPath[s.optPath.length - 1]);
      ctx.fillStyle = '#ff406e';
      ctx.beginPath();
      ctx.arc(x, y, 3.5 * k, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const f of s.found) {
      const [x, y] = map(f.p);
      ctx.strokeStyle = f.global ? '#ffd24a' : '#19e0ff';
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.arc(x, y, 5 * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (s.globalMinima) {
      for (const g of s.globalMinima) {
        const [x, y] = map(g);
        ctx.save();
        ctx.shadowColor = '#3dff9e';
        ctx.shadowBlur = 12 * k;
        ctx.fillStyle = '#3dff9e';
        star(ctx, x, y, 8 * k);
        ctx.restore();
      }
    }

    // View cone, then the avatar arrow. Map up is world -z, so direction (sin a, cos a) → (sx, sy).
    const [ax, ay] = map(s.avatar);
    const r = 34 * k;
    const a0 = s.yaw - s.fov / 2, a1 = s.yaw + s.fov / 2;
    const grad = ctx.createRadialGradient(ax, ay, 0, ax, ay, r);
    grad.addColorStop(0, 'rgba(255, 190, 90, 0.35)');
    grad.addColorStop(1, 'rgba(255, 190, 90, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    for (let i = 0; i <= 12; i++) {
      const a = a0 + ((a1 - a0) * i) / 12;
      ctx.lineTo(ax + Math.sin(a) * r, ay + Math.cos(a) * r);
    }
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(-s.heading);
    ctx.shadowColor = '#ffa630';
    ctx.shadowBlur = 8 * k;
    ctx.fillStyle = '#ffa630';
    ctx.strokeStyle = '#1a1206';
    ctx.lineWidth = 1 * k;
    ctx.beginPath();
    ctx.moveTo(0, 7 * k);
    ctx.lineTo(4.5 * k, -4.5 * k);
    ctx.lineTo(0, -2 * k);
    ctx.lineTo(-4.5 * k, -4.5 * k);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    this.drawInset(s, W, k);
  }

  /** While zoomed in: the whole map in a corner, with the current view outlined. */
  private drawInset(s: MinimapState, W: number, k: number) {
    if (this.zoom === 1) {
      this.inset = null;
      return;
    }
    const ctx = this.ctx, size = this.view.size;
    const is = Math.round(W * 0.3), x = W - is - 6 * k, y = 6 * k;
    this.inset = { x, y, s: is };
    ctx.save();
    ctx.fillStyle = 'rgba(8, 10, 18, 0.92)';
    ctx.fillRect(x - 2 * k, y - 2 * k, is + 4 * k, is + 4 * k);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fog, x, y, is, is);
    const to = (p: Point2) => [x + (p.x / size + 0.5) * is, y + (p.z / size + 0.5) * is] as const;
    const v = this.view;
    const [rx, ry] = to({ x: v.cx - v.w / 2, z: v.cz - v.w / 2 });
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, is, is);
    ctx.clip(); // the view can run past the map's edge
    ctx.strokeStyle = '#dfe3f0';
    ctx.lineWidth = 1.5 * k;
    ctx.strokeRect(rx, ry, (v.w / size) * is, (v.w / size) * is);
    ctx.restore();
    const [ax, ay] = to(s.avatar);
    ctx.fillStyle = '#ffa630';
    ctx.beginPath();
    ctx.arc(ax, ay, 2.5 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(223, 227, 240, 0.35)';
    ctx.lineWidth = 1 * k;
    ctx.strokeRect(x - 2 * k, y - 2 * k, is + 4 * k, is + 4 * k);
    ctx.restore();
  }

  /** Sector grid with column letters along the top and row numbers down the left. */
  private drawSectors(size: number, map: MapFn, W: number, k: number) {
    const n = sectorsFor(size);
    if (!n) return;
    const ctx = this.ctx, step = size / n;
    ctx.save();
    ctx.strokeStyle = 'rgba(223, 227, 240, 0.14)';
    ctx.lineWidth = 1 * k;
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const [x] = map({ x: -size / 2 + i * step, z: 0 });
      const [, y] = map({ x: 0, z: -size / 2 + i * step });
      if (x > 0 && x < W) ctx.moveTo(x, 0), ctx.lineTo(x, W);
      if (y > 0 && y < W) ctx.moveTo(0, y), ctx.lineTo(W, y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(223, 227, 240, 0.55)';
    ctx.font = `${10 * k}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < n; i++) {
      const [x0] = map({ x: -size / 2 + i * step, z: 0 });
      const [x1] = map({ x: -size / 2 + (i + 1) * step, z: 0 });
      const [, y0] = map({ x: 0, z: -size / 2 + i * step });
      const [, y1] = map({ x: 0, z: -size / 2 + (i + 1) * step });
      // Label each column/row at the middle of its visible part.
      const lx = (Math.max(0, x0) + Math.min(W, x1)) / 2, ly = (Math.max(0, y0) + Math.min(W, y1)) / 2;
      if (x1 > 0 && x0 < W) ctx.fillText(String.fromCharCode(65 + i), lx - 3 * k, 3 * k);
      if (y1 > 0 && y0 < W) ctx.fillText(String(i + 1), 3 * k, ly - 5 * k);
    }
    ctx.restore();
  }
}

export interface MapFn {
  (p: Point2): readonly [number, number];
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}
