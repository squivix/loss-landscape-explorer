# Loss Landscape Explorer

A sandbox for walking around 2-D optimization test functions rendered as 3-D terrain, under fog
of war, hunting for their minima and letting gradient-based optimizers loose from wherever you
stand. A from-scratch recreation of
[landscape-explorer.aiml.lt](https://landscape-explorer.aiml.lt/) by Linas Petkevičius (AIML),
with game-style mouse + keyboard controls instead of tank controls.

```bash
npm install
npm run dev
```

## Landscapes

Ackley, Rastrigin, Beale, Rosenbrock and Himmelblau keep their textbook global minima, but every
new game rerolls their steepness; Ackley and Rastrigin also get a random rotation and a gentle
warp, and Beale and Rosenbrock get branching river valleys. Wilds is a random mix of hills, pits,
ridges, craters, mesas and rivers built around a single guaranteed global minimum.

## Map size

Small (50), Medium (100, the default), Large (160) or Huge (250) units across. The textbook
landscapes stretch to fill it, heights included, so slopes stay the same; Wilds grows more land.
The terrain is built in chunks, nearest to you first, a few milliseconds per frame, and chunks
hidden by the fog aren't drawn. Medium and larger maps get lettered/numbered sectors.

You discover ground by lighting it. The flashlight (the default) lights a pool of light wherever
the camera points, joined to a small circle at your feet by a smooth teardrop, so you can sweep
it around without walking. In first person it follows your view up and down: the pool lands
where you're aiming and grows with distance, out to "Beam reach"; its light spills faintly
farther but doesn't reveal. `F` switches to the lantern, which lights a circle around you
("Light radius"). A local minimum inside the lit beam counts as found, same as walking up to
it; the global minimum only counts once you walk up to it. The revealed area is drawn per pixel
from a fog texture, so its edge is a smooth curve.

The explored map zooms (scroll, toward the cursor, or −/+) and pans (drag). It follows you by
default, centered on you even at the map edge: pan away and it snaps back once you move. The "Follow" button toggles following off so it stays put; it turns back on with each new game or reload. While zoomed in, an
inset shows the whole map with your view outlined.

## Optimizers

Gradient descent, momentum, RMSProp and Adam start from your position; "Continue" keeps stepping
from where they stopped. A run is computed at once and played back at "Playback speed" (10 steps
a second by default, or "Skip to the end"). "Camera follows the optimizer" turns your view to
keep it in sight while it plays. A marker shows where it is and how far away: above the ball when
it's in view, or as an arrow at the edge of the view when it's off screen or behind you. Under "Escaping local minima":

- **Learning-rate schedule**: constant; cosine (warm up to 3×, cool to 0.05× over a run); warm
  restarts (three cosine cool-downs per run); cyclic (¼× ↔ 3×, three cycles per run).
- **Noise**: random jitter that cools to nothing over each run, like simulated annealing.
- **Prefer wide valleys (SAM)**: sharpness-aware minimization, which steps using the slope a little
  way uphill so narrow pits barely register.

None of them is a sure thing: noise does wonders on Ackley, schedules help in Rosenbrock's valley,
SAM helps on Beale but zigzags in Rosenbrock, and nothing much rescues Rastrigin. Jumpy runs can
leave a good spot behind, so the result line also reports the best loss seen.

## Controls

| | First person | Third person |
|---|---|---|
| Look | captured mouse (click view, `Esc` releases) | drag to orbit, wheel to zoom, `Q`/`E` |
| Move | `WASD` walk / strafe relative to view | `WASD` relative to camera; avatar turns to face movement |
| Sprint | `Shift` | `Shift` |
| Jump | `Space` (hold to keep hopping) | `Space` |

By default slopes affect speed: climbing is slow, gentle descents are a little quicker, and steep
ground covers less map either way ("Hills affect speed" in the sidebar turns this off). You start in
first person; `C` (or `V`) toggles the view. "Capture mouse" switches a view between the two look styles (remembered per view), and
"Tank controls" brings back the original A/D-turns scheme in either view.

`O` (or the button in the view's top-right corner) makes the 3-D view full screen; the explored
map and status readout come along in a corner overlay. `Esc` leaves (after releasing the mouse).

The controls flash up over the view when the page opens and fade after a few seconds (or once
you start walking); they're also listed at the top of the left sidebar.

The sidebars are grouped into Movement & camera, Map, Appearance, and Light & finding on the
left, and the map, status and optimizers on the right. Click a section's heading to fold it
away (remembered).

## Layout

- `src/landscapes.ts` – test functions, per-game variety (relief, warps, rivers, the procedural Wilds), gradients, local-min finder, optimizers
- `src/noise.ts` – seeded RNG, gradient noise, river networks
- `src/terrain.ts` – chunked heightmap built on demand, map sizes, palettes, fog-of-war reveal, world ↔ function coordinates
- `src/controls.ts` – player / camera controller
- `src/objects.ts` – avatar, trails, minimum beacons, stars
- `src/minimap.ts` – explored map: zoom, pan, overview inset, sectors
- `src/main.ts` – scene setup, UI wiring, game loop
