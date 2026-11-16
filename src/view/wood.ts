// 现场画出来的木纹：不带任何图片文件，三种木头（浅色的底板、深一些的面板、深色的桌面）都在这里生成。
// 木纹顺着画布的竖直方向走。同时生成一张"起伏"图，给木头表面一点点细微的凹凸。

type RGB = readonly [number, number, number];

export interface WoodSpec {
  /** 画布边长（像素） */
  readonly size: number;
  readonly seed: number;
  /** 最深、中间、最浅三种颜色，木纹在它们之间变化 */
  readonly dark: RGB;
  readonly mid: RGB;
  readonly light: RGB;
  /** 横向有多少圈年轮 */
  readonly rings: number;
  /** 年轮线有多深 */
  readonly ringDepth: number;
  /** 顺纹的细丝有多明显 */
  readonly fibre: number;
  /** 纹理左右摆动的幅度（0 是笔直的） */
  readonly sway: number;
  /** 整块木头上大片的深浅不匀 */
  readonly blotch: number;
  /** 把画布分成几块木板（桌面用）；1 就是一整块 */
  readonly planks?: number;
}

export interface WoodCanvases {
  readonly color: HTMLCanvasElement;
  readonly relief: HTMLCanvasElement;
}

/** 一个二维的平滑噪声：同一个种子总是给出同一幅图 */
function makeNoise(seed: number): (x: number, y: number) => number {
  const table = new Float32Array(256);
  const perm = new Uint8Array(512);
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 256; i++) {
    table[i] = rand();
    perm[i] = i;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const x0 = xi & 255;
    const y0 = yi & 255;
    const p00 = table[perm[perm[x0] + y0]];
    const p10 = table[perm[perm[x0 + 1] + y0]];
    const p01 = table[perm[perm[x0] + y0 + 1]];
    const p11 = table[perm[perm[x0 + 1] + y0 + 1]];
    return p00 + (p10 - p00) * u + (p01 - p00) * v + (p00 - p10 - p01 + p11) * u * v;
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function makeWood(spec: WoodSpec): WoodCanvases {
  const { size } = spec;
  const noise = makeNoise(spec.seed);
  const color = document.createElement('canvas');
  const relief = document.createElement('canvas');
  color.width = color.height = relief.width = relief.height = size;
  const colorCtx = color.getContext('2d')!;
  const reliefCtx = relief.getContext('2d')!;
  const colorData = colorCtx.createImageData(size, size);
  const reliefData = reliefCtx.createImageData(size, size);
  const cd = colorData.data;
  const rd = reliefData.data;
  const planks = spec.planks ?? 1;

  // 每块木板有自己的深浅、自己的纹理，接缝处错开
  const plankTone = new Float32Array(planks);
  const plankShift = new Float32Array(planks);
  for (let p = 0; p < planks; p++) {
    plankTone[p] = planks > 1 ? (noise(p * 7.31 + 3.7, 11.9) - 0.5) * 0.3 : 0;
    plankShift[p] = planks > 1 ? noise(p * 3.17 + 1.3, 5.1) * 97 : 0;
  }

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const plank = Math.min(planks - 1, Math.floor(u * planks));
      const shift = plankShift[plank];
      const pu = u + shift;
      const pv = v + shift * 0.37;

      // 纹理不是笔直的：沿着长度方向慢慢地左右摆
      const sway = ((noise(pu * 2.1, pv * 0.7) - 0.5) * 0.16 + (noise(pu * 5.3, pv * 1.9) - 0.5) * 0.05) * spec.sway;
      const ring = (pu + sway) * spec.rings;
      // 一圈年轮：从浅慢慢变深，到头是一道细细的深线，然后重新开始
      const within = ring + (noise(ring * 0.9, pv * 2.5) - 0.5) * 0.5;
      const f = within - Math.floor(within);
      const line = Math.pow(f, 2.4) * (1 - Math.max(0, (f - 0.93) / 0.07));
      // 每一圈自己的深浅
      const ringTone = noise(Math.floor(within) * 0.731 + 9.1, 3.3) - 0.5;
      // 顺纹的细丝：横向很密，纵向拉得很长
      const fibre = noise(ring * 7, pv * 4) * 0.55 + noise(ring * 29, pv * 15) * 0.45 - 0.5;
      const blotch = noise(pu * 1.4 + 31, pv * 1.2 + 7) - 0.5 + (noise(pu * 3.1 + 5, pv * 2.8 + 19) - 0.5) * 0.5;

      let t = 0.62 - line * spec.ringDepth + ringTone * 0.22 * spec.ringDepth + fibre * spec.fibre + blotch * spec.blotch + plankTone[plank];

      // 木板之间的缝
      let seam = 0;
      if (planks > 1) {
        const edge = Math.abs(u * planks - Math.round(u * planks)) * (size / planks);
        if (edge < 1.6) seam = 1 - edge / 1.6;
      }

      t = clamp01(t);
      const lo = t < 0.5 ? spec.dark : spec.mid;
      const hi = t < 0.5 ? spec.mid : spec.light;
      const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const shade = 1 - seam * 0.55;
      const i = (y * size + x) * 4;
      cd[i] = (lo[0] + (hi[0] - lo[0]) * k) * shade;
      cd[i + 1] = (lo[1] + (hi[1] - lo[1]) * k) * shade;
      cd[i + 2] = (lo[2] + (hi[2] - lo[2]) * k) * shade;
      cd[i + 3] = 255;

      // 起伏：深色的年轮线和细丝略微凹下去
      const h = clamp01(0.6 - line * 0.35 + fibre * 0.5 - seam * 0.9) * 255;
      rd[i] = rd[i + 1] = rd[i + 2] = h;
      rd[i + 3] = 255;
    }
  }
  colorCtx.putImageData(colorData, 0, 0);
  reliefCtx.putImageData(reliefData, 0, 0);
  return { color, relief };
}

/** 底板：浅色的桦木，纹理细而直 */
export const BIRCH: Omit<WoodSpec, 'size'> = {
  seed: 20261116,
  dark: [176, 132, 80],
  mid: [214, 176, 118],
  light: [234, 204, 150],
  rings: 30,
  ringDepth: 0.3,
  fibre: 0.34,
  sway: 0.9,
  blotch: 0.16,
};

/** 面板：深一些的胡桃木，年轮线明显 */
export const WALNUT: Omit<WoodSpec, 'size'> = {
  seed: 77003,
  dark: [58, 33, 19],
  mid: [103, 63, 37],
  light: [141, 93, 57],
  rings: 19,
  ringDepth: 0.5,
  fibre: 0.34,
  sway: 1.7,
  blotch: 0.3,
};

/** 桌面：很深的木板拼成 */
export const TABLE: Omit<WoodSpec, 'size'> = {
  seed: 4242,
  dark: [17, 11, 8],
  mid: [34, 22, 15],
  light: [52, 34, 23],
  rings: 22,
  ringDepth: 0.55,
  fibre: 0.34,
  sway: 2.6,
  blotch: 0.3,
  planks: 5,
};
