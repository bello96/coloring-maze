import * as THREE from 'three';

const MAX = 40;
const GRAVITY = 26;
const matrix = new THREE.Matrix4();
const scale = new THREE.Vector3();
const noTurn = new THREE.Quaternion();
const at = new THREE.Vector3();

/** 小球撞墙时溅起来的几滴染料：飞起来、落下、渗进木头里消失 */
export class Drops {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  /** 每滴的大小；0 表示这个位置空着 */
  private readonly size = new Float32Array(MAX);
  /** 落地之后已经过了多久；负数表示还在飞 */
  private readonly landed = new Float32Array(MAX);
  private next = 0;
  private live = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly onFloor: (x: number, z: number) => boolean;

  /**
   * @param onFloor (x, z) 处是不是迷宫里的地面。水滴只有落在地面上才留得住；
   *   落到墙顶、边框或者托盘外面的，一落下就不画了（免得悬在半空或者嵌进木头里）
   */
  constructor(dye: THREE.Color, onFloor: (x: number, z: number) => boolean) {
    this.onFloor = onFloor;
    this.geometry = new THREE.IcosahedronGeometry(1, 1);
    this.material = new THREE.MeshStandardMaterial({ color: dye, roughness: 0.12, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX);
    this.mesh.frustumCulled = false;
    this.mesh.count = MAX;
    for (let i = 0; i < MAX; i++) this.hide(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private hide(i: number): void {
    this.size[i] = 0;
    matrix.compose(at.set(0, -50, 0), noTurn, scale.set(0, 0, 0));
    this.mesh.setMatrixAt(i, matrix);
  }

  /**
   * 在 (x, y, z) 处溅出 count 滴，大体朝 (dx, dz) 的反方向和两侧飞。
   * @param power 撞得多重（0–1），决定飞多远
   * @param unit 一格有多大，水滴的大小跟着它走
   */
  burst(x: number, y: number, z: number, dx: number, dz: number, count: number, power: number, unit: number): void {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      if (this.size[i] === 0) this.live++;
      // 撞墙后往回、往两边溅，再带一点往上
      const back = 0.5 + Math.random() * 2.1;
      const side = (Math.random() - 0.5) * 4.2;
      const speed = (0.5 + 0.5 * power) * unit;
      this.pos[i * 3] = x - dz * side * 0.03;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z + dx * side * 0.03;
      this.vel[i * 3] = (-dx * back - dz * side) * speed;
      this.vel[i * 3 + 1] = (1.8 + Math.random() * 2.8) * (0.6 + 0.4 * power) * Math.sqrt(unit);
      this.vel[i * 3 + 2] = (-dz * back + dx * side) * speed;
      this.size[i] = (0.028 + Math.random() * 0.04) * unit;
      this.landed[i] = -1;
    }
  }

  /** 还有没有水滴在动 */
  get active(): boolean {
    return this.live > 0;
  }

  /** 往前走 dt 秒。地面在 y = 0。 */
  update(dt: number): void {
    if (this.live === 0) return;
    for (let i = 0; i < MAX; i++) {
      const s = this.size[i];
      if (s === 0) continue;
      let shown = s;
      if (this.landed[i] < 0) {
        this.vel[i * 3 + 1] -= GRAVITY * dt;
        this.pos[i * 3] += this.vel[i * 3] * dt;
        this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
        this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
        if (this.pos[i * 3 + 1] <= s * 0.4) {
          if (!this.onFloor(this.pos[i * 3], this.pos[i * 3 + 2])) {
            this.hide(i);
            this.live--;
            continue;
          }
          this.pos[i * 3 + 1] = s * 0.4;
          this.landed[i] = 0;
        }
      } else {
        // 落地后摊平，很快渗进木头
        this.landed[i] += dt;
        const k = this.landed[i] / 0.32;
        if (k >= 1) {
          this.hide(i);
          this.live--;
          continue;
        }
        shown = s * (1 - k);
      }
      const flat = this.landed[i] >= 0 ? 0.45 : 1;
      matrix.compose(at.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]), noTurn, scale.set(shown * (2 - flat), shown * flat, shown * (2 - flat)));
      this.mesh.setMatrixAt(i, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** 立刻清掉所有水滴 */
  clear(): void {
    for (let i = 0; i < MAX; i++) this.hide(i);
    this.live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
