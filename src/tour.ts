/**
 * A short guided tour, shown on the first visit (and from "Take the tour" in the header): the
 * goal first, then a spotlight on each of the most important sections with a card beside it.
 * Esc skips; Enter / → go on and ← goes back. While it runs, it swallows the game's keys.
 */

interface Step {
  /** Element to spotlight; none for a card centered on the 3-D view. */
  target?: string;
  /** Omitted for the welcome card, which brings its own heading. */
  title?: string;
  html: string | (() => string);
}

/**
 * The welcome card is the same goal-and-controls card that flashes over the view on later
 * visits (read from #intro, so the two never drift apart), then a few key sections.
 */
const STEPS: Step[] = [
  { html: () => document.getElementById('intro')!.innerHTML },
  {
    target: '#sec-game',
    title: 'Map',
    html: `<p>Pick a landscape and map size. "New game" at the top of this sidebar rolls new terrain.</p>`,
  },
  {
    target: '#sec-light',
    title: 'Light up the ground',
    html: `<p>You only discover ground you light up. The lantern lights a circle around you; the
      flashlight (<kbd>F</kbd>) lights wherever you look.</p>`,
  },
  {
    target: '#sec-map',
    title: 'Explored map',
    html: `<p>Everything you've lit so far, and the minima you've found. Scroll to zoom, drag to
      pan. "Show global minima" gives the answer away.</p>`,
  },
  {
    target: '#sec-opt',
    title: 'Optimizers',
    html: `<p>Run gradient descent, Adam and friends from where you stand and watch where they
      end up. Do they find the bottom before you do?</p>`,
  },
];

const SEEN_KEY = 'lle.toured';
const GAP = 14;

export function tourSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

let active: (() => void) | null = null;

export function startTour(onEnd?: () => void) {
  if (active) return;
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `<div class="tour-hole"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div class="tour-head"><h3 id="tour-title"></h3><span class="tour-count mono"></span></div>
      <div class="tour-body"></div>
      <div class="tour-actions">
        <button class="tour-skip" data-act="skip">Skip <kbd>Esc</kbd></button>
        <span></span>
        <button class="ghost" data-act="back">Back</button>
        <button class="primary" data-act="next"></button>
      </div>
    </div>`;
  document.body.append(root);
  const hole = root.querySelector<HTMLElement>('.tour-hole')!;
  const card = root.querySelector<HTMLElement>('.tour-card')!;
  let i = 0, raf = 0;

  const show = (n: number) => {
    i = n;
    const s = STEPS[i];
    const h3 = card.querySelector('h3')!;
    h3.textContent = s.title ?? '';
    h3.hidden = !s.title;
    card.querySelector('.tour-count')!.textContent = `${i + 1} / ${STEPS.length}`;
    card.querySelector('.tour-body')!.innerHTML = typeof s.html === 'string' ? s.html : s.html();
    card.classList.toggle('welcome', !s.target);
    card.querySelector<HTMLElement>('[data-act="back"]')!.hidden = i === 0;
    card.querySelector('[data-act="next"]')!.textContent =
      i === 0 ? 'Show me around →' : i === STEPS.length - 1 ? 'Start exploring' : 'Next →';
    const el = s.target ? document.querySelector<HTMLElement>(s.target) : null;
    if (el) {
      el.classList.remove('collapsed'); // unfold it for the tour (not remembered)
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    card.classList.toggle('centered', !el || s.target === '#viewport');
    card.querySelector<HTMLElement>('[data-act="next"]')!.focus({ preventScroll: true });
  };

  // Follows the target every frame, so smooth scrolling and resizes just work.
  const place = () => {
    raf = requestAnimationFrame(place);
    const s = STEPS[i];
    const el = s.target ? document.querySelector<HTMLElement>(s.target) : null;
    const W = innerWidth, H = innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (!el) {
      // Nothing to spotlight: dim everything, card in the middle of the 3-D view.
      const v = document.getElementById('viewport')!.getBoundingClientRect();
      hole.style.cssText = `left:${v.left + v.width / 2}px;top:${v.top + v.height / 2}px;width:0;height:0;border-width:0`;
      card.style.left = `${clamp(v.left + (v.width - cw) / 2, 8, W - cw - 8)}px`;
      card.style.top = `${clamp(v.top + (v.height - ch) / 2, 8, H - ch - 8)}px`;
      return;
    }
    // The visible part of the target (a section can be taller than its scrolling panel).
    const r = el.getBoundingClientRect();
    const clip = el.closest('.panel')?.getBoundingClientRect() ?? { top: 0, bottom: H };
    const pad = 6;
    const top = Math.max(r.top, clip.top) - pad, bottom = Math.min(r.bottom, clip.bottom) + pad;
    const left = r.left - pad, right = r.right + pad;
    hole.style.cssText = `left:${left}px;top:${top}px;width:${right - left}px;height:${Math.max(0, bottom - top)}px`;
    let x: number, y: number;
    if (s.target === '#viewport') {
      x = r.left + (r.width - cw) / 2;
      y = r.top + (r.height - ch) / 2;
    } else if (right + GAP + cw <= W - 8) {
      x = right + GAP;
      y = top;
    } else if (left - GAP - cw >= 8) {
      x = left - GAP - cw;
      y = top;
    } else {
      // Narrow screens: above or below.
      x = left;
      y = bottom + GAP + ch <= H - 8 ? bottom + GAP : top - GAP - ch;
    }
    card.style.left = `${clamp(x, 8, W - cw - 8)}px`;
    card.style.top = `${clamp(y, 8, H - ch - 8)}px`;
  };

  const end = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', swallow, true);
    root.remove();
    active = null;
    // Back to the top of both sidebars, where the tour found them.
    for (const panel of document.querySelectorAll('.panel')) panel.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {}
    onEnd?.();
  };
  const next = () => (i === STEPS.length - 1 ? end() : show(i + 1));
  const back = () => i > 0 && show(i - 1);

  // Captured on window before the game's own handlers, which never see these keys.
  const onKey = (e: KeyboardEvent) => {
    e.stopImmediatePropagation();
    if (e.code === 'Escape') end();
    else if (e.code === 'ArrowRight' || e.code === 'Enter') next();
    else if (e.code === 'ArrowLeft') back();
    else if (e.code === 'Tab') return; // keep keyboard focus moving between the buttons
    e.preventDefault();
  };
  const swallow = (e: KeyboardEvent) => e.stopImmediatePropagation();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', swallow, true);
  card.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'skip') end();
    else if (act === 'next') next();
    else if (act === 'back') back();
  });

  active = end;
  show(0);
  place();
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
