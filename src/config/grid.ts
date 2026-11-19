// 中间那只托盘，还有左栏的缩略图：照游戏里的样子，从正上方看着画。
// 游戏里的托盘是一整块胡桃木，地面是在上面铣出来的浅槽，槽底是桦木。所以画布只画地面，
// 墙的位置空着不画，让垫在画布底下的那块木头（样式表里的 .tray）透上来——墙和托盘边就是同一块木头。
// 画布正好盖住全部格子、不留边，格子一样大：第 r 行第 c 列的中心在 ((c + 0.5) / 列数, (r + 0.5) / 行数) 的位置上。
import type { Change } from '../solve/repair.ts';

/** 画布上要圈出来的格子 */
export interface Marks {
  /** 检查查出问题的格子：实线的红圈，挨在一起的圈成一圈 */
  readonly faults: readonly number[];
  /** 修改建议要改的格子：虚线的圈，圈里画着这一格会变成什么 */
  readonly changes: readonly Change[];
}

const BIRCH = '#dcc08f';
const WALNUT = '#6a4328';
const RING = '#d2362b';
const HALO = 'rgba(255, 244, 224, 0.92)';
const DARK = 'rgba(26, 12, 4, 0.82)';

/** 一格最大画多大（CSS 像素）：再小的图也不至于撑满整个屏幕 */
const CELL_MOST = 84;
/** 托盘边的宽度（CSS 像素）：跟着格子变，但不出这个范围 */
const RIM_LEAST = 14;
const RIM_MOST = 30;
/** 缩略图的边长（CSS 像素） */
const THUMB = 48;

/** 从 a 格到 b 格的直线上依次经过的格子，不含 a、含 b。鼠标拖得快的时候靠它把中间漏掉的格子补上 */
function between(a: number, b: number, cols: number): number[] {
  let r = Math.floor(a / cols);
  let c = a % cols;
  const r1 = Math.floor(b / cols);
  const c1 = b % cols;
  const dr = Math.abs(r1 - r);
  const dc = Math.abs(c1 - c);
  const stepR = r < r1 ? 1 : -1;
  const stepC = c < c1 ? 1 : -1;
  let lean = dc - dr;
  const out: number[] = [];
  while (r !== r1 || c !== c1) {
    const twice = lean * 2;
    if (twice > -dr) {
      lean -= dr;
      c += stepC;
    }
    if (twice < dc) {
      lean += dc;
      r += stepR;
    }
    out.push(r * cols + c);
  }
  return out;
}

/** 一颗玻璃弹珠：中心 (x, y)、半径 size。先是落在木头上的影子，再是透亮的球身和两处高光 */
function marble(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const shade = ctx.createRadialGradient(x + size * 0.2, y + size * 0.28, size * 0.2, x + size * 0.2, y + size * 0.28, size * 1.16);
  shade.addColorStop(0, 'rgba(24, 10, 2, 0.55)');
  shade.addColorStop(1, 'rgba(24, 10, 2, 0)');
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(x + size * 0.2, y + size * 0.28, size * 1.16, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(x - size * 0.32, y - size * 0.36, size * 0.04, x, y, size);
  body.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
  body.addColorStop(0.2, 'rgba(255, 255, 255, 0.66)');
  body.addColorStop(0.58, 'rgba(232, 244, 240, 0.3)');
  body.addColorStop(0.86, 'rgba(206, 222, 216, 0.34)');
  body.addColorStop(1, 'rgba(110, 126, 122, 0.66)');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.07);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.stroke();

  // 光穿过玻璃，在右下方的球身里聚成一小块亮斑
  const glint = ctx.createRadialGradient(x + size * 0.36, y + size * 0.42, 0, x + size * 0.36, y + size * 0.42, size * 0.36);
  glint.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
  glint.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glint;
  ctx.beginPath();
  ctx.arc(x + size * 0.36, y + size * 0.42, size * 0.36, 0, Math.PI * 2);
  ctx.fill();
}

