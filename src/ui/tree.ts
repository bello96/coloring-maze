// 选关树：关里点「选关」看到的那一屏。一块很长的胡桃木板上立着一棵大树：粗壮的树干从底下的树根一路往上、越往上越细，
// 左右交替伸出枝杈，每根枝杈的梢上长着一片叶子——一片叶子就是一关，关的序号刻在叶片上。
// 通过的关，叶片和枝上的小叶子染上那一关的染料——树是一关一关被"染"出来的。
// 用的是普通的网页元素加几张 SVG，上下滚动交给浏览器，手机上手感最好。
import type { NodeState } from '../game/progress.ts';
import { starRow } from './star-row.ts';

/** 树上的一关 */
export interface TreeNode {
  readonly state: NodeState;
  /** 这一关染料的颜色 */
  readonly dye: string;
  /** 最好步数，没有是 0 */
  readonly best: number;
  /** 几颗星，没有是 0 */
  readonly stars: 0 | 1 | 2 | 3;
}

/** 一关的叶片放在哪 */
export interface Spot {
  /** 叶片的正中（序号就写在这） */
  readonly x: number;
  readonly y: number;
  /** 枝杈朝哪边伸：-1 左，1 右 */
  readonly side: -1 | 1;
  /** 叶片朝外伸的同时往上翘了多少（弧度） */
  readonly tilt: number;
}

/** 一棵排好的树。长度单位都是像素，路径都是 SVG 的写法 */
export interface TreeLayout {
  readonly width: number;
  readonly height: number;
  /** 写着序号的叶片有多大：从叶柄到叶尖多长（long），最宽的地方的一半（half） */
  readonly leaf: { readonly long: number; readonly half: number };
  /** 每一关的叶片，下标 0 是第 1 关（最靠下） */
  readonly spots: readonly Spot[];
  /** 整棵树的木头：树干、树根、每一关的枝杈、树梢上的细枝。是好几段闭合的线，叠在一起算一整块 */
  readonly wood: string;
  /** 树干（wood 里的一段） */
  readonly trunk: string;
  /** 树根（wood 里的几段） */
  readonly roots: string;
  /**
   * 每一关的枝杈（wood 里的几段）：从树干里面伸出来、一直到叶片叶柄的那一根，
   * 它和树干相接的角里补的两块，枝够长的话还有半路分出去的一根小杈
   */
  readonly branches: readonly string[];
  /** 树皮上一道道竖着的沟：线 */
  readonly bark: string;
  /** 树干背光那半边的暗影：两层，一层套一层，叠出由浅到深 */
  readonly shade: readonly string[];
  /** 树干受光那一侧的一道亮带 */
  readonly light: string;
  /** 枝杈朝下那一侧的暗边、朝上那一侧的亮边：线 */
  readonly limbShade: string;
  readonly limbLight: string;
  /** 每一关枝上的几片小叶子 */
  readonly leaves: readonly string[];
  /** 树梢上的那一簇小叶子 */
  readonly crown: string;
  /** 所有小叶子的叶脉：细线 */
  readonly veins: string;
}

/** 木板最宽多少像素。手机上铺满屏幕宽度；电脑上是居中的一长条 */
export const MAX_BOARD = 560;
/** 相邻两关上下相隔多少 */
const STEP = 88;
/** 最后一关上面留给树梢的、第 1 关下面留给树根的地方 */
const TOP = 300;
const BOTTOM = 236;
/** 树干的脚在第 1 关下面多远、树干的尖在最后一关上面多远（以"一关"为单位） */
const FOOT = -1.55;
const TIP = 1;
/** 叶片的正中在叶柄到叶尖的多少分之一处（最宽的地方附近，序号写在这） */
const HEART = 0.48;
/** 叶柄多长 */
const STALK = 8;

const SVG = 'http://www.w3.org/2000/svg';
const n = (v: number): string => String(Math.round(v * 10) / 10);

type Point = readonly [x: number, y: number];
const at = ([x, y]: Point): string => `${n(x)} ${n(y)}`;
const line = (points: readonly Point[]): string => (points.length > 1 ? `M${points.map(at).join('L')}` : '');

/**
 * 把一圈点连成一段闭合的线。不管给的点是顺时针还是逆时针，写出来的总是朝同一个方向绕：
 * 这样叠在一起的几段（树干和从它里面伸出来的枝）才算一整块，不会在叠着的地方互相挖出洞来。
 */
function ring(points: readonly Point[]): string {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    area += x0 * y1 - x1 * y0;
  }
  return `M${(area < 0 ? [...points].reverse() : points).map(at).join('L')}Z`;
}

