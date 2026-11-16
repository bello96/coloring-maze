import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { applyFraming, frameBox, type FrameRequest } from './framing.ts';
import { BASE_THICKNESS, OUTER } from './dims.ts';
import type { TrayAssets } from './tray.ts';
import { BIRCH, TABLE, WALNUT, makeWood } from './wood.ts';

/** 画面四边各留出多少像素给界面 */
export interface Insets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** 相机的竖直视角和俯视的倾角（度） */
const FOV = 28;
const TILT = 13;
/** 取景时按最高的墙来算，这样换关时相机不用动 */
const TALLEST = BASE_THICKNESS + 0.85;
/** 平时阴影只需要盖住托盘这么大一块；换关时托盘要滑出画面，临时放大 */
const SHADOW_REACH = 9.5;

/** 舞台：渲染器、相机、灯光、桌面，以及所有托盘共用的木纹素材 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 400);
  /** 托盘都放在这里面：它的原点在桌面上方一个底板的厚度处，也就是托盘底板的表面 */
  readonly board = new THREE.Group();
  readonly assets: TrayAssets;
  private readonly key: THREE.DirectionalLight;
  private readonly woods: { readonly dark: HTMLCanvasElement; readonly light: HTMLCanvasElement };
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement, font: string) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(0x120c09);

    // 四周柔和的环境光和玻璃球上的反光，来自一间程序生成的"摄影棚"，不用任何图片
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.4;
    pmrem.dispose();

    // 主光从左后上方照下来，影子落向右前方
    this.key = new THREE.DirectionalLight(0xfff0db, 3.1);
    this.key.position.set(-9.5, 12.5, -7.5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = 0.025;
    this.key.shadow.radius = 5;
    this.key.shadow.camera.near = 2;
    this.key.shadow.camera.far = 60;
    this.setShadowReach(SHADOW_REACH);
    this.scene.add(this.key, this.key.target);
    // 一点偏冷的补光，从玩家这一侧照亮朝前的墙面
    const fill = new THREE.DirectionalLight(0xcfdcff, 0.32);
    fill.position.set(5, 9, 12);
    this.scene.add(fill);

    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const texture = (canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
      const t = new THREE.CanvasTexture(canvas);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = anisotropy;
      return t;
    };
    const birch = makeWood({ ...BIRCH, size: 1024 });
    const walnut = makeWood({ ...WALNUT, size: 1024 });
    const tableWood = makeWood({ ...TABLE, size: 1024 });
    this.woods = { dark: walnut.color, light: birch.color };
    this.assets = {
      birch: texture(birch.color, true),
      birchRelief: texture(birch.relief, false),
      walnut: walnut.color,
      walnutRelief: walnut.relief,
      plyEdge: texture(plyEdge(), true),
      anisotropy,
      font,
      sun: this.key.target.position.clone().sub(this.key.position).normalize(),
    };

    const tableMap = texture(tableWood.color, true);
    const tableRelief = texture(tableWood.relief, false);
    for (const t of [tableMap, tableRelief]) {
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.repeat.set(3, 3);
    }
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ map: tableMap, bumpMap: tableRelief, bumpScale: 1.2, roughness: 0.56 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);

    this.board.position.y = BASE_THICKNESS;
    this.scene.add(this.board);
  }

  /** 阴影要盖住左右多远（世界单位） */
  setShadowReach(reach = SHADOW_REACH): void {
    const cam = this.key.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = SHADOW_REACH;
    cam.bottom = -SHADOW_REACH;
    cam.updateProjectionMatrix();
    this.key.shadow.needsUpdate = true;
  }

  /** 画面大小变了，或者界面占的地方变了：重新取景 */
  resize(width: number, height: number, pixelRatio: number, safe: Insets): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    const req: FrameRequest = {
      fov: FOV,
      tilt: TILT,
      width: this.width,
      height: this.height,
      halfWidth: OUTER / 2,
      halfDepth: OUTER / 2,
      boxHeight: TALLEST,
      safe,
    };
    applyFraming(this.camera, frameBox(req), req);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** 把两种木纹缩小成图片地址，界面上的木片按钮和面板拿去当底纹，这样和托盘是同一种木头 */
  woodUrls(): { dark: string; light: string } {
    const shrink = (source: HTMLCanvasElement): string => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 512;
      canvas.getContext('2d')!.drawImage(source, 0, 0, 512, 512);
      return canvas.toDataURL('image/jpeg', 0.82);
    };
    return { dark: shrink(this.woods.dark), light: shrink(this.woods.light) };
  }
}

/** 夹板的断面：几层薄木片叠在一起，一层深一层浅 */
function plyEdge(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const layers = ['#dcc08e', '#b28a58', '#d6b784', '#a98050', '#dabd8a'];
  const h = canvas.height / layers.length;
  layers.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, i * h, canvas.width, h + 1);
    ctx.fillStyle = 'rgba(60, 36, 18, 0.55)';
    ctx.fillRect(0, i * h, canvas.width, 1);
  });
  // 一点点横向的深浅变化，免得太像色块
  for (let x = 0; x < canvas.width; x += 2) {
    ctx.fillStyle = `rgba(70, 40, 20, ${Math.random() * 0.08})`;
    ctx.fillRect(x, 0, 2, canvas.height);
  }
  return canvas;
}