/** 圆角方框的路径：左上角 (x, y)，边长 side */
function box(ctx: CanvasRenderingContext2D, x: number, y: number, side: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, side, side, radius);
}

/**
 * 把一组格子圈起来的路径：挨在一起的格子圈成一圈，不是一格一个圈（二十几格连成一片时，一格一圈太乱）。
 * 线走在这组格子里面、离外沿 inset 远的地方。一格的边长是 u。
 */
function contour(ctx: CanvasRenderingContext2D, cells: ReadonlySet<number>, cols: number, u: number, inset: number): void {
  const has = (r: number, c: number): boolean => r >= 0 && c >= 0 && c < cols && cells.has(r * cols + c);
  // 一条边画到哪为止，看它那一头的拐角：往外拐（旁边那格不在圈里）就收进来 inset；
  // 一直往前（旁边那格在、斜对面那格不在）正好画到格子边，和旁边那格的同一条边接上；往里拐（都在）要多伸出去 inset
  const reach = (beside: boolean, diagonal: boolean): number => (!beside ? inset : diagonal ? -inset : 0);
  ctx.beginPath();
  for (const cell of cells) {
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    const left = c * u;
    const top = r * u;
    const right = left + u;
    const bottom = top + u;
    if (!has(r - 1, c)) {
      ctx.moveTo(left + reach(has(r, c - 1), has(r - 1, c - 1)), top + inset);
      ctx.lineTo(right - reach(has(r, c + 1), has(r - 1, c + 1)), top + inset);
    }
    if (!has(r + 1, c)) {
      ctx.moveTo(left + reach(has(r, c - 1), has(r + 1, c - 1)), bottom - inset);
      ctx.lineTo(right - reach(has(r, c + 1), has(r + 1, c + 1)), bottom - inset);
    }
    if (!has(r, c - 1)) {
      ctx.moveTo(left + inset, top + reach(has(r - 1, c), has(r - 1, c - 1)));
      ctx.lineTo(left + inset, bottom - reach(has(r + 1, c), has(r + 1, c - 1)));
    }
    if (!has(r, c + 1)) {
      ctx.moveTo(right - inset, top + reach(has(r - 1, c), has(r - 1, c + 1)));
      ctx.lineTo(right - inset, bottom - reach(has(r + 1, c), has(r + 1, c + 1)));
    }
  }
}

export class Grid {
  private readonly canvas = document.getElementById('grid') as HTMLCanvasElement;
  private readonly tray = this.canvas.parentElement as HTMLElement;
  /** 留给托盘的那块地方 */
  private readonly room = this.tray.parentElement as HTMLElement;
  private readonly ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
  private rows: readonly string[] = [];
  private dye = '#000000';
  private marks: Marks = { faults: [], changes: [] };
  /** 一格的边长，单位是屏幕上真实的像素（不是 CSS 像素）：取整数，格子的边才不发虚 */
  private unit = 0;
  /** 一个 CSS 像素合几个真实的像素 */
  private ratio = 1;
  /** 桦木的纹理；样式表里那张图还没读好的时候是 null，先只涂底色 */
  private grain: CanvasPattern | null = null;
  /** 这一笔上一次画到哪一格；没在画是 -1 */
  private last = -1;
  /** 这一笔中途划到托盘外面去了 */
  private away = false;

