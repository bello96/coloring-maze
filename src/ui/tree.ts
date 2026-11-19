// 选关树：关里点「选关」看到的那一屏。一块很长的胡桃木板上刻着一棵树，树干从底下的树根弯弯曲曲往上，
// 左右交替伸出枝杈，每个枝头嵌一块圆木片就是一关。通过的关，枝头的叶子会填上那一关的染料——树是一关一关被"染"出来的。
// 用的是普通的网页元素加一张 SVG，上下滚动交给浏览器，手机上手感最好。
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

/** 一关的木片放在哪 */
export interface Spot {
  readonly x: number;
  readonly y: number;
  /** 枝杈朝哪边伸：-1 左，1 右 */
  readonly side: -1 | 1;
}

/** 一棵排好的树。长度单位都是像素，路径都是 SVG 的写法 */
export interface TreeLayout {
  readonly width: number;
  readonly height: number;
  /** 木片的半径 */
  readonly radius: number;
  /** 每一关的木片中心，下标 0 是第 1 关（最靠下） */
  readonly spots: readonly Spot[];
  /** 树干：一个下粗上细的长条 */
  readonly trunk: string;
  /** 树根：几条线 */
  readonly roots: string;
  /** 树梢上的几片叶子 */
  readonly crown: string;
  /** 每一关的枝杈：一条线，从树干伸到木片底下 */
  readonly branches: readonly string[];
  /** 每一关枝头的几片叶子 */
  readonly leaves: readonly string[];
  /** 所有叶子的叶脉：细线 */
  readonly veins: string;
}

/** 木板最宽多少像素。手机上铺满屏幕宽度；电脑上是居中的一长条 */
export const MAX_BOARD = 560;
/** 相邻两关上下相隔多少 */
const STEP = 84;
/** 最后一关上面留给树梢的、第 1 关下面留给树根的地方 */
const TOP = 170;
const BOTTOM = 190;

const SVG = 'http://www.w3.org/2000/svg';
const n = (v: number): string => String(Math.round(v * 10) / 10);

/**
 * 一片叶子的轮廓和叶脉：叶柄在 (x, y)，朝 angle（弧度）的方向长出去。
 * 轮廓是两段对称的弧线，中间最宽。
 */
function leaf(x: number, y: number, angle: number, size: number): { outline: string; vein: string } {
  const long = 24 * size;
  const half = 6.4 * size;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (along: number, across: number): string => `${n(x + along * cos - across * sin)} ${n(y + along * sin + across * cos)}`;
  return {
    outline: `M${at(0, 0)}C${at(long * 0.3, -half)} ${at(long * 0.76, -half)} ${at(long, 0)}C${at(long * 0.76, half)} ${at(long * 0.3, half)} ${at(0, 0)}Z`,
    vein: `M${at(long * 0.14, 0)}L${at(long * 0.84, 0)}`,
  };
}

/**
 * count 关、木板宽 width 像素时，这棵树怎么排。只是算位置，不碰页面。
 * 同样的关数和宽度，排出来的永远是同一棵树。
 */
