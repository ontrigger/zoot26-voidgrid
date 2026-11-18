// Void-out grid viewer: the scene, the panel's controls, and loading a map.
import * as THREE from 'three';
import { CameraRig, HELP, type ControlMode } from './camera';
import { Attr, loadCollision, loadGrid, loadManifest, type Collision, type Grid, type Manifest, type MapInfo, type Vec3 } from './data';
import { AreasLayer } from './layers/areas';
import { MarksLayer, VoidBoxLayer, voidBoxLegend } from './layers/bounds';
import { CellsLayer, SCHEMES, type CellFilter, type ColourBy, type DrawAs } from './layers/cells';
import { CollisionLayer, type CollisionView } from './layers/collision';
import { recoveryLegend, RecoveryLayer } from './layers/recovery';
import { choose, fmt } from './pick';
import { busy, count, setLegend, ui } from './ui';

// ---- scene

// Colours are given and drawn as they are, with no sRGB conversion, and lights are scaled by pi to undo three's
// physically based units: the look the viewer had on three r128.
THREE.ColorManagement.enabled = false;
const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171c);
scene.add(new THREE.HemisphereLight(0xffffff, 0x000334, 0.85 * Math.PI));
const sun = new THREE.DirectionalLight(0xffffff, 0.6 * Math.PI);
sun.position.set(0.4, 1, 0.3);
scene.add(sun);

const collision = new CollisionLayer();
const cells = new CellsLayer();
const recovery = new RecoveryLayer();
const areas = new AreasLayer();
const voidBox = new VoidBoxLayer();
const marks = new MarksLayer();
scene.add(collision.group, cells.group, recovery.group, areas.group, voidBox.group, marks.group);

const rig = new CameraRig(ui.canvas);

// ---- the open map

let manifest: Manifest | null = null;
const maps = new Map<string, MapInfo>();

interface Current {
  map: MapInfo;
  grid: Grid;
  collision: Collision;
  /** whether the grid stores the outer-boundary attributes */
  outerBoundary: boolean;
  triangles: number;
}
let current: Current | null = null;
/** bumped by each openMap, so a slow load that's been overtaken drops its result */
let loads = 0;

async function openMap(name: string) {
  const map = maps.get(name);
  if (!manifest || !map) return;
  const load = ++loads;
  busy('loading…');
  let grid: Grid, col: Collision;
  try {
    [grid, col] = await Promise.all([loadGrid(manifest, map), loadCollision(manifest, map.base)]);
  } catch (e) {
    if (load === loads) busy(e instanceof Error ? e.message : String(e));
    return;
  }
  if (load !== loads) return;
  busy('');

  const sameBase = current?.map.base === map.base;
  current = { map, grid, collision: col, outerBoundary: grid.stores(Attr.outside), triangles: current?.triangles ?? 0 };
  if (!sameBase) drawCollision();

  ui.filterRow.style.opacity = current.outerBoundary ? '1' : '0.5';
  ui.filter.disabled = !current.outerBoundary;
  if (!current.outerBoundary && SCHEMES[ui.colourBy.value as ColourBy].outerBoundary) ui.colourBy.value = 'intersect';

  voidBox.build(map.aabb);
  setLegend(ui.areaLegend, areas.build(map.contact), 'none in this map');
  marks.build(map.marks);
  ui.recoveryRow.style.display = map.recovery ? '' : 'none';
  if (map.recovery) setLegend(ui.recoveryLegend, recoveryLegend(manifest.recoveryClasses, map.recovery));
  applyVisibility();
  showStats();
  drawCells();
  drawRecovery();

  if (!sameBase) {
    if (map.marks.length) rig.lookAt(map.marks[0].p, 18);
    else rig.overview(map.box);
  }
  ui.level.value = name;
  try {
    history.replaceState(null, '', '#' + name);
  } catch {
    // not allowed on some origins; the hash is only a convenience
  }
}

function drawCollision() {
  if (!current || !manifest) return;
  const stats = collision.build(current.collision, ui.collisionView.value as CollisionView, manifest.ragdollClasses);
  current.triangles = stats.triangles;
  setLegend(ui.collisionLegend, stats.legend);
  applyVisibility();
}

function drawCells() {
  if (!current) return;
  const colourBy = ui.colourBy.value as ColourBy;
  const size = Number(ui.cellSize.value);
  ui.cellSizeValue.textContent = `${size.toFixed(2)} m`;
  cells.build(current.grid, {
    colourBy,
    filter: ui.filter.disabled ? 'all' : (ui.filter.value as CellFilter),
    drawAs: ui.drawAs.value as DrawAs,
    size,
  });
  setLegend(ui.cellLegend, SCHEMES[colourBy].legend);
}

function drawRecovery() {
  if (!current || !manifest) return;
  recovery.build(current.map.recovery ? current.grid : null, manifest.recoveryClasses, ui.hideFollows.checked);
}

function showStats() {
  if (!current) return;
  ui.stats.textContent =
    `${count(current.grid.count)} cells of 1 m, ${count(current.triangles)} collision triangles` +
    (current.outerBoundary ? '' : '\nno outer-boundary attributes in this map');
}