/** 0–1 之间的一个数，由 i 和 salt 定下来：同一关每次都一样，相邻的关之间看不出规律。树的"随意"全靠它 */
function chance(i: number, salt: number): number {
  let h = Math.imul(i + 11, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** 一条弯线（三次贝塞尔）上的一点，t 从 0 到 1 */
function curve(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const s = 1 - t;
  const k0 = s * s * s;
  const k1 = 3 * s * s * t;
  const k2 = 3 * s * t * t;
  const k3 = t * t * t;
  return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]];
}

/**
 * 一根粗细随处不同的枝：centre 是中线上依次的点，half 是各点处的半宽。
 * 返回中线两侧的两排点：near 那一排在"顺着中线往前走时的右手边"（屏幕上往右走的枝，这一排在下面）。
 * @param inset 两排点各往中线收进去多少（用来在枝的里面画一道贴着边的线）
 */
function sides(centre: readonly Point[], half: readonly number[], inset = 0): { near: Point[]; far: Point[] } {
  const near: Point[] = [];
  const far: Point[] = [];
  for (let i = 0; i < centre.length; i++) {
    const [x0, y0] = centre[Math.max(0, i - 1)];
    const [x1, y1] = centre[Math.min(centre.length - 1, i + 1)];
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / length;
    const ny = (x1 - x0) / length;
    const w = Math.max(0, half[i] - inset);
    near.push([centre[i][0] + nx * w, centre[i][1] + ny * w]);
    far.push([centre[i][0] - nx * w, centre[i][1] - ny * w]);
  }
  return { near, far };
}

/** 一根枝的一圈轮廓 */
function limb(centre: readonly Point[], half: readonly number[]): string {
  const { near, far } = sides(centre, half);
  return ring([...near, ...far.reverse()]);
}

/**
 * 一片小叶子的轮廓和叶脉：叶柄在 (x, y)，朝 angle（弧度）的方向长出去。
 * 轮廓是两段对称的弧线，靠叶柄的那一头圆、叶尖那一头尖。
 */
function leaflet(x: number, y: number, angle: number, size: number): { outline: string; vein: string } {
  const long = 25 * size;
  const half = 7.4 * size;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const p = (along: number, across: number): string => `${n(x + along * cos - across * sin)} ${n(y + along * sin + across * cos)}`;
  return {
    outline: `M${p(0, 0)}C${p(long * 0.2, -half)} ${p(long * 0.66, -half)} ${p(long, 0)}C${p(long * 0.66, half)} ${p(long * 0.2, half)} ${p(0, 0)}Z`,
    vein: `M${p(long * 0.12, 0)}L${p(long * 0.86, 0)}`,
  };
}

/**
 * 写着序号的那片叶子的轮廓，画在一个长 long、高 half × 2 的框里：叶柄在左边的正中，叶尖在右边的正中。
 * 靠叶柄的那一头圆，最宽的地方在十分之四多一点处，往叶尖收成一个尖。
 */
export function leafOutline(long: number, half: number): string {
  const p = (along: number, across: number): string => `${n(long * along)} ${n(half + half * across)}`;
  return (
    `M${p(0, 0)}C${p(0.03, -0.72)} ${p(0.22, -1)} ${p(0.43, -1)}C${p(0.65, -1)} ${p(0.87, -0.34)} ${p(1, 0)}` +
    `C${p(0.87, 0.34)} ${p(0.65, 1)} ${p(0.43, 1)}C${p(0.22, 1)} ${p(0.03, 0.72)} ${p(0, 0)}Z`
  );
}

/**
 * 叶片上刻的东西，做成一张图垫在叶片上（所有叶片共用这一张）：一条主脉、五对侧脉，
 * 再加叶片的厚度——上沿一道受光的亮边、下沿一道背光的暗边。亮边暗边是把轮廓线往里错开一点画出来的，
 * 错到叶片外面的那一半会被叶片的形状裁掉。
 */
export function leafEngraving(long: number, half: number): string {
  const outline = leafOutline(long, half);
  const p = (along: number, across: number): string => `${n(long * along)} ${n(half + half * across)}`;
  let veins = `M${p(0.02, 0)}L${p(0.95, 0)}`;
  for (const [from, reach] of [
    [0.13, 0.7],
    [0.27, 0.86],
    [0.42, 0.84],
    [0.57, 0.68],
    [0.72, 0.44],
  ] as const) {
    for (const up of [-1, 1]) {
      veins += `M${p(from, 0)}Q${p(from + 0.07, up * reach * 0.62)} ${p(from + 0.17, up * reach)}`;
    }
  }
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${long} ${half * 2}' preserveAspectRatio='none' fill='none'>` +
    `<path d='${outline}' stroke='#fff6e2' stroke-opacity='.5' stroke-width='2.4' transform='translate(0 1.3)'/>` +
    `<path d='${outline}' stroke='#1e0f05' stroke-opacity='.46' stroke-width='2.6' transform='translate(0 -1.4)'/>` +
    `<path d='${veins}' stroke='#28140a' stroke-opacity='.26' stroke-width='1.1' stroke-linecap='round'/>` +
    `</svg>`
  );
}

