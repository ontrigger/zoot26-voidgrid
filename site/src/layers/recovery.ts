// Save recovery: a point per 1 m of floor, coloured by what the game's ground check does with Link standing there.
import * as THREE from 'three';
import type { Grid } from '../data';
import { fmt, type Hit } from '../pick';
import { count, rgbCss, type Rgb, type Swatch } from '../ui';

/** colours of the recovery classes (Manifest.recoveryClasses) */
const COLOURS: Rgb[] = [[0.2, 0.9, 0.35], [1, 0.25, 0.3]];
const TEXT: Record<string, string> = {
  follows: 'follows: a save here loads here',
  holds: 'holds: the restart point stays where it was',
};
/** lift off the floor so the points aren't buried in it */
const LIFT = 0.06;

const material = new THREE.PointsMaterial({ size: 0.7, vertexColors: true });

export function recoveryLegend(classNames: string[], counts: Record<string, number>): Swatch[] {
  return classNames.map((name, k) => ({ colour: rgbCss(COLOURS[k]), text: `${name} ${count(counts[name] ?? 0)}` }));
}

export class RecoveryLayer {
  readonly group = new THREE.Group();
  private points: THREE.Points | null = null;
  private grid: Grid | null = null;
  private classNames: string[] = [];
  /** the floor sample index of each point drawn */
  private drawn: number[] = [];

  /** Draw the grid's floor samples (none when grid is null), leaving out the 'follows' ones when hideFollows. */
  build(grid: Grid | null, classNames: string[], hideFollows: boolean) {
    this.clear();
    this.grid = grid;
    this.classNames = classNames;
    if (!grid) return;
    const P = grid.recoveryPoints;
    const K = grid.recoveryClasses;
    const positions: number[] = [];
    const colours: number[] = [];
    this.drawn = [];
    for (let i = 0; i < K.length; i++) {
      if (hideFollows && classNames[K[i]] === 'follows') continue;
      positions.push(P[i * 3], P[i * 3 + 1] + LIFT, P[i * 3 + 2]);
      colours.push(...COLOURS[K[i]]);
      this.drawn.push(i);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    this.points = new THREE.Points(geometry, material);
    this.group.add(this.points);
  }

  private clear() {
    if (!this.points) return;
    this.group.remove(this.points);
    this.points.geometry.dispose();
    this.points = null;
  }

  pick(ray: THREE.Raycaster): Hit | null {
    if (!this.group.visible || !this.points || !this.grid) return null;
    const hit = ray.intersectObject(this.points)[0];
    if (!hit || hit.index == null) return null;
    const i = this.drawn[hit.index];
    const P = this.grid.recoveryPoints;
    const name = this.classNames[this.grid.recoveryClasses[i]];
    return {
      distance: hit.distance,
      text: `floor ${fmt(1, P[i * 3])} ${fmt(2, P[i * 3 + 1])} ${fmt(1, P[i * 3 + 2])}\nsave recovery: ${TEXT[name]}`,
    };
  }
}
