import * as THREE from 'three';
import type { Level } from '../game/level.ts';
import { BASE_THICKNESS, BORDER, FLOOR_SIZE, OUTER } from './dims.ts';
import { traceFloor, type Point } from './outline.ts';
import { Stain } from './stain.ts';

const CORNER_RADIUS = 0.5;
const BEVEL = 0.028;

/** 所有托盘共用的木纹等素材 */
export interface TrayAssets {
  readonly birch: THREE.Texture;
  readonly birchRelief: THREE.Texture;
  /** 没刻字的面板木纹；每个托盘在它上面刻上自己的字 */
  readonly walnut: HTMLCanvasElement;
  readonly walnutRelief: HTMLCanvasElement;
  readonly plyEdge: THREE.Texture;
  readonly anisotropy: number;
  /** 刻字用的字体 */
  readonly font: string;
  /** 主光照过来的方向（光线前进的方向） */
  readonly sun: THREE.Vector3;
}

/** 面板顶面的贴图：整张木纹正好铺满托盘，所以边框和中间的每块墙像是从同一张板上切下来的 */
const uvGenerator = {
  generateTopUV(_g: THREE.ExtrudeGeometry, v: number[], a: number, b: number, c: number): THREE.Vector2[] {
    return [a, b, c].map((i) => new THREE.Vector2((v[i * 3] + OUTER / 2) / OUTER, (OUTER / 2 - v[i * 3 + 1]) / OUTER));
  },
  generateSideWallUV(_g: THREE.ExtrudeGeometry, v: number[], a: number, b: number, c: number, d: number): THREE.Vector2[] {
    const alongX = Math.abs(v[a * 3 + 1] - v[b * 3 + 1]) < Math.abs(v[a * 3] - v[b * 3]);
    return [a, b, c, d].map((i) => new THREE.Vector2((alongX ? v[i * 3] : v[i * 3 + 1]) * 0.5, v[i * 3 + 2]));
  },
};