  /**
   * @param onStroke 鼠标按在、或者按住拖到了第 cell 格上。first 表示是不是这一笔刚按下去的那一格
   */
  constructor(onStroke: (cell: number, first: boolean) => void) {
    const { canvas } = this;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const cell = this.cellAt(event);
      if (cell < 0) return;
      try {
        // 拖出画布再拖回来，这一笔还接着算
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // 不是真的鼠标（程序造出来的事件）抓不住，不要紧
      }
      this.last = cell;
      this.away = false;
      onStroke(cell, true);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this.last < 0) return;
      // 键已经松开了却没收到"抬起"（比如中途切走了窗口）：这一笔就到此为止，不能让鼠标空着划过去也在画
      if (event.buttons === 0) {
        this.last = -1;
        return;
      }
      const cell = this.cellAt(event);
      if (cell < 0) {
        // 划到托盘外面去了。这一笔还没完，但回来时要从回来的那一格重新起头
        this.away = true;
        return;
      }
      if (cell === this.last && !this.away) return;
      const cols = this.rows[0].length;
      // 鼠标动得快，两次之间可能跳过几格，中间的要补上。两种情况不补：
      // 从托盘外面绕回来的——中间那一段根本没在托盘上划过，补上就把不相干的格子涂掉了（改图没有撤销）；
      // 图的大小在这一笔中间变了的（不该发生）
      const path = !this.away && this.last < this.rows.length * cols ? between(this.last, cell, cols) : [cell];
      this.away = false;
      this.last = cell;
      for (const step of path) onStroke(step, false);
    });
    const lift = (): void => {
      this.last = -1;
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('lostpointercapture', lift);
    this.loadGrain();
  }

  /** 画这张图。dye 是染料颜色（#rrggbb） */
  show(rows: readonly string[], dye: string, marks: Marks): void {
    // 量地方要让浏览器把页面重新排一遍，所以只在图的行列数变了的时候量；每涂一格都量就太费了
    const resized = rows.length !== this.rows.length || rows[0].length !== this.rows[0]?.length;
    this.rows = rows;
    this.dye = dye;
    this.marks = marks;
    if (resized) this.fit();
    this.draw();
  }

  /** 窗口大小变了：格子的大小跟着重新定 */
  resized(): void {
    if (this.rows.length === 0) return;
    this.fit();
    this.draw();
  }

  /** 鼠标在哪一格上；不在图里是 -1 */
  private cellAt(event: PointerEvent): number {
    const count = this.rows.length;
    const cols = this.rows[0]?.length ?? 0;
    const rect = this.canvas.getBoundingClientRect();
    if (count === 0 || rect.width === 0 || rect.height === 0) return -1;
    const c = Math.floor(((event.clientX - rect.left) / rect.width) * cols);
    const r = Math.floor(((event.clientY - rect.top) / rect.height) * count);
    return r >= 0 && r < count && c >= 0 && c < cols ? r * cols + c : -1;
  }

  /** 桦木的纹理和页面上别处用的是同一张图：从样式表里取出来（--grain-birch），读好了再重画一遍 */
  private loadGrain(): void {
    const probe = document.createElement('i');
    probe.style.backgroundImage = 'var(--grain-birch)';
    document.body.append(probe);
    const found = /^url\("(.+)"\)$/s.exec(getComputedStyle(probe).backgroundImage);
    probe.remove();
    if (!found) return;
    const image = new Image();
    image.onload = () => {
      this.grain = this.ctx.createPattern(image, 'repeat');
      if (this.rows.length > 0) this.draw();
    };
    image.src = found[1].replace(/\\(.)/g, '$1');
  }

  /** 量一量留给托盘的地方，定下一格画多大、托盘边多宽，并把画布调成正好盖住所有格子 */
  private fit(): void {
    const count = this.rows.length;
    const cols = this.rows[0].length;
    const style = getComputedStyle(this.room);
    const width = this.room.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = this.room.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const ratio = window.devicePixelRatio || 1;
    const cell = Math.min((width - 2 * RIM_MOST) / cols, (height - 2 * RIM_MOST) / count, CELL_MOST);
    const unit = Math.max(4, Math.floor(cell * ratio));
    const rim = Math.round(Math.min(RIM_MOST, Math.max(RIM_LEAST, (unit / ratio) * 0.4)));

    const { canvas } = this;
    this.unit = unit;
    this.ratio = ratio;
    // 改画布的大小会把画的东西清掉，所以没变就不去碰
    if (canvas.width !== cols * unit || canvas.height !== count * unit) {
      canvas.width = cols * unit;
      canvas.height = count * unit;
    }
    canvas.style.width = `${(cols * unit) / ratio}px`;
    canvas.style.height = `${(count * unit) / ratio}px`;
    canvas.setAttribute('data-rows', String(count));
    canvas.setAttribute('data-cols', String(cols));
    this.tray.style.setProperty('--rim', `${rim}px`);
  }

  private draw(): void {
    const { ctx, rows, unit: u, ratio } = this;
    const count = rows.length;
    const cols = rows[0].length;
    const floor = (r: number, c: number): boolean => r >= 0 && r < count && c >= 0 && c < cols && rows[r][c] !== '#';
    /** 一条细线有多粗 */
    const hair = Math.max(1, Math.round(ratio));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cols * u, count * u);

    // 地面：桦木
    ctx.fillStyle = BIRCH;
    for (let r = 0; r < count; r++) for (let c = 0; c < cols; c++) if (floor(r, c)) ctx.fillRect(c * u, r * u, u, u);
    if (this.grain) {
      this.grain.setTransform(new DOMMatrix().scale(ratio));
      ctx.fillStyle = this.grain;
      for (let r = 0; r < count; r++) for (let c = 0; c < cols; c++) if (floor(r, c)) ctx.fillRect(c * u, r * u, u, u);
    }

    // 起点那一格开局就染着色
    let start = -1;
    for (let r = 0; r < count && start < 0; r++) {
      const c = rows[r].indexOf('S');
      if (c >= 0) start = r * cols + c;
    }
    if (start >= 0) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = this.dye;
      ctx.fillRect((start % cols) * u, Math.floor(start / cols) * u, u, u);
      ctx.globalAlpha = 1;
    }

    for (let r = 0; r < count; r++) {
      for (let c = 0; c < cols; c++) {
        if (!floor(r, c)) continue;
        const x = c * u;
        const y = r * u;
        // 格子之间的细线
        ctx.fillStyle = 'rgba(70, 40, 14, 0.2)';
        if (floor(r, c + 1)) ctx.fillRect(x + u - hair, y, hair, u);
        if (floor(r + 1, c)) ctx.fillRect(x, y + u - hair, u, hair);
        // 地面比墙低一截，光从左上方来：上边、左边挨着墙的地方落着墙的影子
        if (!floor(r - 1, c)) {
          const shade = ctx.createLinearGradient(0, y, 0, y + u * 0.34);
          shade.addColorStop(0, 'rgba(26, 12, 4, 0.6)');
          shade.addColorStop(0.35, 'rgba(26, 12, 4, 0.26)');
          shade.addColorStop(1, 'rgba(26, 12, 4, 0)');
          ctx.fillStyle = shade;
          ctx.fillRect(x, y, u, u * 0.34);
        }
        if (!floor(r, c - 1)) {
          const shade = ctx.createLinearGradient(x, 0, x + u * 0.2, 0);
          shade.addColorStop(0, 'rgba(26, 12, 4, 0.46)');
          shade.addColorStop(0.4, 'rgba(26, 12, 4, 0.18)');
          shade.addColorStop(1, 'rgba(26, 12, 4, 0)');
          ctx.fillStyle = shade;
          ctx.fillRect(x, y, u * 0.2, u);
        }
        // 下边、右边挨着的墙，朝这边的那个面受着光：一道亮边
        ctx.fillStyle = 'rgba(255, 240, 210, 0.42)';
        if (!floor(r + 1, c)) ctx.fillRect(x, y + u - hair, u, hair);
        if (!floor(r, c + 1)) ctx.fillRect(x + u - hair, y, hair, u);
      }
    }

    if (start >= 0) marble(ctx, ((start % cols) + 0.5) * u, (Math.floor(start / cols) + 0.5) * u, u * 0.33);

    // 圈：实线的红圈是检查查出问题的格子
    const line = Math.max(2 * ratio, u * 0.05);
    const edge = line * 0.5 + hair;
    const faulty = new Set(this.marks.faults);
    if (faulty.size > 0) {
      contour(ctx, faulty, cols, u, edge);
      ctx.lineCap = 'round';
      // 红线两边各衬一道浅色：墙是深色的木头，光是红线看不清
      ctx.lineWidth = line + 2 * hair;
      ctx.strokeStyle = HALO;
      ctx.stroke();
      ctx.lineWidth = line;
      ctx.strokeStyle = RING;
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // 虚线的圈是修改建议要改的格子，圈里画着这一格会变成什么：一小块墙、一小块地面，或者弹珠
    for (const { cell, to } of this.marks.changes) {
      const x = (cell % cols) * u;
      const y = Math.floor(cell / cols) * u;
      // 这一格同时被红圈圈着的话，虚线圈画在红圈里面
      const inset = edge + (faulty.has(cell) ? line + 2 * hair : 0);
      box(ctx, x + inset, y + inset, u - inset * 2, u * 0.1);
      ctx.lineWidth = line + 2 * hair;
      ctx.strokeStyle = DARK;
      ctx.stroke();
      ctx.setLineDash([u * 0.2, u * 0.13]);
      ctx.lineWidth = line;
      ctx.strokeStyle = '#fff3da';
      ctx.stroke();
      ctx.setLineDash([]);

      const side = u * 0.4;
      const left = x + (u - side) / 2;
      const top = y + (u - side) / 2;
      box(ctx, left, top, side, u * 0.05);
      ctx.fillStyle = to === '#' ? WALNUT : to === '.' ? BIRCH : this.dye;
      ctx.fill();
      ctx.lineWidth = hair;
      ctx.strokeStyle = DARK;
      ctx.stroke();
      if (to === '#') {
        // 墙比地面高：顶上一道受光的边
        ctx.fillStyle = 'rgba(255, 232, 196, 0.4)';
        ctx.fillRect(left + hair, top + hair, side - 2 * hair, hair);
      } else if (to === 'S') {
        marble(ctx, x + u / 2, y + u / 2, side * 0.36);
      }
    }
  }
}

