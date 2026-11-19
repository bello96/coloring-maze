// 现场画出来的木纹：不带任何图片文件，三种木头（浅色的底板、深一些的面板、深色的桌面）都在这里生成。
//
// 画法照着真木头的构造来：
// - 树干是一圈套一圈的年轮。木板是从树干上顺着锯下来的一片，板面和年轮斜着相交，
//   所以板面上看到的不是一道道平行线，而是一个套一个的拱形（"山纹"），越靠板边越密、越直。
// - 一圈年轮里，春天长的那部分颜色浅，入秋越来越密、越来越深，过了冬突然回到浅色——所以年轮线一侧是渐变、一侧是硬边。
// - 顺着树干方向是一根根木纤维：很细、很长的深浅条纹。
// - 导管被锯开后是一道道顺纹的小黑槽（胡桃木上很明显）。
//
// 这些都要画到一两个像素那么细才像真的，在 JavaScript 里逐点算太慢，所以交给显卡画，画完读回来放进画布
// （之后托盘要在上面刻字，界面的木片按钮也要拿它当底纹）。木纹顺着画布的竖直方向走。
import * as THREE from 'three';

type RGB = readonly [number, number, number];

export interface WoodSpec {
  /** 画布边长（像素） */
  readonly size: number;
  readonly seed: number;
  /** 画布的一条边相当于多少毫米。年轮多宽、纹理多大都按毫米算，所以这个数越大，纹理看起来越细密 */
  readonly span: number;
  /** 最深、中间、最浅三种颜色，木纹在它们之间变化 */
  readonly dark: RGB;
  readonly mid: RGB;
  readonly light: RGB;
  /** 导管小槽的颜色 */
  readonly pore: RGB;
  /** 一圈年轮多宽（毫米） */
  readonly ring: number;
  /** 树心在哪：离木板中线多远、在板面以下多深（毫米）。越深，板面上的拱形越宽、越平 */
  readonly pith: readonly [number, number];
  /** 板面和树干的夹角（每毫米长度上离树心远多少毫米）：越大，拱形一个接一个排得越密 */
  readonly taper: number;
  /** 树干不是笔直的：树心左右偏多少（毫米） */
  readonly wander: number;
  /** 年轮歪歪扭扭的程度（以年轮的宽度为单位） */
  readonly wobble: number;
  /** 年轮线有多深 */
  readonly contrast: number;
  /** 顺着年轮走的大片深浅（心材里一道一道的色素） */
  readonly streak: number;
  /** 整块木头上大片的深浅不匀 */
  readonly blotch: number;
  /** 木纤维的细条纹有多明显 */
  readonly fibre: number;
  /** 导管小槽有多密（0–1）、有多深 */
  readonly pores: number;
  readonly poreDepth: number;
  /** 横着纹理的"虎皮"波光有多明显 */
  readonly curl: number;
  /** 把画布分成几块木板（桌面用）；1 就是一整块 */
  readonly planks?: number;
}

