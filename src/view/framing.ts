import { PerspectiveCamera, Vector3 } from 'three';

/** 要把什么、放进屏幕的哪一块 */
export interface FrameRequest {
  /** 相机的竖直视角（度） */
  readonly fov: number;
  /** 相机偏离正上方多少度（0 就是垂直俯视），朝玩家这一侧（+z）偏 */
  readonly tilt: number;
  /** 画面的宽高（像素） */
  readonly width: number;
  readonly height: number;
  /** 托盘的外包盒子：左右各伸出 halfWidth，前后各伸出 halfDepth，底在 y = 0，顶在 y = boxHeight */
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly boxHeight: number;
  /** 画面四边各留出多少像素给界面，托盘只能放在剩下的那一块里 */
  readonly safe: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}

/** 取景结果：相机离托盘中心多远，以及画面要平移多少像素才能让托盘落在留出的那一块正中 */
export interface Framing {
  readonly distance: number;
  readonly shiftX: number;
  readonly shiftY: number;
}

const probe = new PerspectiveCamera();
const corner = new Vector3();

function place(camera: PerspectiveCamera, req: FrameRequest, distance: number): void {
  const tilt = (req.tilt * Math.PI) / 180;
  camera.fov = req.fov;
  camera.aspect = req.width / req.height;
  camera.position.set(0, distance * Math.cos(tilt), distance * Math.sin(tilt));
  // 几乎垂直往下看，所以"上"不能用 y 轴，用屏幕里朝上的 -z
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
}

/** 盒子的 8 个角投到屏幕上占的范围（像素，左上角为原点，不考虑平移） */
function bounds(req: FrameRequest, distance: number): { left: number; right: number; top: number; bottom: number } {
  place(probe, req, distance);
  probe.clearViewOffset();
  probe.near = 0.1;
  probe.far = distance * 4 + 100;
  probe.updateProjectionMatrix();
  probe.updateMatrixWorld(true);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? req.halfWidth : -req.halfWidth, i & 2 ? req.boxHeight : 0, i & 4 ? req.halfDepth : -req.halfDepth);
    corner.project(probe);
    const x = ((corner.x + 1) / 2) * req.width;
    const y = ((1 - corner.y) / 2) * req.height;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { left, right, top, bottom };
}

/** 算出把托盘尽量大地放进留出的那一块、并且居中，相机该离多远、画面该平移多少。 */
export function frameBox(req: FrameRequest): Framing {
  const safeW = Math.max(1, req.width - req.safe.left - req.safe.right);
  const safeH = Math.max(1, req.height - req.safe.top - req.safe.bottom);
  const fits = (distance: number): boolean => {
    const b = bounds(req, distance);
    return b.right - b.left <= safeW && b.bottom - b.top <= safeH;
  };
  // 离得越远盒子在屏幕上越小。先找到一个放得下的距离，再二分逼近"刚好放下"的那个距离。
  const size = Math.max(req.halfWidth, req.halfDepth, req.boxHeight);
  let near = size * 1.5;
  let far = size * 4;
  while (!fits(far)) far *= 2;
  for (let i = 0; i < 48; i++) {
    const mid = (near + far) / 2;
    if (fits(mid)) far = mid;
    else near = mid;
  }
  const b = bounds(req, far);
  return {
    distance: far,
    shiftX: (b.left + b.right) / 2 - (req.safe.left + safeW / 2),
    shiftY: (b.top + b.bottom) / 2 - (req.safe.top + safeH / 2),
  };
}

/** 按取景结果摆好相机 */
export function applyFraming(camera: PerspectiveCamera, framing: Framing, req: FrameRequest): void {
  place(camera, req, framing.distance);
  camera.setViewOffset(req.width, req.height, framing.shiftX, framing.shiftY, req.width, req.height);
  camera.updateProjectionMatrix();
}
