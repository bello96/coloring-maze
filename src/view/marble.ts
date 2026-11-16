import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const axis = new THREE.Vector3();
const turn = new THREE.Quaternion();

/**
 * 玻璃弹珠：透明的玻璃球，里面有三片拧成麻花的色芯（老式"猫眼"弹珠的样子），颜色就是这一关的染料。
 * 色芯跟着球一起转，所以看得出球是真的在滚。
 */
export class Marble {
  /** 整颗弹珠；位置是球心 */
  readonly group = new THREE.Group();
  readonly radius: number;
  private readonly spin = new THREE.Group();
  private readonly owned: Array<{ dispose(): void }> = [];

  constructor(radius: number, dye: THREE.Color) {
    this.radius = radius;
    this.group.add(this.spin);

    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.03,
      metalness: 0,
      transmission: 1,
      thickness: radius * 1.1,
      ior: 1.5,
      attenuationColor: new THREE.Color(0xdff3ee),
      attenuationDistance: radius * 9,
      specularIntensity: 1,
      envMapIntensity: 1.4,
    });
    const shellGeometry = new THREE.SphereGeometry(radius, 56, 40);
    // 玻璃球不投普通的影子：它的影子（带聚光的亮斑）由底板自己画，见 stain.ts
    this.spin.add(new THREE.Mesh(shellGeometry, glass));

    // 色芯四片：两片是染料的颜色，两片是乳白的，交错着拧在一起。
    // 弹珠脚下那一格总是染过的，只有染料色的话就和地面混成一片了，白的那两片保证什么时候都看得清。
    const tinted = new THREE.MeshStandardMaterial({ color: dye, emissive: dye, emissiveIntensity: 0.3, roughness: 0.35, side: THREE.DoubleSide });
    const milky = new THREE.MeshStandardMaterial({ color: 0xf7f0e2, emissive: 0xf7f0e2, emissiveIntensity: 0.12, roughness: 0.4, side: THREE.DoubleSide });
    const tintedBlades = swirl(radius, 0, 0.56);
    const milkyBlades = swirl(radius, Math.PI / 2, 0.4);
    const core = new THREE.Group();
    core.add(new THREE.Mesh(tintedBlades, tinted), new THREE.Mesh(milkyBlades, milky));
    // 让色芯的轴斜着，滚起来各个方向都看得到变化
    core.rotation.set(0.5, 0.3, 0.9);
    this.spin.add(core);
    this.owned.push(glass, shellGeometry, tinted, milky, tintedBlades, milkyBlades);
  }

  /** 贴着地面朝 (dx, dz) 方向滚了 distance 这么远：球跟着转相应的角度 */
  roll(dx: number, dz: number, distance: number): void {
    if (distance === 0) return;
    axis.set(dx, 0, dz).normalize();
    axis.crossVectors(UP, axis);
    turn.setFromAxisAngle(axis, distance / this.radius);
    this.spin.quaternion.premultiply(turn);
  }

  dispose(): void {
    for (const item of this.owned) item.dispose();
  }
}

/** 两片绕着同一根轴拧起来的薄片（一左一右），两头收尖。turn 是整体绕轴转过的角度，wide 是薄片伸出多宽（相对半径）。 */
function swirl(radius: number, turn: number, wide: number): THREE.BufferGeometry {
  const blades = 2;
  const along = 28;
  const across = 6;
  const length = radius * 0.78;
  const width = radius * wide;
  const twist = Math.PI * 0.85;
  const positions: number[] = [];
  const index: number[] = [];
  for (let b = 0; b < blades; b++) {
    const base = positions.length / 3;
    for (let i = 0; i <= along; i++) {
      const u = (i / along) * 2 - 1;
      const angle = turn + (b / blades) * Math.PI * 2 + u * twist;
      const w = width * Math.pow(1 - u * u, 0.7);
      for (let j = 0; j <= across; j++) {
        const v = j / across;
        // 薄片从轴心往外伸，带一点弧度
        const r = v * w;
        const bend = angle + v * 0.5;
        positions.push(Math.cos(bend) * r, u * length, Math.sin(bend) * r);
      }
    }
    for (let i = 0; i < along; i++) {
      for (let j = 0; j < across; j++) {
        const a = base + i * (across + 1) + j;
        const c = a + across + 1;
        index.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
