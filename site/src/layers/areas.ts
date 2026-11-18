// Contact areas: placed areas whose logic voids Link when he touches them. Conditional ones (prefab logic) are purple.
import * as THREE from 'three';
import type { AreaKind, AreaShape, ContactArea } from '../data';
import { fmt, type Hit } from '../pick';
import { hexCss, type Swatch } from '../ui';

const COLOURS: Record<AreaKind, number> = { void: 0xff3355, conditional: 0xb455ff };
const LABEL: Record<AreaKind, string> = { void: 'voids on touch', conditional: 'conditional' };
const TEXT: Record<AreaKind, string> = {
  void: 'voids Link when he touches it',
  conditional: 'voids Link when he touches it, while the condition in its logic holds (it may also be an unrelated area of the same prefab)',
};

// An area's origin is the middle of its bottom: for a scale of 1, a box of half extents 1 centred 1 up its Y axis,
// or a cylinder of radius 1 and height 2 standing on it (sloperina FINDINGS 9.8, main+0x334FD40).
const cylinder = () => new THREE.CylinderGeometry(1, 1, 2, 32).translate(0, 1, 0);
const SHAPES: Record<AreaShape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0),
  cylinder: cylinder(),
  capsule: cylinder(),
  sphere: new THREE.SphereGeometry(1, 24, 16).translate(0, 1, 0),
};
const EDGES = Object.fromEntries(
  Object.entries(SHAPES).map(([k, g]) => [k, new THREE.EdgesGeometry(g, 30)]),
) as Record<AreaShape, THREE.EdgesGeometry>;

const fill = (kind: AreaKind) =>
  new THREE.MeshBasicMaterial({ color: COLOURS[kind], transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
const FILLS: Record<AreaKind, THREE.Material> = { void: fill('void'), conditional: fill('conditional') };
const LINES: Record<AreaKind, THREE.Material> = {
  void: new THREE.LineBasicMaterial({ color: COLOURS.void }),
  conditional: new THREE.LineBasicMaterial({ color: COLOURS.conditional }),
};

export class AreasLayer {
  readonly group = new THREE.Group();
  /** the filled mesh of each area, which picking hits */
  private meshes = new Map<THREE.Object3D, ContactArea>();

  /** Draw the areas; returns the legend. */
  build(areas: ContactArea[]): Swatch[] {
    this.group.clear();
    this.meshes.clear();
    const perKind: Record<AreaKind, number> = { void: 0, conditional: 0 };
    for (const a of areas) {
      const shape = SHAPES[a.shape] ? a.shape : 'box';
      const g = new THREE.Group();
      g.position.set(...a.t);
      g.rotation.set(a.r[0], a.r[1], a.r[2], 'ZYX');
      g.scale.set(...a.s);
      g.userData.kind = a.kind;
      const mesh = new THREE.Mesh(SHAPES[shape], FILLS[a.kind]);
      g.add(mesh, new THREE.LineSegments(EDGES[shape], LINES[a.kind]));
      this.meshes.set(mesh, a);
      this.group.add(g);
      perKind[a.kind]++;
    }
    return (Object.keys(perKind) as AreaKind[])
      .filter(k => perKind[k])
      .map(k => ({ colour: hexCss(COLOURS[k]), text: `${LABEL[k]} ${perKind[k]}` }));
  }

  /** Conditional areas also follow the void box checkbox. */
  setVisible(areas: boolean, conditional: boolean) {
    this.group.visible = areas;
    for (const g of this.group.children) g.visible = g.userData.kind !== 'conditional' || conditional;
  }

  pick(ray: THREE.Raycaster): Hit | null {
    if (!this.group.visible) return null;
    const hit = ray.intersectObjects(this.group.children, true).find(h => this.meshes.has(h.object) && h.object.parent?.visible);
    if (!hit) return null;
    const a = this.meshes.get(hit.object)!;
    return { distance: hit.distance, text: `contact area (${a.shape}) at ${fmt(1, ...a.t)}\n${TEXT[a.kind]}\nlogic ${a.module}` };
  }
}
