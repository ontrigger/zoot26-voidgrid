// Camera controls: fly (pointer lock, WASD) or orbit.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Box, Vec3 } from './data';

export type ControlMode = 'fly' | 'orbit';

export const HELP: Record<ControlMode, string> = {
  fly:
    '<b>click</b> the view to look around (<b>Esc</b> frees the mouse) · <b>WASD</b> move · <b>Space</b>/<b>E</b> up · ' +
    '<b>C</b>/<b>Q</b> down · <b>Shift</b> fast · <b>wheel</b> speed · <b>click</b> while looking: pick at the cross · <b>Tab</b> orbit',
  orbit: '<b>drag</b> orbit · <b>right-drag</b> pan · <b>wheel</b> zoom · <b>click</b> pick · <b>Tab</b> fly',
};

/** Keys whose browser default (scrolling) is suppressed. */
const MOVE_KEYS = new Set(['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC']);
const LOOK_SPEED = 0.0022; // radians per pixel
const MAX_PITCH = 1.55;
const FAST = 4;
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.05, 8000);
  mode: ControlMode = 'fly';
  /** fly speed, m/s */
  speed = 8;
  onModeChange: (mode: ControlMode) => void = () => {};

  private readonly orbit: OrbitControls;
  private yaw = 0;
  private pitch = 0;
  private readonly held = new Set<string>();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.camera.rotation.order = 'YXZ';
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enabled = false;

    document.addEventListener('mousemove', e => {
      if (this.mode !== 'fly' || !this.locked) return;
      this.yaw -= e.movementX * LOOK_SPEED;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK_SPEED, -MAX_PITCH, MAX_PITCH);
      this.applyLook();
    });
    addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (e.code === 'Tab') {
        e.preventDefault();
        this.setMode(this.mode === 'fly' ? 'orbit' : 'fly');
        return;
      }
      this.held.add(e.code);
      if (MOVE_KEYS.has(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => this.held.delete(e.code));
    addEventListener('blur', () => this.held.clear());
    canvas.addEventListener(
      'wheel',
      e => {
        if (this.mode !== 'fly') return;
        e.preventDefault();
        this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.5, 200);
      },
      { passive: false },
    );
  }

  /** Whether the mouse is captured for looking around. */
  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  setMode(mode: ControlMode) {
    this.mode = mode;
    if (mode === 'orbit') {
      if (document.pointerLockElement) document.exitPointerLock();
      this.camera.getWorldDirection(this.forward);
      this.orbit.target.copy(this.camera.position).addScaledVector(this.forward, 15);
      this.orbit.enabled = true;
      this.orbit.update();
    } else {
      this.orbit.enabled = false;
      this.syncLook();
      this.applyLook();
    }
    this.onModeChange(mode);
  }

  /** Look at p from dist away, up and to one side. */
  lookAt(p: Vec3, dist: number) {
    const [x, y, z] = p;
    this.camera.position.set(x + dist * 0.6, y + dist * 0.45, z + dist * 0.6);
    this.camera.lookAt(x, y, z);
    this.syncLook();
    this.orbit.target.set(x, y, z);
    if (this.mode === 'orbit') this.orbit.update();
    else this.applyLook();
  }

  /** Look over the whole of a box. */
  overview([lo, hi]: Box) {
    const centre = lo.map((v, a) => (v + hi[a]) / 2) as Vec3;
    this.lookAt(centre, Math.max(hi[0] - lo[0], hi[2] - lo[2]) * 0.6 + 10);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    if (this.mode === 'orbit') {
      this.orbit.update();
      return;
    }
    const k = this.held;
    const v = this.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? FAST : 1) * dt;
    const pos = this.camera.position;
    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, UP).normalize();
    if (k.has('KeyW')) pos.addScaledVector(this.forward, v);
    if (k.has('KeyS')) pos.addScaledVector(this.forward, -v);
    if (k.has('KeyD')) pos.addScaledVector(this.right, v);
    if (k.has('KeyA')) pos.addScaledVector(this.right, -v);
    if (k.has('Space') || k.has('KeyE')) pos.y += v;
    if (k.has('KeyC') || k.has('KeyQ')) pos.y -= v;
  }

  /** Take yaw and pitch from where the camera now looks. */
  private syncLook() {
    this.camera.getWorldDirection(this.forward);
    this.yaw = Math.atan2(-this.forward.x, -this.forward.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(this.forward.y, -1, 1));
  }

  private applyLook() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