/** 在一块小画布上画一关的缩略图：一只小托盘，开局时的样子（地面是桦木，起点那一格染着这一关的染料） */
export function drawThumb(canvas: HTMLCanvasElement, rows: readonly string[], dye: string): void {
  const ratio = window.devicePixelRatio || 1;
  const size = Math.round(THUMB * ratio);
  if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);

  const count = rows.length;
  const cols = rows[0].length;
  const rim = Math.max(1, Math.round(2.5 * ratio));
  const u = (size - 2 * rim) / Math.max(count, cols);
  const left = Math.round((size - u * cols) / 2);
  const top = Math.round((size - u * count) / 2);
  // 格子不一定是整数个像素宽：边都取整，相邻的格子共用一条边，中间才不露缝
  const xAt = (c: number): number => left + Math.round(c * u);
  const yAt = (r: number): number => top + Math.round(r * u);

  ctx.fillStyle = '#432a19';
  ctx.beginPath();
  ctx.roundRect(left - rim, top - rim, xAt(cols) - left + 2 * rim, yAt(count) - top + 2 * rim, 3 * ratio);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 232, 196, 0.16)';
  ctx.fillRect(left, top - rim, xAt(cols) - left, Math.max(1, Math.round(ratio)));

  for (let r = 0; r < count; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = rows[r][c];
      if (ch === '#') continue;
      ctx.fillStyle = ch === 'S' ? dye : BIRCH;
      ctx.fillRect(xAt(c), yAt(r), xAt(c + 1) - xAt(c), yAt(r + 1) - yAt(r));
    }
  }
}