export interface WoodCanvases {
  readonly color: HTMLCanvasElement;
  /** 表面的起伏：越亮越高 */
  readonly relief: HTMLCanvasElement;
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;

uniform float uSize;
uniform float uSpan;
uniform int uSeed;
uniform int uPass;
uniform vec3 uDark;
uniform vec3 uMid;
uniform vec3 uLight;
uniform vec3 uPore;
uniform float uRing;
uniform vec2 uPith;
uniform float uTaper;
uniform float uWander;
uniform float uWobble;
uniform float uContrast;
uniform float uStreak;
uniform float uBlotch;
uniform float uFibre;
uniform float uPores;
uniform float uPoreDepth;
uniform float uCurl;
uniform float uPlanks;
varying vec2 vUv;

// 用整数来打散：各家显卡算出来的结果一模一样（用 sin 的那种写法在手机上会出条纹）
uint scramble(uvec3 v) {
  v *= uvec3(0x9E3779B1u, 0x85EBCA77u, 0xC2B2AE3Du);
  uint h = v.x ^ v.y ^ v.z;
  h ^= h >> 15;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12;
  h *= 0x297A2D39u;
  h ^= h >> 15;
  return h;
}
float rnd(ivec2 p, int s) {
  return float(scramble(uvec3(uvec2(p), uint(s + uSeed))) >> 8) / 16777216.0;
}
// 平滑的噪声，0–1
float noise(vec2 p, int s) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec2 c = ivec2(i);
  float a = rnd(c, s);
  float b = rnd(c + ivec2(1, 0), s);
  float d = rnd(c + ivec2(0, 1), s);
  float e = rnd(c + ivec2(1, 1), s);
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
// 大小三层叠在一起，0–1
float cloud(vec2 p, int s) {
  return noise(p, s) * 0.5 + noise(p * 2.07 + 13.7, s + 1) * 0.3 + noise(p * 4.21 + 5.3, s + 2) * 0.2;
}

// 一层导管小槽：把板面分成又窄又长的小格，每格里也许有一道。p 的单位是像素。
float poreLayer(vec2 p, float cw, float ch, float density, int s) {
  vec2 g = vec2(p.x / cw, p.y / ch);
  float col = floor(g.x);
  // 相邻两列错开，不然小槽的头尾会排成一条条横线
  g.y += rnd(ivec2(int(col), 5), s) * 13.0;
  vec2 id = floor(g);
  vec2 f = g - id;
  ivec2 ii = ivec2(id);
  float present = step(rnd(ii, s + 1), density);
  float cx = mix(0.3, 0.7, rnd(ii, s + 2));
  float len = mix(0.3, 0.92, rnd(ii, s + 3));
  float wid = mix(0.55, 1.0, rnd(ii, s + 4));
  float dx = (f.x - cx) * cw / wid;
  float dy = abs(f.y - 0.5) / (0.5 * len);
  return present * exp(-dx * dx * 1.6) * (1.0 - smoothstep(0.55, 1.0, dy)) * mix(0.55, 1.0, rnd(ii, s + 5));
}

void main() {
  vec2 px = vUv * uSize;
  vec2 mm = vUv * uSpan;

  // 桌面是几块木板拼的：每块取自树干上不同的地方，深浅、纹理各不相同
  bool many = uPlanks > 1.5;
  float plankW = uSpan / uPlanks;
  float plankF = mm.x / plankW;
  float plank = floor(plankF);
  int pi = int(plank);
  float pr0 = rnd(ivec2(pi, 101), 0);
  float pr1 = rnd(ivec2(pi, 102), 0);
  float pr2 = rnd(ivec2(pi, 103), 0);
  float pr3 = rnd(ivec2(pi, 104), 0);
  float pr4 = rnd(ivec2(pi, 105), 0);
  float off = many ? pr0 * 3000.0 + plank * 517.0 : 0.0;
  // q：这块木板自己的坐标（毫米），x 从板的中线量起，y 顺着纹理
  vec2 q = vec2(mm.x - (plank + 0.5) * plankW, mm.y - uSpan * 0.5);
  // n：查噪声用的坐标，每块木板错开很远
  vec2 n = vec2(q.x, mm.y + off);
  vec2 pith = many ? vec2((pr1 - 0.5) * plankW * 2.2, uPith.y * mix(0.5, 1.9, pr2)) : uPith;
  float taper = many ? uTaper * mix(-1.4, 1.4, pr3) : uTaper;

  // ── 年轮 ──
  float wander = (noise(vec2(n.y / 210.0, 3.5), 11) - 0.5) * uWander;
  float cx = q.x - pith.x + wander;
  float cz = pith.y + q.y * taper + (noise(vec2(n.y / 330.0, 7.5), 12) - 0.5) * uWander * 0.7;
  float r = sqrt(cx * cx + cz * cz);
  r += (cloud(vec2(n.x / 34.0, n.y / 170.0), 13) - 0.5) * uWobble * uRing * 2.4;
  r += (noise(vec2(n.x / 7.0, n.y / 60.0), 16) - 0.5) * uWobble * uRing * 0.45;
  float t = r / uRing;
  // 年景有好有坏，年轮有宽有窄
  t += (noise(vec2(t * 0.29, 0.5), 17) - 0.5) * 1.0 + (noise(vec2(t * 0.063, 1.5), 18) - 0.5) * 2.5;
  float ring = floor(t);
  float f = t - ring;
  int ri = int(ring);
  float rr0 = rnd(ivec2(ri, 7), 19);
  float rr1 = rnd(ivec2(ri, 8), 19);
  float perPixel = fwidth(t);
  float late = pow(smoothstep(0.1, 1.0, f), mix(2.4, 5.5, rr0));
  // 硬边的那一侧抹开一个像素，免得出锯齿
  late *= 1.0 - smoothstep(1.0 - clamp(perPixel * 1.3, 0.002, 0.45), 1.0, f);
  late *= mix(0.5, 1.0, rr1);
  // 年轮挤得比像素还密的地方画不出来，就按平均的深浅算
  late = mix(late, 0.22, smoothstep(0.4, 0.8, perPixel));

  // ── 大片的深浅和色调 ──
  float streak = cloud(vec2(t * 0.085, n.y / 520.0), 21) - 0.5;
  float blotch = cloud(vec2(n.x / 80.0, n.y / 260.0), 24) - 0.5;
  float hue = cloud(vec2(n.x / 130.0, n.y / 420.0), 33) - 0.5;

  // ── 木纤维：一两个像素宽、很长的细条纹（单位是像素，所以总是画到最细）──
  float gx = px.x + plank * 371.0 + (noise(vec2(n.x / 45.0, n.y / 320.0), 27) - 0.5) * 26.0;
  float gy = px.y + off * 8.0;
  float fibre =
    (noise(vec2(gx / 2.3, gy / 64.0), 28) - 0.5) * 0.36 +
    (noise(vec2(gx / 5.0, gy / 150.0), 29) - 0.5) * 0.28 +
    (noise(vec2(gx / 12.0, gy / 280.0), 30) - 0.5) * 0.2 +
    (noise(vec2(gx / 30.0, gy / 620.0), 31) - 0.5) * 0.16;

  // ── 导管：春天长的那部分里多，秋天长的那部分里少 ──
  // 一圈年轮刚开始长的那一小段导管最密，所以年轮线的浅色一侧常有一排小槽
  float crowd = uPores * mix(1.0, 0.25, late) * (1.0 + 1.1 * (1.0 - smoothstep(0.0, 0.28, f))) * (0.5 + 0.8 * noise(vec2(n.x / 26.0, n.y / 90.0), 39));
  float pores =
    poreLayer(vec2(gx, gy), 4.6, 30.0, crowd, 40) +
    poreLayer(vec2(gx + 2.3, gy + 11.0), 7.0, 54.0, crowd * 0.8, 47) * 0.8;
  pores = clamp(pores, 0.0, 1.0);

  // ── 木板之间的缝 ──
  float seam = 0.0;
  if (many) {
    float edge = min(plankF - plank, 1.0 - (plankF - plank)) * plankW * uSize / uSpan;
    seam = 1.0 - smoothstep(0.7, 2.4, edge);
  }

  if (uPass == 0) {
    float d = 0.4 + late * uContrast + streak * uStreak + blotch * uBlotch + fibre * uFibre;
    d = clamp(d, 0.0, 1.0);
    vec3 col = d < 0.5 ? mix(uLight, uMid, d * 2.0) : mix(uMid, uDark, d * 2.0 - 1.0);
    // 不只是深浅在变：有的地方偏红，有的地方偏灰
    col *= vec3(1.0 + hue * 0.1, 1.0, 1.0 - hue * 0.14);
    // 纤维一顺一逆，横着纹理看过去有一道道柔和的波光
    float wave = sin(n.y / 9.0 + noise(vec2(n.x / 60.0, n.y / 140.0), 36) * 18.0);
    col *= 1.0 + wave * uCurl * noise(vec2(n.x / 90.0, n.y / 200.0), 37);
    col = mix(col, uPore, pores * uPoreDepth);
    if (many) col *= 1.0 + (pr4 - 0.5) * 0.4;
    col *= 1.0 - seam * 0.62;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  } else {
    // 起伏：导管是小槽，纤维有细微的高低，秋材略硬、磨得略低一点点
    float height = 0.62 + fibre * 0.34 - pores * 0.55 - late * 0.08 - seam * 0.6;
    gl_FragColor = vec4(vec3(clamp(height, 0.0, 1.0)), 1.0);
  }
}
`;

const unit = (c: RGB): THREE.Vector3 => new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255);

/** 画木纹的"锯木厂"：几种木头共用一套着色器，画完之后 dispose */
export class WoodMill {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSize: { value: 1 },
        uSpan: { value: 1 },
        uSeed: { value: 0 },
        uPass: { value: 0 },
        uDark: { value: new THREE.Vector3() },
        uMid: { value: new THREE.Vector3() },
        uLight: { value: new THREE.Vector3() },
        uPore: { value: new THREE.Vector3() },
        uRing: { value: 1 },
        uPith: { value: new THREE.Vector2() },
        uTaper: { value: 0 },
        uWander: { value: 0 },
        uWobble: { value: 0 },
        uContrast: { value: 0 },
        uStreak: { value: 0 },
        uBlotch: { value: 0 },
        uFibre: { value: 0 },
        uPores: { value: 0 },
        uPoreDepth: { value: 0 },
        uCurl: { value: 0 },
        uPlanks: { value: 1 },
      },
    });
    // 一个盖住整个画面的三角形
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geometry, this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  make(spec: WoodSpec): WoodCanvases {
    const { size } = spec;
    const u = this.material.uniforms;
    u.uSize.value = size;
    u.uSpan.value = spec.span;
    u.uSeed.value = spec.seed % 100000;
    (u.uDark.value as THREE.Vector3).copy(unit(spec.dark));
    (u.uMid.value as THREE.Vector3).copy(unit(spec.mid));
    (u.uLight.value as THREE.Vector3).copy(unit(spec.light));
    (u.uPore.value as THREE.Vector3).copy(unit(spec.pore));
    u.uRing.value = spec.ring;
    (u.uPith.value as THREE.Vector2).set(spec.pith[0], spec.pith[1]);
    u.uTaper.value = spec.taper;
    u.uWander.value = spec.wander;
    u.uWobble.value = spec.wobble;
    u.uContrast.value = spec.contrast;
    u.uStreak.value = spec.streak;
    u.uBlotch.value = spec.blotch;
    u.uFibre.value = spec.fibre;
    u.uPores.value = spec.pores;
    u.uPoreDepth.value = spec.poreDepth;
    u.uCurl.value = spec.curl;
    u.uPlanks.value = spec.planks ?? 1;

    const target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, generateMipmaps: false });
    const pixels = new Uint8Array(size * size * 4);
    const draw = (pass: number): HTMLCanvasElement => {
      u.uPass.value = pass;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.camera);
      this.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const image = ctx.createImageData(size, size);
      image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
      return canvas;
    };
    const out = { color: draw(0), relief: draw(1) };
    this.renderer.setRenderTarget(null);
    target.dispose();
    return out;
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}

/** 底板：桦木夹板的面皮。颜色浅、纹理细，年轮只是淡淡的宽纹（旋切的面皮几乎贴着年轮切，所以纹路又宽又乱） */
export const BIRCH: Omit<WoodSpec, 'size'> = {
  seed: 20261116,
  span: 200,
  dark: [186, 146, 96],
  mid: [218, 184, 130],
  light: [236, 208, 158],
  pore: [150, 112, 70],
  ring: 3.4,
  pith: [30, 260],
  taper: 0.035,
  wander: 30,
  wobble: 1.5,
  contrast: 0.3,
  streak: 0.22,
  blotch: 0.2,
  fibre: 0.36,
  pores: 0.3,
  poreDepth: 0.3,
  curl: 0.05,
};

/** 面板：胡桃木。巧克力色，山纹明显，有一道道深色的色素条纹和清楚的导管小槽 */
export const WALNUT: Omit<WoodSpec, 'size'> = {
  seed: 77003,
  span: 250,
  dark: [46, 27, 18],
  mid: [98, 63, 42],
  light: [146, 104, 70],
  pore: [30, 18, 12],
  ring: 3.0,
  pith: [-18, 46],
  taper: 0.085,
  wander: 16,
  wobble: 1.0,
  contrast: 0.4,
  streak: 0.52,
  blotch: 0.24,
  fibre: 0.5,
  pores: 0.5,
  poreDepth: 0.6,
  curl: 0.035,
};

/** 桌面：很深的木板拼成 */
export const TABLE: Omit<WoodSpec, 'size'> = {
  seed: 4242,
  span: 400,
  dark: [14, 9, 7],
  mid: [31, 20, 14],
  light: [50, 33, 23],
  pore: [8, 5, 4],
  ring: 3.6,
  pith: [0, 70],
  taper: 0.05,
  wander: 20,
  wobble: 1.0,
  contrast: 0.4,
  streak: 0.3,
  blotch: 0.24,
  fibre: 0.36,
  pores: 0.3,
  poreDepth: 0.35,
  curl: 0.0,
  planks: 4,
};

/**
 * 桌面（电脑上用的）：浅色的橡木板拼成，被灯照得亮堂堂的，深色的托盘放在上面一眼就看得见。
 * 木板的拼法和 TABLE 一样，只是换了一种木头：颜色浅、偏黄褐，山纹宽而平。
 */
export const DESK: Omit<WoodSpec, 'size'> = {
  ...TABLE,
  seed: 31337,
  dark: [118, 88, 58],
  mid: [150, 118, 82],
  light: [176, 145, 106],
  pore: [92, 66, 42],
  contrast: 0.34,
  streak: 0.2,
  blotch: 0.2,
  fibre: 0.4,
  pores: 0.42,
  poreDepth: 0.4,
};