function applyVisibility() {
  collision.group.visible = ui.showCollision.checked;
  collision.setAirWallsVisible(ui.showAirWalls.checked);
  cells.group.visible = ui.showCells.checked;
  recovery.group.visible = ui.showRecovery.checked;
  voidBox.group.visible = ui.showVoidBox.checked;
  areas.setVisible(ui.showAreas.checked, ui.showVoidBox.checked);
}

// ---- panel

/** Redraw the cells at most once a frame, however many input events a slider drag sends. */
let redrawQueued = false;
function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    drawCells();
  });
}
for (const el of [ui.colourBy, ui.filter, ui.drawAs, ui.cellSize]) el.addEventListener('input', queueRedraw);

for (const el of [ui.showCollision, ui.showAirWalls, ui.showCells, ui.showRecovery, ui.showAreas, ui.showVoidBox])
  el.addEventListener('change', applyVisibility);
ui.hideFollows.addEventListener('change', drawRecovery);

/** A select keeps the focus after a change, and would eat the fly keys. */
const onPick = (el: HTMLSelectElement, f: (value: string) => void) =>
  el.addEventListener('change', () => {
    el.blur();
    f(el.value);
  });
onPick(ui.collisionView, () => {
  drawCollision();
  showStats();
});
onPick(ui.level, name => void openMap(name));
onPick(ui.controls, mode => rig.setMode(mode as ControlMode));

ui.hide.addEventListener('click', () => {
  const min = ui.panel.classList.toggle('min');
  ui.hide.textContent = min ? '+' : '–';
  ui.hide.title = min ? 'show the panel' : 'hide the panel';
  ui.hide.blur();
});

ui.goto.addEventListener('change', () => {
  const v = ui.goto.value.trim().split(/[\s,]+/).map(Number);
  if (v.length === 3 && v.every(Number.isFinite)) rig.lookAt(v as Vec3, rig.mode === 'fly' ? 6 : 20);
  ui.goto.blur();
});

setLegend(ui.voidBoxLegend, voidBoxLegend);

// ---- camera and picking

rig.onModeChange = mode => {
  ui.controls.value = mode;
  ui.keys.innerHTML = HELP[mode];
};
document.addEventListener('pointerlockchange', () => {
  ui.cross.style.display = rig.locked ? 'block' : 'none';
});

const ray = new THREE.Raycaster();
ray.params.Points.threshold = 0.5;

/** Describe what's under ndc (normalized device coordinates) in the info box. */
function pick(ndc: THREE.Vector2) {
  if (!current) return;
  ray.setFromCamera(ndc, rig.camera);
  ui.info.textContent = choose(
    [
      { hit: areas.pick(ray), slack: 0 },
      { hit: recovery.pick(ray), slack: 0.3 },
      { hit: cells.pick(ray), slack: 0.5 },
    ],
    collision.pick(ray),
  );
}

// A click picks; in fly mode it first captures the mouse, and then picks at the cross. In orbit mode a drag doesn't.
let pressedAt: [number, number] | null = null;
ui.canvas.addEventListener('pointerdown', e => (pressedAt = [e.clientX, e.clientY]));
ui.canvas.addEventListener('pointerup', e => {
  if (!pressedAt) return;
  const dragged = Math.hypot(e.clientX - pressedAt[0], e.clientY - pressedAt[1]) > 4;
  pressedAt = null;
  if (rig.mode === 'fly') {
    if (rig.locked) pick(new THREE.Vector2(0, 0));
    else if (e.pointerType === 'mouse') void ui.canvas.requestPointerLock();
    else pick(pointerNdc(e));
  } else if (!dragged) pick(pointerNdc(e));
});
const pointerNdc = (e: PointerEvent) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

// ---- loop

const timer = new THREE.Clock();
renderer.setAnimationLoop(() => {
  rig.update(Math.min(timer.getDelta(), 0.1));
  const p = rig.camera.position;
  ui.hud.textContent =
    `camera ${fmt(1, p.x, p.y, p.z)}` +
    (rig.mode === 'fly' ? `  ·  speed ${rig.speed.toFixed(1)} m/s` : '') +
    (voidBox.outside(p) ? '  ·  past the void box' : '');
  renderer.render(scene, rig.camera);
});

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  rig.setAspect(innerWidth / innerHeight);
}
addEventListener('resize', resize);
resize();
rig.setMode('fly');

// ---- start: the map list, grouped by area, then the map in the URL's #hash

const hashMap = () => decodeURIComponent(location.hash.slice(1));

async function start() {
  try {
    manifest = await loadManifest();
  } catch {
    ui.stats.textContent = 'no data/manifest.json: run pnpm data, and serve the site over http (not file://)';
    return;
  }
  for (const name of Object.keys(manifest.maps).sort()) maps.set(name, { name, ...manifest.maps[name] });

  const byArea = Map.groupBy(maps.values(), m => m.area);
  for (const area of [...byArea.keys()].sort()) {
    const group = document.createElement('optgroup');
    group.label = area;
    for (const m of byArea.get(area)!) group.append(new Option(m.name.replace(/_presence_/, ' · ').replace(/_/g, ' '), m.name));
    ui.level.append(group);
  }

  const first = maps.get(hashMap()) ?? maps.values().next().value;
  if (first) void openMap(first.name);
  else ui.stats.textContent = 'no maps built yet';
}

addEventListener('hashchange', () => {
  const name = hashMap();
  if (maps.has(name) && current?.map.name !== name) void openMap(name);
});

void start();
