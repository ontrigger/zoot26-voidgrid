// The map's collision, in one of two views: what stops Link, or what Link's ragdoll hits. Air walls go in a
// see-through mesh of their own, so what's behind them shows.
import * as THREE from 'three';
import { ragdollClass, TriFlag, type Collision } from '../data';
import { fmt, type Hit } from '../pick';
import { count, hexCss, rgbCss, type Rgb, type Swatch } from '../ui';

export type CollisionView = 'link' | 'ragdoll';

/** colours of the ragdoll classes (Manifest.ragdollClasses) */
const RAGDOLL_COLOURS: Rgb[] = [[0.54, 0.56, 0.6], [0.42, 0.58, 0.78], [0.9, 0.58, 0.2]];
const RAGDOLL_TEXT: Record<string, string> = {
  'both': 'Link stands on it too',
  'rough twin': 'GroundHighResRough: the detailed twin the Link view leaves out',
  'ragdoll only': 'only the ragdoll hits it (Link passes through)',
};
const AIR_WALL = 0x5fd3ff;

const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
// The ragdoll's bones only collide with a triangle's front ((b-a)x(c-a) side), so its view culls back faces:
// walls seen from behind vanish.
const MATERIALS = {
  link: new THREE.MeshLambertMaterial({ color: 0x8a8f99, side: THREE.DoubleSide, ...offset }),
  ragdoll: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide, ...offset }),
  linkAir: new THREE.MeshLambertMaterial({ color: AIR_WALL, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
  ragdollAir: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.FrontSide }),
};

interface Part {
  mesh: THREE.Mesh;
  air: boolean;
  /** each triangle's ragdoll class, in the ragdoll view */
  classes: Uint8Array | null;
}

export interface CollisionStats {
  triangles: number;
  legend: Swatch[];
}

export class CollisionLayer {
  readonly group = new THREE.Group();
  private parts: Part[] = [];
  private classNames: string[] = [];

  build(col: Collision, view: CollisionView, ragdollClasses: string[]): CollisionStats {
    this.clear();
    this.classNames = ragdollClasses;
    const want = view === 'ragdoll' ? TriFlag.ragdollHits : TriFlag.stopsLink;
    const perClass = [0, 0, 0];
    const solid = this.part(col, want, view, false, perClass);
    const air = this.part(col, want, view, true, perClass);
    this.parts = [solid, air];
    this.group.add(solid.mesh, air.mesh);

    const airCount = air.mesh.geometry.attributes.position.count / 3;
    const legend: Swatch[] = view === 'ragdoll' ? ragdollClasses.map((name, k) => ({ colour: rgbCss(RAGDOLL_COLOURS[k]), text: `${name} ${count(perClass[k])}` })) : [];
    if (airCount) legend.push({ colour: hexCss(AIR_WALL), text: `air walls ${count(airCount)}`, opacity: 0.6 });
    return { triangles: solid.mesh.geometry.attributes.position.count / 3 + airCount, legend };
  }

  /** One mesh of the wanted triangles that are (air) or aren't air walls; counts the ragdoll classes into perClass. */
  private part(col: Collision, want: number, view: CollisionView, air: boolean, perClass: number[]): Part {
    const keep = (t: number) => (col.flags[t] & want) !== 0 && ((col.flags[t] & TriFlag.airWall) !== 0) === air;
    let n = 0;
    for (let t = 0; t < col.triangles; t++) if (keep(t)) n++;

    const ragdoll = view === 'ragdoll';
    const positions = new Float32Array(n * 9);
    const colours = ragdoll ? new Float32Array(n * 9) : null;
    const classes = ragdoll ? new Uint8Array(n) : null;
    for (let t = 0, k = 0; t < col.triangles; t++) {
      if (!keep(t)) continue;
      for (let v = 0; v < 3; v++) {
        const i = col.indices[t * 3 + v] * 3;
        positions.set(col.vertices.subarray(i, i + 3), k * 9 + v * 3);
      }
      if (colours && classes) {
        const cls = ragdollClass(col.flags[t]);
        classes[k] = cls;
        perClass[cls]++;
        for (let v = 0; v < 3; v++) colours.set(RAGDOLL_COLOURS[cls], k * 9 + v * 3);
      }
      k++;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    if (colours) geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    const material = MATERIALS[`${view}${air ? 'Air' : ''}` as keyof typeof MATERIALS];
    return { mesh: new THREE.Mesh(geometry, material), air, classes };
  }

  private clear() {
    for (const { mesh } of this.parts) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.parts = [];
  }

  setAirWallsVisible(on: boolean) {
    for (const p of this.parts) if (p.air) p.mesh.visible = on;
  }

  pick(ray: THREE.Raycaster): Hit | null {
    if (!this.group.visible) return null;
    let best: { hit: THREE.Intersection; part: Part } | null = null;
    for (const part of this.parts) {
      if (!part.mesh.visible) continue;
      const hit = ray.intersectObject(part.mesh)[0];
      if (hit && (!best || hit.distance < best.hit.distance)) best = { hit, part };
    }
    if (!best) return null;
    const { hit, part } = best;
    let text = `${part.air ? 'air wall' : 'collision'} at ${fmt(2, hit.point.x, hit.point.y, hit.point.z)}`;
    if (part.classes && hit.faceIndex != null) text += `\nragdoll: ${RAGDOLL_TEXT[this.classNames[part.classes[hit.faceIndex]]]}`;
    return { distance: hit.distance, text };
  }
}