export function layoutTree(count: number, width: number): TreeLayout {
  const radius = width >= 480 ? 34 : 30;
  const mid = width / 2;
  /** 木片的中心离木板的中线多远 */
  const reach = Math.min(150, width * 0.27);
  const height = TOP + Math.max(0, count - 1) * STEP + BOTTOM;
  /** 第 u 关在多高的地方（u 可以带小数；0 是第 1 关，在最下面） */
  const yOf = (u: number): number => height - BOTTOM - u * STEP;
  /** 树干在那个高度往左右偏了多少：两道快慢不同的弯叠在一起，看着不像是尺子画的 */
  const sway = Math.min(30, width * 0.055);
  const trunkX = (u: number): number => mid + sway * (0.62 * Math.sin(u * 1.05 + 0.4) + 0.38 * Math.sin(u * 2.3 + 2));

  // 树干：从第 1 关下面一点长到最后一关上面一点，下粗上细，贴近树根的地方再粗一些
  const foot = -0.9;
  const tip = Math.max(0, count - 1) + 0.95;
  const samples = Math.max(2, Math.ceil((tip - foot) * 6));
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const k = i / samples;
    const u = foot + (tip - foot) * k;
    const half = 1.2 + 3.2 * (1 - k) ** 0.4 + 5 * (1 - k) ** 1.6 + 5 * Math.exp(-(u - foot) * 3);
    left.push(`${n(trunkX(u) - half)} ${n(yOf(u))}`);
    right.push(`${n(trunkX(u) + half)} ${n(yOf(u))}`);
  }
  const trunk = `M${left.join('L')}L${right.reverse().join('L')}Z`;

  // 树根：从树干底下往三个方向扎下去
  const fx = trunkX(foot);
  const fy = yOf(foot);
  const roots =
    `M${n(fx - 4)} ${n(fy - 10)}Q${n(fx - 20)} ${n(fy + 20)} ${n(fx - 60)} ${n(fy + 30)}` +
    `M${n(fx + 4)} ${n(fy - 10)}Q${n(fx + 18)} ${n(fy + 22)} ${n(fx + 54)} ${n(fy + 36)}` +
    `M${n(fx)} ${n(fy - 6)}Q${n(fx + 5)} ${n(fy + 24)} ${n(fx - 10)} ${n(fy + 46)}`;

  const spots: Spot[] = [];
  const branches: string[] = [];
  const leaves: string[] = [];
  const veins: string[] = [];
  for (let i = 0; i < count; i++) {
    const side: -1 | 1 = i % 2 === 0 ? -1 : 1;
    const spot: Spot = { x: mid + side * reach, y: yOf(i), side };
    spots.push(spot);

    // 枝杈：从木片下方一点的树干上斜着长出来，到木片跟前放平
    const from = i - 0.4;
    const x0 = trunkX(from);
    const y0 = yOf(from);
    const x2 = spot.x - side * radius * 0.5;
    const cx = x0 + (x2 - x0) * 0.5;
    const cy = spot.y + 5;
    branches.push(`M${n(x0)} ${n(y0)}Q${n(cx)} ${n(cy)} ${n(x2)} ${n(spot.y)}`);

    // 叶子：木片朝外的那一侧两片，一片斜向上、一片稍稍朝下；枝杈中间的下方再垂一小片
    const out = side > 0 ? 0 : Math.PI;
    const up = -side * 0.66;
    const down = side * 0.26;
    const mx = 0.25 * x0 + 0.5 * cx + 0.25 * x2;
    const my = 0.25 * y0 + 0.5 * cy + 0.25 * spot.y;
    const three = [
      leaf(spot.x + Math.cos(out + up) * (radius + 5), spot.y + Math.sin(out + up) * (radius + 5), out + up, 1),
      leaf(spot.x + Math.cos(out + down) * (radius + 6), spot.y + Math.sin(out + down) * (radius + 6), out + down, 0.82),
      leaf(mx, my + 2, side > 0 ? 0.95 : Math.PI - 0.95, 0.72),
    ];
    leaves.push(three.map((one) => one.outline).join(''));
    veins.push(...three.map((one) => one.vein));
  }

  // 树梢：三片叶子，中间一片大一些
  const tx = trunkX(tip);
  const ty = yOf(tip);
  const top = [leaf(tx, ty + 2, -Math.PI / 2, 1.3), leaf(tx - 1, ty + 8, -Math.PI / 2 - 0.8, 1.05), leaf(tx + 1, ty + 8, -Math.PI / 2 + 0.8, 1.05)];
  veins.push(...top.map((one) => one.vein));

  return {
    width,
    height,
    radius,
    spots,
    trunk,
    roots,
    crown: top.map((one) => one.outline).join(''),
    branches,
    leaves,
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
  /** 木片按钮，下标 0 是第 1 关 */
  private knots: HTMLButtonElement[] = [];
  /** nodes 换过了，页面上的还是旧的 */
  private stale = true;
  /** 滚到哪一关在屏幕中间 */
  private focus = 0;

  /** @param onPick 点了第 index 关（从 0 数起）的木片 */
  constructor(onPick: (index: number) => void) {
    this.onPick = onPick;
    // 亮出来时会把键盘的焦点放到一块木片上（见 show）。浏览器会给它画一圈键盘焦点的框，
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
   * 键盘的焦点也放到那一关的木片上：焦点在树里面，方向键、翻页键才滚得动这棵树，按回车就进那一关。
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
    // 木板上下可能留了边（见样式表），木片的位置是从木板的上沿量的
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

    // 刻出来的凹槽：深色的形状，底下垫一份往右下挪了一个像素的浅色，那是凹槽对面那道受光的边
    const carved = this.nodes.flatMap((node, i) => (node.state === 'done' ? [] : [tree.leaves[i]])).join('');
    const shapes = (leavesToo: boolean): Element[] => [
      svg('path', { class: 'solid', d: tree.trunk }),
      svg('path', { class: 'line root', d: tree.roots }),
      svg('path', { class: 'line', d: tree.branches.join('') }),
      svg('path', { class: 'solid', d: (leavesToo ? tree.leaves.join('') : carved) + tree.crown }),
    ];
    // 通过的关，叶子填上那一关的染料
    const dyed = this.nodes.flatMap((node, i) => (node.state === 'done' ? [svg('path', { d: tree.leaves[i], style: `--leaf:${node.dye}` })] : []));
    const art = svg(
      'svg',
      { class: 'tree-art', width: String(tree.width), height: String(tree.height), viewBox: `0 0 ${tree.width} ${tree.height}`, 'aria-hidden': 'true' },
      svg('g', { class: 'lit', transform: 'translate(1 1)' }, ...shapes(true)),
      svg('g', { class: 'cut' }, ...shapes(false)),
      svg('g', { class: 'dyed' }, ...dyed),
      svg('path', { class: 'veins', d: tree.veins }),
    );

    const list = document.createElement('ol');
    list.className = 'tree-knots';
    this.knots = this.nodes.map((node, i) => {
      const number = i + 1;
      const knot = document.createElement('button');
      knot.type = 'button';
      knot.className = `knot ${node.state}`;
      knot.setAttribute('data-level', String(number));
      knot.style.setProperty('--star', node.dye);
      const disc = document.createElement('span');
      disc.className = 'knot-disc';
      disc.textContent = String(number);
      knot.append(disc);
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
      item.style.left = `${tree.spots[i].x}px`;
      item.style.top = `${tree.spots[i].y}px`;
      item.append(knot);
      list.append(item);
      return knot;
    });

    this.board.style.width = `${tree.width}px`;
    this.board.style.height = `${tree.height}px`;
    this.board.style.setProperty('--r', `${tree.radius}px`);
    this.board.replaceChildren(art, list);
  }
}