function roundedSquare(size: number, radius: number): THREE.Shape {
  const h = size / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-h + radius, -h);
  shape.lineTo(h - radius, -h);
  shape.absarc(h - radius, -h + radius, radius, -Math.PI / 2, 0, false);
  shape.lineTo(h, h - radius);
  shape.absarc(h - radius, h - radius, radius, 0, Math.PI / 2, false);
  shape.lineTo(-h + radius, h);
  shape.absarc(-h + radius, h - radius, radius, Math.PI / 2, Math.PI, false);
  shape.lineTo(-h, -h + radius);
  shape.absarc(-h + radius, -h + radius, radius, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** 一关的托盘：下层浅色底板，上层挖出迷宫的深色面板，以及底板上的染色 */
export class Tray {
  readonly group = new THREE.Group();
  readonly stain: Stain;
  readonly level: Level;
  /** 一格的边长 */
  readonly cell: number;
  /** 墙比底板高出多少 */
  readonly wallHeight: number;
  readonly ballRadius: number;
  private readonly owned: Array<{ dispose(): void }> = [];

  constructor(level: Level, number: number, assets: TrayAssets, dye: THREE.Color) {
    this.level = level;
    const n = level.cols;
    this.cell = FLOOR_SIZE / n;
    this.wallHeight = 0.34 * this.cell + 0.12;
    this.ballRadius = 0.4 * this.cell;
    this.stain = new Stain(level, dye, assets.sun);
    this.owned.push(this.stain);

    // 格线交点 → 面板轮廓用的平面坐标（x 向右，y 向屏幕上方，也就是世界的 -z）
    const toShape = ([gx, gy]: Point): THREE.Vector2 => new THREE.Vector2((gx - n / 2) * this.cell, -(gy - n / 2) * this.cell);
    const outline = traceFloor(level);

    const panelMap = this.engrave(assets, number);
    const top = new THREE.MeshStandardMaterial({ map: panelMap.color, bumpMap: panelMap.relief, bumpScale: 1.4, roughness: 0.58 });
    // 激光切出来的断面是焦黑的
    const cut = new THREE.MeshStandardMaterial({ color: 0x38231a, roughness: 0.82 });
    this.owned.push(top, cut, panelMap.color, panelMap.relief);

    const extrude: THREE.ExtrudeGeometryOptions = {
      depth: this.wallHeight - BEVEL,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: BEVEL,
      bevelOffset: -BEVEL,
      bevelSegments: 2,
      curveSegments: 8,
      UVGenerator: uvGenerator,
    };
    const addPanel = (shape: THREE.Shape): void => {
      const geometry = new THREE.ExtrudeGeometry(shape, extrude);
      // 挤出方向是平面的法线；放倒之后顶面朝上，底下那圈倒角埋进底板里看不见
      geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geometry, [top, cut]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.owned.push(geometry);
    };

    const frame = roundedSquare(OUTER, CORNER_RADIUS);
    frame.holes.push(new THREE.Path(outline.outer.map(toShape)));
    addPanel(frame);
    for (const island of outline.islands) addPanel(new THREE.Shape(island.map(toShape)));

    // 底板：能看见的只有迷宫里的那部分地面，和托盘外侧露出来的一圈夹板断面
    const floorGeometry = new THREE.BufferGeometry();
    const h = FLOOR_SIZE / 2;
    floorGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-h, 0, -h, h, 0, -h, -h, 0, h, h, 0, h], 3));
    floorGeometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    floorGeometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    floorGeometry.setIndex([0, 2, 1, 1, 2, 3]);
    const floorMaterial = new THREE.MeshStandardMaterial({
      map: assets.birch,
      bumpMap: assets.birchRelief,
      bumpScale: 0.9,
      roughness: 0.74,
    });
    this.stain.patch(floorMaterial);
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.receiveShadow = true;
    this.group.add(floor);
    this.owned.push(floorGeometry, floorMaterial);

    const baseGeometry = new THREE.ExtrudeGeometry(roundedSquare(OUTER, CORNER_RADIUS), {
      depth: BASE_THICKNESS - 0.004,
      bevelEnabled: false,
      curveSegments: 8,
    });
    baseGeometry.rotateX(-Math.PI / 2);
    baseGeometry.translate(0, -BASE_THICKNESS, 0);
    const baseFace = new THREE.MeshStandardMaterial({ color: 0xd8bd8c, roughness: 0.8 });
    const baseEdge = new THREE.MeshStandardMaterial({ map: assets.plyEdge, roughness: 0.78 });
    const base = new THREE.Mesh(baseGeometry, [baseFace, baseEdge]);
    base.castShadow = true;
    base.receiveShadow = true;
    this.group.add(base);
    this.owned.push(baseGeometry, baseFace, baseEdge);
  }

  /** 在面板的木纹上刻字：上边框刻游戏名，下边框刻第几关 */
  private engrave(assets: TrayAssets, number: number): { color: THREE.CanvasTexture; relief: THREE.CanvasTexture } {
    const size = 2048;
    const band = (BORDER / OUTER) * size;
    const draw = (source: HTMLCanvasElement, s: number, ink: string, edge: string | null): HTMLCanvasElement => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = s;
      const ctx = canvas.getContext('2d')!;
      // 面板的木纹横着走，和底板的竖纹交错（夹板就是这样一层横一层竖）
      ctx.save();
      ctx.translate(s, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(source, 0, 0, s, s);
      ctx.restore();
      const k = s / size;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = (str: string, y: number, px: number, gap: number): void => {
        ctx.font = `700 ${px * k}px ${assets.font}`;
        const chars = [...str];
        const widths = chars.map((ch) => ctx.measureText(ch).width);
        const total = widths.reduce((a, b) => a + b, 0) + gap * k * (chars.length - 1);
        let x = s / 2 - total / 2;
        chars.forEach((ch, i) => {
          const cx = x + widths[i] / 2;
          if (edge) {
            // 字是凹下去的：左上的内壁背光，留一道深色的边
            ctx.fillStyle = edge;
            ctx.fillText(ch, cx - 2 * k, y * k - 2 * k);
          }
          ctx.fillStyle = ink;
          ctx.fillText(ch, cx, y * k);
          x += widths[i] + gap * k;
        });
      };
      text('染色迷宫', band * 0.5, band * 0.5, band * 0.2);
      text(`第 ${number} 关`, size - band * 0.5, band * 0.36, band * 0.04);
      return canvas;
    };
    // 刻出来的字里填了米白色的漆，在深色木头上才看得清
    const color = new THREE.CanvasTexture(draw(assets.walnut, size, 'rgba(236, 220, 188, 0.93)', 'rgba(22, 11, 5, 0.7)'));
    color.colorSpace = THREE.SRGBColorSpace;
    color.flipY = false;
    color.anisotropy = assets.anisotropy;
    const relief = new THREE.CanvasTexture(draw(assets.walnutRelief, size / 2, 'rgba(0, 0, 0, 0.6)', null));
    relief.flipY = false;
    // 这两张画布很大。手机浏览器给画布的内存有上限，光等垃圾回收来不及，
    // 所以托盘用完时把它们缩成零，马上把内存还回去。
    for (const texture of [color, relief]) {
      const canvas = texture.image as HTMLCanvasElement;
      this.owned.push({ dispose: () => void (canvas.width = canvas.height = 0) });
    }
    return { color, relief };
  }

  /** 托盘上 (x, z) 这个位置是不是迷宫里的地面 */
  isFloorAt(x: number, z: number): boolean {
    const n = this.level.cols;
    const c = Math.floor(x / this.cell + n / 2);
    const r = Math.floor(z / this.cell + n / 2);
    return r >= 0 && r < n && c >= 0 && c < n && this.level.floor[r * n + c] === 1;
  }

  /** 某一格正中在托盘上的位置（y 是底板表面） */
  cellCenter(cell: number, out = new THREE.Vector3()): THREE.Vector3 {
    const n = this.level.cols;
    const r = Math.floor(cell / n);
    const c = cell % n;
    return out.set((c + 0.5 - n / 2) * this.cell, 0, (r + 0.5 - n / 2) * this.cell);
  }

  dispose(): void {
    for (const item of this.owned) item.dispose();
  }
}
