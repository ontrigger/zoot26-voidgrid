// The data scripts/build.py writes to site/data/: manifest.json lists the maps; maps/*.vgz (grids) and col/*.vgz (collision)
// are gzip'd little-endian binaries, laid out as build.py's docstring describes.

export type Vec3 = [number, number, number];
export type Box = [min: Vec3, max: Vec3];

export interface Mark {
  map: string;
  p: Vec3;
  label: string;
}

export type AreaKind = 'void' | 'conditional';
export type AreaShape = 'box' | 'cylinder' | 'capsule' | 'sphere';

/** A placed area whose logic voids Link when he touches it. world = t + Rz Ry Rx (s * p) */
export interface ContactArea {
  module: string;
  kind: AreaKind;
  shape: AreaShape;
  t: Vec3;
  r: Vec3;
  s: Vec3;
}

export interface MapEntry {
  area: string;
  /** the map whose collision this one uses (state variants share their base map's) */
  base: string;
  file: string;
  cells: number;
  /** the cells' bounds, for the overview camera */
  box: Box;
  /** the map's VolumeStatsAABB */
  aabb: Box | null;
  marks: Mark[];
  contact: ContactArea[];
  /** floor samples per recovery class, or null when built with --no-recovery */
  recovery: Record<string, number> | null;
}

export interface MapInfo extends MapEntry {
  name: string;
}

export interface Manifest {
  attributes: string[];
  ragdollClasses: string[];
  recoveryClasses: string[];
  collision: Record<string, { file: string }>;
  maps: Record<string, MapEntry>;
}

export async function loadManifest(): Promise<Manifest> {
  const r = await fetch('data/manifest.json');
  if (!r.ok) throw new Error(`cannot load data/manifest.json (${r.status})`);
  return r.json();
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cannot load ${url} (${r.status})`);
  const buf = await r.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf; // the server already gunzipped it
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot gunzip (DecompressionStream)');
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function checkMagic(buf: ArrayBuffer, magic: string, what: string) {
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== magic) throw new Error(`not a ${what} file`);
}

const pad4 = (n: number) => n + (-n & 3);

// ---- collision

/** Per-triangle flag bits. */
export const TriFlag = {
  stopsLink: 1 << 0,
  ragdollHits: 1 << 1,
  // bits 2-3: the ragdoll class, see ragdollClass()
  airWall: 1 << 4,
} as const;

export const ragdollClass = (flags: number) => (flags >> 2) & 3;

export interface Collision {
  /** xyz per vertex */
  vertices: Float32Array;
  /** 3 vertex indices per triangle */
  indices: Uint32Array;
  /** TriFlag bits per triangle */
  flags: Uint8Array;
  triangles: number;
}

function parseCollision(buf: ArrayBuffer): Collision {
  checkMagic(buf, 'VGC1', 'collision');
  const dv = new DataView(buf);
  const nv = dv.getUint32(4, true);
  const nt = dv.getUint32(8, true);
  const origin = [12, 16, 20].map(p => dv.getFloat32(p, true));
  const step = [24, 28, 32].map(p => dv.getFloat32(p, true));
  const quantized = new Uint16Array(buf, 36, nv * 3);
  const vertices = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) vertices[i] = origin[i % 3] + step[i % 3] * quantized[i];
  const at = 36 + pad4(nv * 6);
  return {
    vertices,
    indices: new Uint32Array(buf, at, nt * 3),
    flags: new Uint8Array(buf, at + nt * 12, nt),
    triangles: nt,
  };
}

// ---- grid

/** Where build.py's KEEP_ATTRS puts the attributes the viewer reads. */
export const Attr = { outside: 0, dist: 1, intersect: 2 } as const;

/** A void-out cube: OutsideOuterBoundary is 1 and OuterBoundaryDist * 2/3 is over 3, i.e. 5 or more. */
export const VOID_DIST = 5;

const NOT_STORED = 255;

export class Grid {
  constructor(
    readonly count: number,
    /** each cell's min corner, xyz */
    readonly cells: Int16Array,
    private readonly attrs: Uint8Array,
    readonly attributeNames: string[],
    /** floor sample positions, xyz */
    readonly recoveryPoints: Float32Array,
    /** each floor sample's index into Manifest.recoveryClasses */
    readonly recoveryClasses: Uint8Array,
  ) {}

  /** Attribute j of cell i, or null when the game doesn't store it there. */
  attr(i: number, j: number): number | null {
    const v = this.attrs[i * this.attributeNames.length + j];
    return v === NOT_STORED ? null : v;
  }

  /** Whether any cell stores attribute j. */
  stores(j: number): boolean {
    for (let i = 0; i < this.count; i++) if (this.attr(i, j) !== null) return true;
    return false;
  }

  isVoidCube(i: number): boolean {
    const dist = this.attr(i, Attr.dist);
    return this.attr(i, Attr.outside) === 1 && dist !== null && dist >= VOID_DIST;
  }
}

function parseGrid(buf: ArrayBuffer, attributeNames: string[]): Grid {
  checkMagic(buf, 'VGG1', 'grid');
  const dv = new DataView(buf);
  const n = dv.getUint32(4, true);
  const nr = dv.getUint32(8, true);
  const na = attributeNames.length;
  let p = 12;
  const cells = new Int16Array(buf, p, n * 3);
  p += pad4(n * 6);
  const attrs = new Uint8Array(buf, p, n * na);
  p += pad4(n * na);
  return new Grid(n, cells, attrs, attributeNames, new Float32Array(buf, p, nr * 3), new Uint8Array(buf, p + nr * 12, nr));
}

// ---- cached loaders

const grids = new Map<string, Promise<Grid>>();
const collisions = new Map<string, Promise<Collision>>();

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key)); // let a failed load be retried
  }
  return p;
}

export const loadGrid = (manifest: Manifest, map: MapInfo) =>
  cached(grids, map.name, async () => parseGrid(await fetchBinary(`data/${map.file}`), manifest.attributes));

export const loadCollision = (manifest: Manifest, base: string) =>
  cached(collisions, base, async () => parseCollision(await fetchBinary(`data/${manifest.collision[base].file}`)));
