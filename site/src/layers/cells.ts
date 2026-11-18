// The grid's 1 m cells, as instanced cubes or (for big maps) points, coloured by an attribute.
import * as THREE from 'three';
import { Attr, type Grid } from '../data';
import type { Hit } from '../pick';
import { rgbCss, type Rgb, type Swatch } from '../ui';

export type ColourBy = 'void' | 'outside' | 'dist' | 'intersect' | 'plain';
export type CellFilter = 'all' | 'void' | 'outside0' | 'outside1';
export type DrawAs = 'auto' | 'cubes' | 'points';

export interface CellOptions {
  colourBy: ColourBy;
  filter: CellFilter;
  drawAs: DrawAs;
  /** cube edge, or point size, in metres */
  size: number;
}

/** Past this many cells, 'auto' draws points. */
const MAX_CUBES = 400_000;

const NOT_STORED: Rgb = [0.93, 0.93, 0.97];

interface Scheme {
  /** needs OutsideOuterBoundary / OuterBoundaryDist, which some maps don't store */
  outerBoundary: boolean;
  colour(grid: Grid, i: number): Rgb;
  legend: Swatch[];
}

const distColour = (v: number): Rgb => {
  const t = Math.min(v, 15) / 15;
  return [0.2 + 0.8 * t, 0.85 - 0.6 * t, 1 - 0.8 * t];
};

const binary = (j: number, on: Rgb, off: Rgb) => (grid: Grid, i: number): Rgb => {
  const v = grid.attr(i, j);
  return v === null ? NOT_STORED : v ? on : off;
};

const VOID: Rgb = [1, 0.15, 0.2];
const OUTSIDE_SAFE: Rgb = [1, 0.6, 0.15];
const INSIDE: Rgb = [0.3, 0.7, 0.95];
const OUTSIDE: Rgb = [1, 0.55, 0.15];
const NOT_OUTSIDE: Rgb = [0.25, 0.85, 0.45];
const TOUCHES: Rgb = [0.95, 0.85, 0.3];
const EMPTY: Rgb = [0.35, 0.55, 0.95];
const PLAIN: Rgb = [0.35, 0.66, 1];

const swatch = (c: Rgb, text: string): Swatch => ({ colour: rgbCss(c), text });

export const SCHEMES: Record<ColourBy, Scheme> = {
  void: {
    outerBoundary: true,
    colour: (grid, i) => {
      const outside = grid.attr(i, Attr.outside);
      if (outside === null) return NOT_STORED;
      return grid.isVoidCube(i) ? VOID : outside ? OUTSIDE_SAFE : INSIDE;
    },
    legend: [
      swatch(VOID, 'voids Link'),
      swatch(OUTSIDE_SAFE, 'outside, not deadly (holds the restart point)'),
      swatch(INSIDE, 'inside'),
      swatch(NOT_STORED, 'not stored'),
    ],
  },
  outside: {
    outerBoundary: true,
    colour: binary(Attr.outside, OUTSIDE, NOT_OUTSIDE),
    legend: [swatch(NOT_OUTSIDE, '0'), swatch(OUTSIDE, '1'), swatch(NOT_STORED, 'not stored')],
  },
  dist: {
    outerBoundary: true,
    colour: (grid, i) => {
      const v = grid.attr(i, Attr.dist);
      return v === null ? NOT_STORED : distColour(v);
    },
    legend: [0, 8, 15].map(v => swatch(distColour(v), String(v))),
  },
  intersect: {
    outerBoundary: false,
    colour: binary(Attr.intersect, TOUCHES, EMPTY),
    legend: [swatch(TOUCHES, 'touches geometry'), swatch(EMPTY, 'empty air')],
  },
  plain: {
    outerBoundary: false,
    colour: () => PLAIN,
    legend: [swatch(PLAIN, 'cell')],
  },
};

function passes(grid: Grid, i: number, filter: CellFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'void': return grid.isVoidCube(i);
    case 'outside0': return grid.attr(i, Attr.outside) === 0;
    case 'outside1': return grid.attr(i, Attr.outside) === 1;
  }
}

const cube = new THREE.BoxGeometry(1, 1, 1);
const cubeMaterial = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.55, depthWrite: false });
const pointMaterial = new THREE.PointsMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false });

export class CellsLayer {
  readonly group = new THREE.Group();
  private object: THREE.InstancedMesh | THREE.Points | null = null;
  private grid: Grid | null = null;
  /** the grid index of each cell drawn */
  private drawn = new Int32Array(0);

  build(grid: Grid, { colourBy, filter, drawAs, size }: CellOptions) {
    this.clear();
    this.grid = grid;
    const scheme = SCHEMES[colourBy];
    const cells = grid.cells;

    if (this.drawn.length < grid.count) this.drawn = new Int32Array(grid.count);
    let n = 0;
    for (let i = 0; i < grid.count; i++) if (passes(grid, i, filter)) this.drawn[n++] = i;

    if (drawAs === 'points' || (drawAs === 'auto' && n > MAX_CUBES)) {
      const positions = new Float32Array(n * 3);
      const colours = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        const i = this.drawn[k];
        for (let a = 0; a < 3; a++) positions[k * 3 + a] = cells[i * 3 + a] + 0.5;
        colours.set(scheme.colour(grid, i), k * 3);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      pointMaterial.size = size;
      this.object = new THREE.Points(geometry, pointMaterial);
    } else {
      const mesh = new THREE.InstancedMesh(cube, cubeMaterial, Math.max(n, 1));
      const m = new THREE.Matrix4();
      const c = new THREE.Color();
      for (let k = 0; k < n; k++) {
        const i = this.drawn[k];
        m.makeScale(size, size, size).setPosition(cells[i * 3] + 0.5, cells[i * 3 + 1] + 0.5, cells[i * 3 + 2] + 0.5);
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, c.setRGB(...scheme.colour(grid, i)));
      }
      mesh.count = n;
      this.object = mesh;
    }
    this.group.add(this.object);
  }

  private clear() {
    if (!this.object) return;
    this.group.remove(this.object);
    if (this.object instanceof THREE.InstancedMesh) this.object.dispose();
    else this.object.geometry.dispose();
    this.object = null;
  }

  pick(ray: THREE.Raycaster): Hit | null {
    if (!this.group.visible || !this.object || !this.grid) return null;
    const hit = ray.intersectObject(this.object)[0];
    if (!hit) return null;
    const grid = this.grid;
    const i = this.drawn[(this.object instanceof THREE.InstancedMesh ? hit.instanceId : hit.index) ?? 0];
    const c = grid.cells;
    const attrs = grid.attributeNames.map((name, j) => `${name}: ${grid.attr(i, j) ?? '-'}`);
    return {
      distance: hit.distance,
      text: [
        `cell ${c[i * 3]} ${c[i * 3 + 1]} ${c[i * 3 + 2]} (min corner)`,
        ...attrs,
        `void-out cube: ${grid.isVoidCube(i) ? 'yes' : 'no'}`,
      ].join('\n'),
    };
  }
}
