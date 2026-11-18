// The void box, and the marks given to build.py --mark.
import * as THREE from 'three';
import type { Box, Mark, Vec3 } from '../data';
import { hexCss, type Swatch } from '../ui';

/** Past the grid's AABB grown by this, the sensor sets its bit 18 and the game voids Link at once. */
export const BOX_MARGIN = 5;
const BOX = 0xffffff;
const VOID_BOX = 0xff3b3b;

export const voidBoxLegend: Swatch[] = [
  { colour: hexCss(VOID_BOX), text: `more than ${BOX_MARGIN} m outside the grid's box: voids at once` },
  { colour: hexCss(BOX), text: 'the box' },
];

export class VoidBoxLayer {
  readonly group = new THREE.Group();
  private aabb: Box | null = null;

  build(aabb: Box | null) {
    this.group.clear();
    this.aabb = aabb;
    if (!aabb) return;
    const [lo, hi] = aabb;
    const grown = (d: number, colour: number) =>
      new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...lo).subScalar(d), new THREE.Vector3(...hi).addScalar(d)), colour);
    this.group.add(grown(0, BOX), grown(BOX_MARGIN, VOID_BOX));
  }

  /** Whether p is past the void box (false when the map has no AABB). */
  outside(p: THREE.Vector3): boolean {
    if (!this.aabb) return false;
    const [lo, hi] = this.aabb;
    const v: Vec3 = [p.x, p.y, p.z];
    return v.some((x, a) => x < lo[a] - BOX_MARGIN || x > hi[a] + BOX_MARGIN);
  }
}

const MARK = 0xff2d75;
const sphere = new THREE.SphereGeometry(0.35, 16, 12);
const sphereMaterial = new THREE.MeshBasicMaterial({ color: MARK });
const post = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -2, 0), new THREE.Vector3(0, 3, 0)]);
const postMaterial = new THREE.LineBasicMaterial({ color: MARK });

export class MarksLayer {
  readonly group = new THREE.Group();

  build(marks: Mark[]) {
    this.group.clear();
    for (const { p } of marks) {
      const g = new THREE.Group();
      g.position.set(...p);
      g.add(new THREE.Mesh(sphere, sphereMaterial), new THREE.Line(post, postMaterial));
      this.group.add(g);
    }
  }
}
