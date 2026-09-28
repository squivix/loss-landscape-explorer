import * as THREE from 'three';

export function makeAvatar() {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const cloak = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.24, 0.6, 6, 16),
    new THREE.MeshStandardMaterial({ color: '#27427a', roughness: 0.7 }),
  );
  cloak.position.y = 0.55;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.19, 20, 16),
    new THREE.MeshStandardMaterial({ color: '#e7cfa6', roughness: 0.6 }),
  );
  head.position.y = 1.2;
  const hood = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.35, 16),
    new THREE.MeshStandardMaterial({ color: '#1d3260', roughness: 0.8 }),
  );
  hood.position.y = 1.42;
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.2, 8),
    new THREE.MeshStandardMaterial({ color: '#19e0ff', emissive: '#19e0ff', emissiveIntensity: 0.8 }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.55, 0.3); // marks the facing direction (+z)
  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.035, 1.5, 8),
    new THREE.MeshStandardMaterial({ color: '#6b4222', roughness: 0.9 }),
  );
  staff.position.set(0.36, 0.8, 0.12);
  staff.rotation.z = -0.12;
  body.add(cloak, head, hood, nose, staff);
  for (const m of body.children) m.castShadow = true;

  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 12),
    new THREE.MeshBasicMaterial({ color: '#ffd08a' }),
  );
  orb.position.set(0.45, 1.6, 0.12);
  body.add(orb);

  // The lantern: the only real light source in the world.
  const lantern = new THREE.PointLight('#ffb35c', 60, 26, 1.6);
  lantern.position.set(0.45, 2.2, 0.12);
  lantern.castShadow = true;
  lantern.shadow.mapSize.set(1024, 1024);
  lantern.shadow.bias = -0.002;
  // Point shadows are filtered with 9 taps spread by this many texels; the default (1) leaves
  // hard, blocky edges, especially where the shadow stretches across the ground.
  lantern.shadow.radius = 3;
  group.add(lantern);

  // The flashlight, for the beam reveal: held at head height, aimed each frame at the ground
  // ahead (its target lives in world space, so it has to be added to the scene).
  const flashlight = new THREE.SpotLight('#ffe6c4', 0, 60, 0.5, 1, 0);
  flashlight.position.set(0, 1.7, 0);
  flashlight.visible = false;
  flashlight.castShadow = true;
  flashlight.shadow.mapSize.set(1024, 1024);
  flashlight.shadow.bias = -0.002;
  flashlight.shadow.radius = 3;
  group.add(flashlight);

  return { group, body, lantern, flashlight };
}

/** A polyline that grows over time without reallocating. */
export class Trail {
  readonly line: THREE.Line;
  private positions: Float32Array;
  count = 0;

  constructor(color: string, capacity = 40000, opacity = 0.9) {
    this.positions = new Float32Array(capacity * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    this.line.frustumCulled = false;
  }

  setPoints(points: THREE.Vector3[]) {
    this.count = 0;
    for (const p of points) this.push(p);
  }

  push(p: THREE.Vector3) {
    if (this.count * 3 >= this.positions.length) return;
    this.positions.set([p.x, p.y, p.z], this.count * 3);
    this.count++;
    const attr = this.line.geometry.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, this.count);
  }

  /** Show only the first n points (for animating a precomputed path). */
  reveal(n: number) {
    this.line.geometry.setDrawRange(0, Math.min(n, this.count));
  }

  clear() {
    this.count = 0;
    this.line.geometry.setDrawRange(0, 0);
  }
}

/** A tall column of light marking a minimum, visible from across the map. */
export function makeBeacon(color: string) {
  const g = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.35, 160, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  beam.position.y = 80; // tall enough to clear the highest ground on a huge map
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.7, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), new THREE.MeshBasicMaterial({ color }));
  gem.position.y = 1.4;
  g.add(beam, ring, gem);
  g.userData.gem = gem;
  return g;
}

export function makeStars(count = 1800) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 140 + Math.random() * 40;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 1.9 - 0.9); // mostly upper hemisphere
    pos.set([r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: '#c9d6ff', size: 0.7, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.8 }),
  );
}
