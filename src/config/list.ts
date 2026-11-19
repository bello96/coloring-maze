// 左栏的关卡列表：每关一行，有缩略图、排第几、最少步数。点一行切到那一关；按住一行拖到另一行上，换顺序。
// 只管显示和把点击、拖动转告出去；有哪些关、哪一关不能发布，由外面说了算。
import { drawThumb } from './grid.ts';

/** 列表里的一行 */
export interface Row {
  readonly id: string;
  readonly rows: readonly string[];
  readonly dye: string;
  /** 最少步数；还不知道是 null */
  readonly par: number | null;
  /** 这一关现在发布不了：标红 */
  readonly bad: boolean;
}

export interface ListHandlers {
  /** 点了这一关 */
  select(id: string): void;
  /** 把排在第 from 位的那一关拖到了第 to 位（都从 0 数起） */
  move(from: number, to: number): void;
}

/** 页面上的一行，以及它上面现在画的是哪张图（图和染料没变就不重画缩略图） */
interface Item {
  readonly li: HTMLLIElement;
  readonly thumb: HTMLCanvasElement;
  readonly no: HTMLElement;
  readonly steps: HTMLElement;
  rows: readonly string[] | null;
  dye: string;
}

const setText = (node: HTMLElement, text: string): void => {
  if (node.textContent !== text) node.textContent = text;
};

export class LevelList {
  private readonly root = document.getElementById('level-list') as HTMLElement;
  private readonly count = document.getElementById('level-count') as HTMLElement;
  private readonly items = new Map<string, Item>();
  private readonly handlers: ListHandlers;
  /** 现在的顺序 */
  private order: string[] = [];
  /** 缩略图是按一个 CSS 像素合几个真实像素画的；页面缩放之后这个数变了，要全部重画才不发虚 */
  private ratio = 0;
  /** 正被拖着的那一关 */
  private dragged: string | null = null;

  constructor(handlers: ListHandlers) {
    this.handlers = handlers;
    const { root } = this;
    root.addEventListener('click', (event) => {
      const id = this.idAt(event);
      if (id !== null) handlers.select(id);
    });
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const id = this.idAt(event);
      if (id === null) return;
      event.preventDefault();
      handlers.select(id);
    });

    root.addEventListener('dragstart', (event) => {
      const id = this.idAt(event);
      if (id === null || !event.dataTransfer) return;
      this.dragged = id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      this.items.get(id)?.li.classList.add('dragging');
    });
    // 拖到一行上面时：告诉浏览器这里能放（不拦下来它就当不能放），并亮出要落下去的地方。
    // dragenter 和 dragover 都要拦：刚拖进一行（或者这一行里的另一个小块）还没再动就松手的话，浏览器只看 dragenter 拦没拦
    const hover = (event: DragEvent): void => {
      const to = this.targetOf(event);
      if (to < 0) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.point(to);
    };
    root.addEventListener('dragenter', hover);
    root.addEventListener('dragover', hover);
    root.addEventListener('dragleave', (event) => {
      // 拖出了整个列表才收起那道线；在行与行之间挪动不算
      if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) this.point(-1);
    });
    root.addEventListener('drop', (event) => {
      const to = this.targetOf(event);
      if (to < 0) return;
      event.preventDefault();
      const from = this.order.indexOf(this.dragged ?? '');
      this.settle();
      if (from !== to) this.handlers.move(from, to);
    });
    root.addEventListener('dragend', () => this.settle());
  }

  /** 照这些关重新显示。current 是正在改的那一关 */
  render(rows: readonly Row[], current: string): void {
    const order = rows.map((row) => row.id);
    for (const id of this.order) {
      if (order.includes(id)) continue;
      this.items.get(id)?.li.remove();
      this.items.delete(id);
    }
    const ratio = window.devicePixelRatio || 1;
    if (ratio !== this.ratio) {
      for (const item of this.items.values()) item.rows = null;
      this.ratio = ratio;
    }

    rows.forEach((row, i) => {
      const item = this.items.get(row.id) ?? this.make(row.id);
      setText(item.no, String(i + 1));
      setText(item.steps, row.par === null ? '…' : `${row.par} 步`);
      item.li.classList.toggle('current', row.id === current);
      item.li.classList.toggle('bad', row.bad);
      if (row.id === current) item.li.setAttribute('aria-current', 'true');
      else item.li.removeAttribute('aria-current');
      if (item.rows !== row.rows || item.dye !== row.dye) {
        drawThumb(item.thumb, row.rows, row.dye);
        item.rows = row.rows;
        item.dye = row.dye;
      }
    });

    // 只挪位置不对的那几行（新增的、拖过的）：整个列表拆了重装的话，滚到一半的位置会跳回顶上
    order.forEach((id, i) => {
      const li = (this.items.get(id) as Item).li;
      if (this.root.children[i] !== li) this.root.insertBefore(li, this.root.children[i] ?? null);
    });
    this.order = order;
    setText(this.count, String(rows.length));
  }

  /** 把这一关滚到看得见的地方 */
  reveal(id: string): void {
    this.items.get(id)?.li.scrollIntoView({ block: 'nearest' });
  }

  private make(id: string): Item {
    const li = document.createElement('li');
    li.setAttribute('data-id', id);
    li.draggable = true;
    li.tabIndex = 0;
    const thumb = document.createElement('canvas');
    const no = document.createElement('span');
    no.className = 'level-no';
    const steps = document.createElement('span');
    steps.className = 'level-steps';
    li.append(thumb, no, steps);
    const item: Item = { li, thumb, no, steps, rows: null, dye: '' };
    this.items.set(id, item);
    return item;
  }

  /** 这个事件落在哪一关的那一行上；不在任何一行上是 null */
  private idAt(event: Event): string | null {
    const li = event.target instanceof Element ? event.target.closest('li[data-id]') : null;
    return li && this.root.contains(li) ? li.getAttribute('data-id') : null;
  }

  /**
   * 现在松手的话，被拖的那一关会排到第几位（从 0 数起）：拖到哪一行上，就占哪一行的位置；
   * 拖到最后一行下面的空白处，就排到最后。没在拖列表里的关时是 -1
   */
  private targetOf(event: DragEvent): number {
    if (this.dragged === null || !this.items.has(this.dragged)) return -1;
    const id = this.idAt(event);
    return id === null ? this.order.length - 1 : this.order.indexOf(id);
  }

  /** 在要落下去的地方亮一道线：往下拖是落在那一行的下面，往上拖是落在它上面。to 是 -1 就把线收起来 */
  private point(to: number): void {
    const from = this.order.indexOf(this.dragged ?? '');
    this.order.forEach((id, i) => {
      const li = (this.items.get(id) as Item).li;
      li.classList.toggle('drop-above', i === to && to < from);
      li.classList.toggle('drop-below', i === to && to > from);
    });
  }

  /** 这一次拖动结束了（放下了，或者中途作罢） */
  private settle(): void {
    this.point(-1);
    if (this.dragged !== null) this.items.get(this.dragged)?.li.classList.remove('dragging');
    this.dragged = null;
  }
}
