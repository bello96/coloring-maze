import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { applyFraming, frameBox, type FrameRequest } from './framing.ts';
import { isModestGpu } from './sharpness.ts';
import { BASE_THICKNESS, OUTER } from './dims.ts';
import type { TrayAssets } from './tray.ts';
import { BIRCH, DESK, TABLE, WALNUT, WoodMill } from './wood.ts';

/** 画面四边各留出多少像素给界面 */
export interface Insets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** 要放进画面的托盘有多大：从中心往左右、往前后各伸出多少（世界单位） */
export interface Extent {
  readonly halfWidth: number;
  readonly halfDepth: number;
}

/** 正方形托盘的大小 */
export const SQUARE: Extent = { halfWidth: OUTER / 2, halfDepth: OUTER / 2 };

/** 相机的竖直视角和俯视的倾角（度） */
const FOV = 28;
const TILT = 13;
/** 取景时按最高的墙来算，这样换关时相机不用动 */
const TALLEST = BASE_THICKNESS + 0.85;
/** 平时阴影只需要盖住托盘这么大一块；换关时托盘要滑出画面，临时放大 */
const SHADOW_REACH = 9.5;
/** 平时影子边缘柔化多少（阴影图上的像素数） */
const SHADOW_SOFTNESS = 5;

/**
 * 是不是触屏设备（手机、平板）。样式表里分电脑和触屏用的是同一句话，两边得一致：
 * 电脑上托盘四周露出一大片桌面，用浅色的橡木桌面（DESK）；触屏上还是原来那张深色的（TABLE）。
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

/** 舞台：渲染器、相机、灯光、桌面，以及所有托盘共用的木纹素材 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 400);
  /** 托盘都放在这里面：它的原点在桌面上方一个底板的厚度处，也就是托盘底板的表面 */
  readonly board = new THREE.Group();
  readonly assets: TrayAssets;
  private readonly key: THREE.DirectionalLight;
  private readonly woods: { readonly dark: HTMLCanvasElement; readonly light: HTMLCanvasElement; readonly table: HTMLCanvasElement };
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
    // 电脑上是浅色的桌面，触屏上是深色的（见 TOUCH_QUERY）
    const desk = !window.matchMedia?.(TOUCH_QUERY).matches;
    this.scene.background = new THREE.Color(desk ? 0x96795a : 0x120c09);

    // 手机上切到后台久了，系统会把画面占用的显卡资源收走。回来时与其一样样重建，不如整页重开：
    // 进度是存着的，地址栏里也写着是第几关，重开后还是这一关（从头开始）。
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
    // 木纹要画到一个像素那么细才像真的，所以屏幕上托盘有多少像素，木纹就画多大：又大又细的屏幕配独立显卡用 2048，
    // 其余用 1024（集成显卡本来就不会按屏幕的全部像素来画，见 sharpness.ts；贴图再大只是白白多读显存、掉帧）
    const fine = Math.min(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1) > 1300 && !isModestGpu(this.gpuName());
    const size = fine ? 2048 : 1024;
    const mill = new WoodMill(this.renderer);
    const birch = mill.make({ ...BIRCH, size });
    const walnut = mill.make({ ...WALNUT, size });
    const tableWood = mill.make({ ...(desk ? DESK : TABLE), size });
    mill.dispose();
    this.woods = { dark: walnut.color, light: birch.color, table: tableWood.color };
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
      t.repeat.set(6, 6);
    }
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ map: tableMap, bumpMap: tableRelief, bumpScale: 1.0, roughness: 0.56 }),
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

  /** 画面大小变了，或者界面占的地方变了，或者换了一个大小不一样的托盘：重新取景 */
  resize(width: number, height: number, pixelRatio: number, safe: Insets, box: Extent): void {
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
      halfWidth: box.halfWidth,
      halfDepth: box.halfDepth,
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

  /**
   * 把木纹缩小成图片地址给界面当底纹，这样界面上的木头和托盘是同一种木头：
   * dark、light 给木片按钮、木牌、圆木片；plank 给选关树的那块长木板；table 是桌面，电脑上选关树两边露出来的就是它。
   */
  woodUrls(): { dark: string; light: string; plank: string; table: string } {
    const shrink = (source: HTMLCanvasElement): string => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 512;
      canvas.getContext('2d')!.drawImage(source, 0, 0, 512, 512);
      return canvas.toDataURL('image/jpeg', 0.82);
    };
    return { dark: shrink(this.woods.dark), light: shrink(this.woods.light), plank: plank(this.woods.dark), table: tile(this.woods.table) };
  }
}

/**
 * 选关树那块长木板的底纹。木板有好几千像素长，底纹得一张接一张地往下铺：
 * 把木纹和它上下翻过来的样子接成一张，这样无论接在哪一头，接缝两边的纹理都是连着的。
 * 木纹本来就是竖着走的（顺着木板的长边），不用转。
 */
function plank(source: HTMLCanvasElement): string {
  const size = 768;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, size, size);
  ctx.translate(0, size * 2);
  ctx.scale(1, -1);
  ctx.drawImage(source, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * 桌面的底纹，铺满整个页面用。和 3D 画面里的桌面一样，一张接一张地左右、上下翻着铺（镜像着接，接缝两边的纹理才连得上）：
 * 所以这里把木纹和它翻过来的三个样子拼成一张，这一张怎么平铺都没有缝。
 */
function tile(source: HTMLCanvasElement): string {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * 2;
  const ctx = canvas.getContext('2d')!;
  for (const [flipX, flipY] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    ctx.setTransform(flipX ? -1 : 1, 0, 0, flipY ? -1 : 1, flipX ? size * 2 : 0, flipY ? size * 2 : 0);
    ctx.drawImage(source, 0, 0, size, size);
  }
  return canvas.toDataURL('image/jpeg', 0.8);
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
