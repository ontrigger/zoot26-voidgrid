// The page's controls, looked up once, and the legend swatches.

function byId<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return el;
}

const div = (id: string) => byId(id, HTMLDivElement);
const select = (id: string) => byId(id, HTMLSelectElement);
const input = (id: string) => byId(id, HTMLInputElement);

export const ui = {
  canvas: byId('c', HTMLCanvasElement),
  cross: div('cross'),
  loading: div('loading'),
  hud: div('hud'),

  panel: div('ui'),
  hide: byId('hide', HTMLButtonElement),
  level: select('level'),
  stats: div('stats'),

  colourBy: select('mode'),
  cellLegend: div('legend'),
  filterRow: div('filtrow'),
  filter: select('filt'),
  drawAs: select('draw'),
  cellSize: input('cs'),
  cellSizeValue: byId('csv', HTMLElement),

  recoveryRow: div('recrow'),
  showRecovery: input('showrec'),
  recoveryLegend: div('reclegend'),
  hideFollows: input('recheld'),

  collisionView: select('colset'),
  collisionLegend: div('collegend'),
  showCollision: input('showcol'),
  showAirWalls: input('showair'),
  showCells: input('showcells'),
  showAreas: input('showarea'),
  areaLegend: div('arealegend'),
  showVoidBox: input('showbox'),
  voidBoxLegend: div('boxlegend'),

  controls: select('ctl'),
  keys: div('keys'),
  goto: input('goto'),
  info: div('info'),
};

export type Rgb = readonly [r: number, g: number, b: number];

export const rgbCss = ([r, g, b]: Rgb) => `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
export const hexCss = (hex: number) => '#' + hex.toString(16).padStart(6, '0');

export interface Swatch {
  colour: string;
  text: string;
  opacity?: number;
}

/** Fill a legend with swatches, or with `empty` when there are none. */
export function setLegend(el: HTMLElement, swatches: Swatch[], empty = '') {
  el.replaceChildren(
    ...swatches.map(({ colour, text, opacity }) => {
      const chip = document.createElement('i');
      chip.style.background = colour;
      if (opacity !== undefined) chip.style.opacity = String(opacity);
      const span = document.createElement('span');
      span.append(chip, text);
      return span;
    }),
  );
  if (!swatches.length && empty) {
    const span = document.createElement('span');
    span.textContent = empty;
    el.append(span);
  }
}

export const count = (n: number) => n.toLocaleString();

export function busy(text: string) {
  ui.loading.textContent = text;
  ui.loading.style.display = text ? 'block' : 'none';
}
