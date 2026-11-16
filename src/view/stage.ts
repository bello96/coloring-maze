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
/** 平时影子边缘柔化多少（阴影图上的像素数） */
const SHADOW_SOFTNESS = 5;

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
  private width = 0;
  private height = 0;
  private ratio = 0;
  /** 影子要重画（灯光的范围变了） */
  private shadowsStale = true;

  constructor(canvas: HTMLCanvasElement, font: string) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 投影子的只有托盘，它不动的时候影子不用每帧重画（见 render）
    this.renderer.shadowMap.autoUpdate = false;
    // 玻璃球后面的景象要先单独画一遍再折射；球很小，这一遍用一半的精度就够，能省下不少
    this.renderer.transmissionResolutionScale = 0.5;
    this.scene.background = new THREE.Color(0x120c09);

    // 手机上切到后台久了，系统会把画面占用的显卡资源收走。回来时与其一样样重建，不如整页重开：
    // 进度是存着的，重开后还是这一关。
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => location.reload());

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

  /**
   * 阴影要盖住离中心多远（世界单位）。
   * 光是斜着照下来的，托盘左右滑动时，在"从光源看过去"的画面里是斜着走的，所以四个方向要一起放宽。
   * 范围放宽后同一张阴影图要盖更大的地方，影子会变糊；把柔化的幅度按比例收小，边缘看起来才和平时差不多。
   */
  setShadowReach(reach = SHADOW_REACH): void {
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -reach;
    cam.right = cam.top = reach;
    cam.updateProjectionMatrix();
    this.key.shadow.radius = (SHADOW_SOFTNESS * SHADOW_REACH) / reach;
    this.shadowsStale = true;
  }

  /** 画面大小变了，或者界面占的地方变了：重新取景 */
  resize(width: number, height: number, pixelRatio: number, safe: Insets): void {
    width = Math.max(1, width);
    height = Math.max(1, height);
    // 只有大小真的变了才动画布：重设画布大小会清空它、重新分配显存，取景滑动时每帧都做就卡了
    if (width !== this.width || height !== this.height || pixelRatio !== this.ratio) {
      this.width = width;
      this.height = height;
      this.ratio = pixelRatio;
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setSize(width, height, false);
    }
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

  /** @param trayMoved 这一帧托盘动过（滑动、倾斜、被撞得一晃），影子要跟着重画 */
  render(trayMoved: boolean): void {
    if (trayMoved || this.shadowsStale) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsStale = false;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** 显卡的名字；浏览器不给的话是空串 */
  gpuName(): string {
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    return typeof name === 'string' ? name : '';
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