/** "#2646b8" 这样的颜色拆成红绿蓝三个 0–1 的数 */
function channels(css: string): [number, number, number] {
  const value = parseInt(css.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** 染料染在叶片上是什么颜色：掺进两成白，在深色的木板上才显得出来（再和叶片的木纹叠在一起，见样式表） */
export function tintOf(dye: string): string {
  const mixed = channels(dye).map((v) => Math.round((v * 0.8 + 0.2) * 255));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 桦木的木纹平均下来是什么颜色（染料是叠在它上面的） */
const BIRCH: readonly number[] = [0.86, 0.75, 0.56];

/**
 * 染过色的叶片上，序号用深色的字还是浅色的字：哪一种和底色差得远用哪一种。
 * 深色的染料（靛蓝、茜红……）上是浅色的字，浅色的染料（藤黄）上是深色的字；自选的颜色也照这个办。
 */
export function inkOn(dye: string): 'dark' | 'light' {
  const tint = channels(tintOf(dye));
  // 叶片实际的颜色是染料乘上木纹；算它的亮度（按人眼对红绿蓝的敏感程度加权）
  const linear = tint.map((v, i) => {
    const c = v * BIRCH[i];
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lightness = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  // 亮度在 0.18 上下时，深字、浅字和它的反差正好一样大
  return lightness > 0.18 ? 'dark' : 'light';
}

/**
 * count 关、木板宽 width 像素时，这棵树怎么排。只是算位置，不碰页面。
 * 同样的关数和宽度，排出来的永远是同一棵树。
 */
export function layoutTree(count: number, width: number): TreeLayout {
  const small = width < 480;
  const leaf = small ? { long: 80, half: 26 } : { long: 92, half: 30 };
  const mid = width / 2;
  const last = Math.max(0, count - 1);
  const height = TOP + last * STEP + BOTTOM;
  /** 第 u 关在多高的地方（u 可以带小数；0 是第 1 关，在最下面） */
  const yOf = (u: number): number => height - BOTTOM - u * STEP;
  const uOf = (y: number): number => (height - BOTTOM - y) / STEP;
  const foot = FOOT;
  const tip = last + TIP;

  // 树干的中线：两道很缓的弯叠在一起（十几关才弯一个来回），像一棵自己长出来的树，不是尺子画的，也不像藤那样扭来扭去
  const sway = Math.min(17, width * 0.036);
  const centre = (u: number): number => mid + sway * (0.72 * Math.sin(u * 0.31 + 0.5) + 0.28 * Math.sin(u * 0.83 + 2.1));
  // 树干多粗：关越多树越大、树脚越粗（但不超过木板宽度的五分之一）。往上收细，收得先慢后快——大半棵树都还是粗的，
  // 到了树梢也不是一根细条；贴着地的那一小段再往外撑开，接上树根
  const baseHalf = Math.min(width * 0.1, 13 + count * 0.6);
  const tipHalf = Math.min(12, baseHalf * 0.6);
  const girth = (u: number): number => {
    const t = Math.min(1, Math.max(0, (u - foot) / (tip - foot)));
    return tipHalf + (baseHalf - tipHalf) * (1 - t) ** 0.62 + baseHalf * 0.55 * Math.exp(-(u - foot) * 2.6);
  };
  // 两边的轮廓各有各的一点起伏：树皮不是光溜溜的
  const leftHalf = (u: number): number => girth(u) * (1 + 0.04 * Math.sin(u * 4.3 + 0.7) + 0.02 * Math.sin(u * 9.1 + 2));
  const rightHalf = (u: number): number => girth(u) * (1 + 0.04 * Math.sin(u * 3.7 + 4.1) + 0.02 * Math.sin(u * 10.3 + 0.4));
  /** 树干上的一点：高度是 u，左右在 fraction 处（-1 是左沿，0 是中线，1 是右沿） */
  const onTrunk = (u: number, fraction: number): Point => [centre(u) + (fraction < 0 ? leftHalf(u) : rightHalf(u)) * fraction, yOf(u)];
  /** 这一点在不在树干里面 */
  const inTrunk = ([x, y]: Point): boolean => {
    const u = uOf(y);
    if (u < foot || u > tip) return false;
    const off = x - centre(u);
    return off < 0 ? -off < leftHalf(u) : off < rightHalf(u);
  };

  // ───── 树干 ─────
  const samples = Math.max(8, Math.ceil((tip - foot) * 6));
  const us = Array.from({ length: samples + 1 }, (_, k) => foot + ((tip - foot) * k) / samples);
  const leftEdge = us.map((u) => onTrunk(u, -1));
  const rightEdge = us.map((u) => onTrunk(u, 1));
  // 树尖收成一个钝头（上面接着树梢的几根枝）
  const cap: Point = [centre(tip), yOf(tip) - tipHalf * 1.2];
  const trunk = ring([...leftEdge, cap, ...rightEdge.reverse()]);
  /**
   * 树干上竖着的一长条：从 from 到 to（都是 onTrunk 的 fraction）。
   * 靠近树脚、树尖的那一小段，from 那条线渐渐并到 to 上去：这一条到两头是收成一个尖，不留一道齐刷刷的横边。
   */
  const band = (from: number, to: number): string => {
    const inner = us.map((u) => {
      const r = Math.min(1, Math.max(0, Math.min(u - foot - 0.15, tip - 0.1 - u) / 0.9));
      return onTrunk(u, to + (from - to) * r * r * (3 - 2 * r));
    });
    return ring([...inner, ...us.map((u) => onTrunk(u, to)).reverse()]);
  };
  const shade = [band(0.3, 1), band(0.64, 1)];
  const light = band(-0.5, -0.9);

  // 树皮上的沟：顺着树干走的几道线，各自有一搭没一搭地断开；树干细到挤不下了就只留三道
  const furrows: string[] = [];
  const LANES = [-0.76, -0.52, -0.3, -0.08, 0.14, 0.36, 0.58, 0.8];
  LANES.forEach((lane, k) => {
    // 每一道在树脚、树尖各留出一段不画，留多少各不一样：几道沟不会齐刷刷地从同一个高度起头
    const low = foot + 0.12 + 0.5 * chance(k, 30);
    const high = tip - 0.9 - 1.1 * chance(k, 31);
    let run: Point[] = [];
    const end = (): void => {
      if (run.length > 2) furrows.push(line(run));
      run = [];
    };
    for (const u of us) {
      const half = girth(u);
      // 一道沟占 0.22 个半宽：不到 3 像素就太挤了。细的那一段只留隔两道的
      const room = half * 0.22 >= 3 || (k % 3 === 1 && half * 0.6 >= 3);
      // 每隔一关多一点换一次"画不画"，十次里画七次；细的那一段画得少些，不然三道线齐齐地排着像条纹
      const on = chance(Math.floor(u * 0.85 + k * 3.7 + 40), 20 + k) < (half * 0.22 >= 3 ? 0.7 : 0.45);
      if (!room || !on || u < low || u > high) {
        end();
        continue;
      }
      const wobble = 0.05 * Math.sin(u * (1.3 + 0.17 * k) + k * 2.1);
      run.push([centre(u) + half * (lane + wobble), yOf(u)]);
    }
    end();
  });

  // ───── 树根：从树脚扎下去的五条，顺着树脚撑开的势头往外、往下，再贴着地面爬出去 ─────
  // 五条的根部并排占满整个树脚（两边的两条，外沿正好接着树干的外沿），所以树干底下那道平的边是露不出来的
  const footX = centre(foot);
  const footY = yOf(foot);
  const footHalf = girth(foot);
  const rootRings: string[] = [];
  const ROOTS: ReadonlyArray<readonly [from: number, thick: number, reach: number, drop: number]> = [
    [-0.64, 0.36, -2.6, 54],
    [-0.34, 0.3, -1.36, 70],
    [0, 0.27, 0.14, 62],
    [0.34, 0.3, 1.42, 68],
    [0.64, 0.36, 2.5, 52],
  ];
  for (const [where, thick, reach, drop] of ROOTS) {
    const from: Point = [footX + where * footHalf, footY - 3];
    const to: Point = [Math.min(width - 14, Math.max(14, footX + reach * footHalf)), footY + drop];
    const b: Point = [from[0] + (to[0] - from[0]) * 0.16, from[1] + (to[1] - from[1]) * 0.6];
    const c: Point = [from[0] + (to[0] - from[0]) * 0.62, to[1] - 1];
    const steps = 10;
    const mids = Array.from({ length: steps + 1 }, (_, k) => curve(from, b, c, to, k / steps));
    rootRings.push(limb(mids, mids.map((_, k) => 1 + (thick * footHalf - 1) * (1 - k / steps) ** 1.3)));
  }
  const roots = rootRings.join('');

  // ───── 每一关：一根枝杈，梢上一片叶片，枝上几片小叶子 ─────
  const spots: Spot[] = [];
  const branches: string[] = [];
  const leaves: string[] = [];
  const veins: string[] = [];
  const limbShade: string[] = [];
  const limbLight: string[] = [];
  for (let i = 0; i < count; i++) {
    const side: -1 | 1 = i % 2 === 0 ? -1 : 1;
    // 叶片朝外伸，叶尖往上翘 13–26 度
    const tilt = ((13 + 13 * chance(i, 1)) * Math.PI) / 180;
    const dx = side * Math.cos(tilt);
    const dy = -Math.sin(tilt);
    // 叶片的正中离木板的中线多远：最远是叶尖离木板边还有 10 像素；最近要让枝杈在树干外面露出一截。两头之间随意取，枝杈就有长有短
    const farthest = mid - 10 - (leaf.long * (1 - HEART) * Math.cos(tilt) + leaf.half * Math.sin(tilt));
    const nearest = girth(i) + sway + 22 + STALK + leaf.long * HEART * Math.cos(tilt);
    const reach = farthest - Math.min(56, Math.max(0, farthest - nearest)) * chance(i, 2);
    const spot: Spot = { x: mid + side * reach, y: yOf(i) + (chance(i, 3) - 0.5) * 8, side, tilt };
    spots.push(spot);

    // 枝杈：从叶片下方一关左右处的树干里长出来，斜着往上、往外，越走越平，顺着叶片的方向接上叶柄
    const stalk: Point = [spot.x - dx * leaf.long * HEART, spot.y - dy * leaf.long * HEART];
    const end: Point = [stalk[0] - dx * STALK, stalk[1] - dy * STALK];
    const from = i - (0.8 + 0.3 * chance(i, 4));
    const start: Point = [centre(from), yOf(from)];
    const rise = ((44 + 14 * chance(i, 5)) * Math.PI) / 180;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const b: Point = [start[0] + side * Math.cos(rise) * length * 0.36, start[1] - Math.sin(rise) * length * 0.36];
    const c: Point = [end[0] - dx * length * 0.34, end[1] - dy * length * 0.34];
    const steps = 14;
    const mids = Array.from({ length: steps + 1 }, (_, k) => curve(start, b, c, end, k / steps));
    // 从哪一点起露在树干外面
    let out = mids.findIndex((point) => !inTrunk(point));
    if (out < 0) out = steps;
    const exit = out / steps;
    const shown = length * (1 - exit);
    // 粗细：根上是树干的三成多，但露出来的那一段短的话不能太粗（又短又粗就成了一根刺）；往梢上收细
    const thick = Math.min(16, shown * 0.2, Math.max(4.5, girth(from) * 0.34));
    const halves = mids.map((_, k) => 1.8 + (thick - 1.8) * (1 - k / steps) ** 0.95);
    // 叶柄：细细的一小段，接到叶片上
    mids.push(stalk);
    halves.push(1.3);
    const rim = sides(mids, halves);
    // 往右伸的枝，near 那一排在下面；往左伸的反过来
    const lower = side > 0 ? rim.near : rim.far;
    const upper = side > 0 ? rim.far : rim.near;

    /**
     * 枝杈和树干相接的那个角里补上一块木头，外沿是一道往里凹的弧：枝是从树干上"长"出来的，不是插上去的。
     * @param along 枝的一条边（上边或下边）上依次的点
     * @param down 这条边是下边（角在枝的下方，顺着树干往下补）还是上边（往上补）
     * @param size 这块木头沿着枝、沿着树干各伸出去多远
     */
    const fillet = (along: readonly Point[], down: boolean, size: number): string => {
      const j = along.findIndex((point) => !inTrunk(point));
      if (j < 1) return '';
      // 这条边穿出树干的那一点：在里面的一点和外面的一点之间对半找几次
      let inside = along[j - 1];
      let outside = along[j];
      for (let k = 0; k < 6; k++) {
        const half: Point = [(inside[0] + outside[0]) / 2, (inside[1] + outside[1]) / 2];
        if (inTrunk(half)) inside = half;
        else outside = half;
      }
      // 从那一点沿着枝往外走 size
      let onLimb = outside;
      let left = size;
      for (let k = j; k < along.length && left > 0; k++) {
        const step = Math.hypot(along[k][0] - onLimb[0], along[k][1] - onLimb[1]);
        const take = step > left ? left / step : 1;
        onLimb = [onLimb[0] + (along[k][0] - onLimb[0]) * take, onLimb[1] + (along[k][1] - onLimb[1]) * take];
        left -= step;
      }
      // 从那一点沿着树干的边往下（上）走 size
      const u = Math.min(tip, Math.max(foot, uOf(outside[1] + (down ? size : -size))));
      const onStem = onTrunk(u, side);
      // 弧：从枝上那一点弯到树干上那一点，中间朝着角里凹
      const arc = Array.from({ length: 5 }, (_, k): Point => {
        const t = (k + 1) / 6;
        const s = 1 - t;
        return [s * s * onLimb[0] + 2 * s * t * outside[0] + t * t * onStem[0], s * s * onLimb[1] + 2 * s * t * outside[1] + t * t * onStem[1]];
      });
      return ring([onStem, inside, onLimb, ...arc]);
    };
    const collar = Math.min(24, Math.max(8, thick * 1.6));
    branches.push(limb(mids, halves) + fillet(lower, true, collar) + fillet(upper, false, collar * 0.5));

    // 露在外面的那一段，朝上的一侧受光、朝下的一侧背光：贴着边、在枝里面各画一道
    const inner = sides(mids, halves, 1.2);
    limbLight.push(line((side > 0 ? inner.far : inner.near).slice(out)));
    limbShade.push(line((side > 0 ? inner.near : inner.far).slice(Math.min(steps, out + 1))));

    // 小叶子：长在露出来的那一段上，上面、下面都有；枝够长的话中间再分出一根小杈，靠树干那头再添一片
    const sprigs: Array<{ outline: string; vein: string }> = [];
    const heading = (k: number): number => Math.atan2(mids[k + 1][1] - mids[k - 1][1], mids[k + 1][0] - mids[k - 1][0]);
    const index = (portion: number): number => Math.min(steps - 1, Math.max(out + 1, Math.round((exit + (1 - exit) * portion) * steps)));
    const grow = (portion: number, above: boolean, lean: number, size: number): void => {
      const k = index(portion);
      // 屏幕上往上是 y 变小：往右伸的枝，朝上是逆时针转（角度变小）；往左伸的反过来
      const turn = (above ? -1 : 1) * side * lean;
      const across = heading(k) + Math.sign(turn) * (Math.PI / 2);
      sprigs.push(leaflet(mids[k][0] + Math.cos(across) * halves[k] * 0.7, mids[k][1] + Math.sin(across) * halves[k] * 0.7, heading(k) + turn, size));
    };
    let twig = '';
    if (shown > 66) {
      const k = index(0.36);
      const up = heading(k) - side * (0.8 + 0.3 * chance(i, 6));
      const far = 22 + 12 * chance(i, 7);
      const base = mids[k];
      const to: Point = [base[0] + Math.cos(up) * far, base[1] + Math.sin(up) * far];
      const bend: Point = [base[0] + (Math.cos(heading(k)) * 0.3 + Math.cos(up) * 0.34) * far, base[1] + (Math.sin(heading(k)) * 0.3 + Math.sin(up) * 0.34) * far];
      const run = Array.from({ length: 6 }, (_, q) => curve(base, bend, bend, to, q / 5));
      twig = limb(run, run.map((_, q) => Math.min(halves[k], 2.4) - 1.4 * (q / 5)));
      sprigs.push(leaflet(to[0], to[1], up - side * 0.12, 0.88));
      sprigs.push(leaflet(run[3][0], run[3][1], up + side * 0.9, 0.66));
      grow(0.7, true, 0.9, 0.82);
    } else {
      grow(0.46, true, 0.95, small ? 0.8 : 0.94);
    }
    grow(0.8, false, 0.82, small ? 0.68 : 0.8);
    if (shown > 78) grow(0.16, false, 1.0, 0.72);
    branches[i] += twig;
    leaves.push(sprigs.map((one) => one.outline).join(''));
    veins.push(...sprigs.map((one) => one.vein));
  }

  // ───── 树梢：树尖上分出几根枝，一簇小叶子。关少、树小的时候树梢也小 ─────
  const tipX = centre(tip);
  const tipY = yOf(tip);
  const grown = Math.min(1, 0.45 + count / 22);
  const boughs: string[] = [];
  const tuft: Array<{ outline: string; vein: string }> = [];
  const CROWN: ReadonlyArray<readonly [swing: number, long: number, weight: number]> = [
    [0, 132, 1],
    [-0.5, 104, 0.85],
    [0.5, 104, 0.85],
    [-1.05, 70, 0.62],
    [1.05, 70, 0.62],
  ];
  for (const [swing, long, weight] of CROWN) {
    const angle = -Math.PI / 2 + swing;
    const far = long * grown;
    const from: Point = [tipX, tipY + 14];
    const to: Point = [tipX + Math.cos(angle) * far, tipY + Math.sin(angle) * far];
    // 先往上再往外
    const bend: Point = [from[0] + (to[0] - from[0]) * 0.25, from[1] + (to[1] - from[1]) * 0.62];
    const steps = 10;
    const run = Array.from({ length: steps + 1 }, (_, k) => curve(from, bend, bend, to, k / steps));
    // 正中那一根是树干接着往上长的，根上和树尖一样粗
    boughs.push(limb(run, run.map((_, k) => 1.2 + Math.max(0, tipHalf * weight - 1.2) * (1 - k / steps) ** 1.1)));
    const size = 0.72 + 0.4 * grown;
    tuft.push(leaflet(to[0], to[1], angle, (1.05 + 0.4 * weight) * size));
    // 沿着这根枝左右交替再长几片，越靠梢越大
    const along: ReadonlyArray<readonly [at: number, lean: number, size: number]> = [
      [4, -0.95, 0.95],
      [5, 0.95, 1],
      [7, -0.9, 1.1],
      [8, 0.9, 1.15],
    ];
    for (const [where, lean, big] of far > 50 ? along : along.slice(2)) {
      tuft.push(leaflet(run[where][0], run[where][1], angle + lean, big * size));
    }
  }
  veins.push(...tuft.map((one) => one.vein));

  return {
    width,
    height,
    leaf,
    spots,
    wood: trunk + roots + branches.join('') + boughs.join(''),
    trunk,
    roots,
    branches,
    bark: furrows.join(''),
    shade,
    light,
    limbShade: limbShade.join(''),
    limbLight: limbLight.join(''),
    leaves,
    crown: tuft.map((one) => one.outline).join(''),
    veins: veins.join(''),
  };
}

function svg(tag: string, attrs: Readonly<Record<string, string>>, ...kids: Element[]): Element {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...kids);
  return node;
}

/** 选关树这一屏。只管显示和把点击转告出去；哪一关是什么样子由外面说了算 */
export class Tree {
  private readonly root = document.getElementById('tree') as HTMLElement;
  private readonly board = document.getElementById('tree-board') as HTMLElement;
  private readonly onPick: (index: number) => void;
  private nodes: readonly TreeNode[] = [];
  private layout: TreeLayout | null = null;
  /** 叶片按钮，下标 0 是第 1 关 */
  private knots: HTMLButtonElement[] = [];
  /** nodes 换过了，页面上的还是旧的 */
  private stale = true;
  /** 滚到哪一关在屏幕中间 */
  private focus = 0;

  /** @param onPick 点了第 index 关（从 0 数起）的叶片 */
  constructor(onPick: (index: number) => void) {
    this.onPick = onPick;
    // 亮出来时会把键盘的焦点放到一片叶片上（见 show）。浏览器会给它画一圈键盘焦点的框，
    // 可那一圈看着像是"轮到了"；所以先标着"还没按过键"，这期间不画（见样式表），等真的用上键盘了再画
    this.root.classList.add('unkeyed');
    window.addEventListener('keydown', () => this.root.classList.remove('unkeyed'));
  }

  get shown(): boolean {
    return !this.root.hidden;
  }

  /** 关卡表或者存档变了：换上新的样子。树没亮着的时候只是记下来，等亮出来再画 */
  render(nodes: readonly TreeNode[]): void {
    this.nodes = nodes;
    this.stale = true;
    if (this.shown) this.build();
  }

  /**
   * 亮出来，并滚到第 focus 关（从 0 数起）在屏幕中间。
   * 键盘的焦点也放到那一关的叶片上：焦点在树里面，方向键、翻页键才滚得动这棵树，按回车就进那一关。
   */
  show(focus: number): void {
    this.focus = focus;
    this.root.hidden = false;
    this.build();
    this.centre();
    this.knots[focus]?.focus({ preventScroll: true });
  }

  hide(): void {
    this.root.hidden = true;
  }

  /**
   * 窗口大小变了。木板的宽度跟着变了的话就重排，并且还是让原来那一关在屏幕中间；
   * 只是高度变了（手机浏览器的地址栏一收一放就会这样）什么都不动——玩家滚到哪就留在哪。
   */
  resized(): void {
    if (!this.shown) return;
    const before = this.layout;
    this.build();
    if (this.layout !== before) this.centre();
  }

  private centre(): void {
    const spot = this.layout?.spots[this.focus];
    // 木板上下可能留了边（见样式表），叶片的位置是从木板的上沿量的
    if (spot) this.root.scrollTop = Math.max(0, this.board.offsetTop + spot.y - this.root.clientHeight / 2);
  }

  /** 把树画到页面上。木板的宽度没变、内容也没变就什么都不做 */
  private build(): void {
    // 量的是滚动区里面的宽度：电脑上右边有一条滚动条，要让开
    const width = Math.min(MAX_BOARD, this.root.clientWidth || window.innerWidth);
    if (!this.stale && this.layout?.width === width) return;
    this.stale = false;
    const tree = layoutTree(this.nodes.length, width);
    this.layout = tree;
    const frame = { width: String(tree.width), height: String(tree.height), viewBox: `0 0 ${tree.width} ${tree.height}`, 'aria-hidden': 'true' };

    // 垫在树底下、刻在木板上的那一层。小叶子是刻出来的凹槽：深色的形状，底下垫一份往右下挪了一个像素的浅色，
    // 那是凹槽对面那道受光的边；通过的关，凹槽里填上那一关的染料。最上面是整棵树落在木板上的影子，和它左上受光的那道边
    const passed = (i: number): boolean => this.nodes[i].state === 'done';
    const carved = tree.leaves.filter((_, i) => !passed(i)).join('');
    const dyed = this.nodes.flatMap((node, i) => (passed(i) ? [svg('path', { d: tree.leaves[i], style: `--leaf:${node.dye}` })] : []));
    const under = svg(
      'svg',
      { class: 'tree-art', ...frame },
      svg('path', { class: 'lit', d: tree.leaves.join('') + tree.crown, transform: 'translate(1 1)' }),
      svg('path', { class: 'cut', d: carved + tree.crown }),
      svg('g', { class: 'dyed' }, ...dyed),
      svg('path', { class: 'veins', d: tree.veins }),
      svg('path', { class: 'cast', d: tree.wood, transform: 'translate(3 5)' }),
      svg('path', { class: 'rim', d: tree.wood, transform: 'translate(-1 -1.2)' }),
      // 垫底的一层纯色：正常情况下被上面那块带木纹的木头盖住；浏览器不会按形状裁的时候（那块木头不显示，见样式表）树就是它
      svg('path', { class: 'plain', d: tree.wood }),
    );

    // 树本身：一整块木头，按树干、树根、枝杈的轮廓裁出来（木纹是样式表铺的）
    const wood = document.createElement('div');
    wood.className = 'tree-wood';
    wood.style.clipPath = `path('${tree.wood}')`;

    // 盖在木头上面的那一层：树干背光半边的暗影、受光一侧的亮带、树皮的沟，和枝杈上下两道边
    const over = svg(
      'svg',
      { class: 'tree-art', ...frame },
      svg('path', { class: 'shade', d: tree.shade[0] }),
      svg('path', { class: 'shade', d: tree.shade[1] }),
      svg('path', { class: 'glow', d: tree.light }),
      svg('path', { class: 'bark-lit', d: tree.bark, transform: 'translate(1 0.5)' }),
      svg('path', { class: 'bark', d: tree.bark }),
      svg('path', { class: 'limb-dark', d: tree.limbShade }),
      svg('path', { class: 'limb-light', d: tree.limbLight }),
    );

    const list = document.createElement('ol');
    list.className = 'tree-knots';
    this.knots = this.nodes.map((node, i) => {
      const number = i + 1;
      const spot = tree.spots[i];
      const knot = document.createElement('button');
      knot.type = 'button';
      knot.className = `knot ${node.state}`;
      knot.setAttribute('data-level', String(number));
      knot.style.setProperty('--star', node.dye);
      // 叶片本来是叶尖朝右画的：往右伸的那些逆时针转一点就翘起来了；往左伸的先左右翻过来，再顺时针转
      knot.style.setProperty('--turn', `${n(((spot.side > 0 ? -1 : 1) * spot.tilt * 180) / Math.PI)}deg`);
      if (spot.side < 0) knot.style.setProperty('--flip', '-1');
      if (node.state === 'done') {
        // 通过的关，叶片染上这一关的染料；序号的字是深是浅看染料
        knot.style.setProperty('--tint', tintOf(node.dye));
        knot.setAttribute('data-ink', inkOn(node.dye));
      }
      const shadow = document.createElement('i');
      shadow.className = 'knot-shade';
      const blade = document.createElement('i');
      blade.className = 'knot-leaf';
      const label = document.createElement('span');
      label.className = 'knot-num';
      label.textContent = String(number);
      knot.append(shadow, blade, label);
      if (node.best > 0) {
        const note = document.createElement('span');
        note.className = 'knot-note';
        const small = document.createElement('small');
        small.textContent = `${node.best} 步`;
        note.append(starRow(node.stars), small);
        knot.append(note);
        knot.setAttribute('aria-label', `第 ${number} 关，最好 ${node.best} 步，${node.stars} 颗星`);
      } else {
        knot.setAttribute('aria-label', `第 ${number} 关`);
      }
      knot.disabled = node.state === 'locked';
      knot.addEventListener('click', () => this.onPick(i));
      const item = document.createElement('li');
      item.style.left = `${n(spot.x)}px`;
      item.style.top = `${n(spot.y)}px`;
      item.append(knot);
      list.append(item);
      return knot;
    });

    const { board } = this;
    board.style.width = `${tree.width}px`;
    board.style.height = `${tree.height}px`;
    board.style.setProperty('--ll', `${tree.leaf.long}px`);
    board.style.setProperty('--lh', `${tree.leaf.half}px`);
    board.style.setProperty('--leaf-clip', `path('${leafOutline(tree.leaf.long, tree.leaf.half)}')`);
    board.style.setProperty('--leaf-veins', `url("data:image/svg+xml,${encodeURIComponent(leafEngraving(tree.leaf.long, tree.leaf.half))}")`);
    board.replaceChildren(under, wood, over, list);
  }
}
