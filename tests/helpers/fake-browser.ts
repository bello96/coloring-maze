// 假的浏览器环境：只实现游戏用到的那一点点 DOM，外加一只可以手动拨的钟和手动出帧的 requestAnimationFrame。
// 用它可以在 Node 里把真正的 App 和 GameView 跑起来（只有碰 WebGL 的 Stage 换成替身），
// 一帧一帧地推进，检查"乱按一气"之后状态对不对。
import { vi } from 'vitest';

type Listener = (event: never) => void;

export class FakeEl {
  readonly tagName: string;
  id: string;
  hidden = false;
  disabled = false;
  textContent = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly listeners: Record<string, Listener[]> = {};
  readonly attrs: Record<string, string> = {};
  className = '';
  type = '';
  width = 0;
  height = 0;
  readonly style = { setProperty(): void {} };
  readonly classList = { add: (name: string): void => void (this.className += ` ${name}`) };
  private readonly browser: FakeBrowser;

  constructor(browser: FakeBrowser, tag: string, id = '') {
    this.browser = browser;
    this.tagName = tag.toUpperCase();
    this.id = id;
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  setAttribute(key: string, value: unknown): void {
    this.attrs[key] = String(value);
  }
  getAttribute(key: string): string | null {
    return this.attrs[key] ?? null;
  }
  append(...kids: Array<FakeEl | string>): void {
    for (const kid of kids) {
      if (typeof kid === 'string') {
        this.textContent += kid;
      } else {
        this.children.push(kid);
        kid.parent = this;
      }
    }
  }
  replaceChildren(...kids: Array<FakeEl | string>): void {
    this.children = [];
    this.append(...kids);
  }
  querySelector(selector: string): FakeEl | null {
    if (selector !== '[aria-current]') throw new Error(`假 DOM 不认识这个选择器：${selector}`);
    const walk = (el: FakeEl): FakeEl | null => {
      for (const kid of el.children) {
        if (kid.attrs['aria-current'] !== undefined) return kid;
        const deep = walk(kid);
        if (deep) return deep;
      }
      return null;
    };
    return walk(this);
  }
  /** 只用于 '.chip, .tile' 这样的类名列表 */
  closest(selector: string): FakeEl | null {
    const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
    for (let el: FakeEl | null = this; el; el = el.parent) {
      if (wanted.some((name) => ` ${el!.className} `.includes(` ${name} `))) return el;
    }
    return null;
  }
  focus(): void {
    this.browser.document.activeElement = this;
  }
  getContext(): unknown {
    return canvasContext;
  }
  toDataURL(): string {
    return 'data:,';
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((kid) => kid !== this);
    this.parent = null;
  }

  // 排版位置：照着竖屏时样式表排出来的样子给
  get offsetLeft(): number {
    if (this.id === 'guide') return 12;
    return this.id === 'result' ? (this.browser.width - 340) / 2 : 0;
  }
  get offsetWidth(): number {
    if (this.id === 'guide') return 236;
    return this.id === 'result' ? 340 : this.browser.width;
  }
  get offsetTop(): number {
    if (this.id === 'tally') return 14;
    if (this.id === 'tools') return this.browser.height - 61;
    if (this.id === 'result') return this.browser.height - 220;
    if (this.id === 'guide') return this.browser.height - 78 - 124;
    return 0;
  }
  get offsetHeight(): number {
    if (this.id === 'guide') return 124;
    return this.id === 'tally' ? 72 : 41;
  }
}

/** 画布的 2D 上下文：什么都能调，什么都不做 */
const canvasContext: unknown = new Proxy<Record<string | symbol, unknown>>(
  {},
  {
    get(target, key) {
      if (key === 'measureText') return () => ({ width: 10 });
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  },
);

const INITIALLY_HIDDEN = new Set(['tally', 'tools', 'guide', 'result', 'levels']);
const CHIPS = new Set(['btn-undo', 'btn-restart', 'btn-levels', 'btn-sound', 'btn-again', 'btn-next', 'btn-close-levels']);
const KEY_NAMES = { U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight' } as const;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class FakeBrowser {
  /** 现在几点（毫秒），只有 frame() 会让它往前走 */
  clock = 1000;
  width = 390;
  height = 844;
  /** 排着等下一帧的回调 */
  queued: Array<(now: number) => void> = [];
  /** 每一帧里跑了多少个回调 */
  readonly perFrame: number[] = [];
  readonly storage = new Map<string, string>();
  hidden = false;
  private readonly byId = new Map<string, FakeEl>();
  private readonly windowListeners: Record<string, Listener[]> = {};
  private readonly documentListeners: Record<string, Listener[]> = {};
  readonly document: {
    activeElement: FakeEl | null;
    documentElement: FakeEl;
    body: FakeEl;
    hidden: boolean;
    getElementById(id: string): FakeEl;
    createElement(tag: string): FakeEl;
    createElementNS(ns: string, tag: string): FakeEl;
    addEventListener(type: string, fn: Listener): void;
  };

  constructor() {
    const browser = this;
    this.document = {
      activeElement: null,
      documentElement: new FakeEl(this, 'html'),
      body: new FakeEl(this, 'body'),
      get hidden() {
        return browser.hidden;
      },
      getElementById: (id) => this.el(id),
      createElement: (tag) => new FakeEl(this, tag),
      createElementNS: (_ns, tag) => new FakeEl(this, tag),
      addEventListener: (type, fn) => void (this.documentListeners[type] ??= []).push(fn),
    };
  }

  /** 把这个假浏览器装成全局的 window、document 等。测试结束时用 vi.unstubAllGlobals() 和 vi.restoreAllMocks() 收拾。 */
  install(): void {
    vi.stubGlobal('document', this.document);
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('Element', FakeEl);
    vi.stubGlobal('addEventListener', (type: string, fn: Listener) => void (this.windowListeners[type] ??= []).push(fn));
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => this.queued.push(cb));
    vi.stubGlobal('devicePixelRatio', 3);
    vi.stubGlobal('location', { reload: () => {} });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => this.storage.get(key) ?? null,
      setItem: (key: string, value: string) => void this.storage.set(key, String(value)),
    });
    Object.defineProperty(globalThis, 'innerWidth', { get: () => this.width, configurable: true });
    Object.defineProperty(globalThis, 'innerHeight', { get: () => this.height, configurable: true });
    vi.spyOn(performance, 'now').mockImplementation(() => this.clock);
  }

  /** 页面上带这个 id 的元素（第一次问到时现造一个） */
  el(id: string): FakeEl {
    let el = this.byId.get(id);
    if (!el) {
      el = new FakeEl(this, id.startsWith('btn-') ? 'button' : 'div', id);
      if (INITIALLY_HIDDEN.has(id)) el.hidden = true;
      if (CHIPS.has(id)) el.className = 'chip';
      this.byId.set(id, el);
    }
    return el;
  }

  /** 出一帧：钟往前拨 ms 毫秒，把排着的回调都跑掉，再让所有承诺的后续跑完 */
  async frame(ms = 1000 / 60): Promise<void> {
    this.clock += ms;
    const callbacks = this.queued;
    this.queued = [];
    this.perFrame.push(callbacks.length);
    for (const cb of callbacks) cb(this.clock);
    await flush();
  }

  async seconds(s: number): Promise<void> {
    for (let i = 0; i < Math.ceil(s * 60); i++) await this.frame();
  }

  /** 按一下方向键 */
  async key(dir: keyof typeof KEY_NAMES): Promise<void> {
    const event = { key: KEY_NAMES[dir], repeat: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault() {}, target: this.document.body };
    for (const fn of this.windowListeners.keydown ?? []) fn(event as never);
    await flush();
  }

  /** 点一下：先是 window 上的监听（解锁声音），再是元素自己的，最后冒泡到 document。按钮灰着就点不动。 */
  async click(target: FakeEl | string): Promise<boolean> {
    const el = typeof target === 'string' ? this.el(target) : target;
    if (el.disabled || el.hidden) return false;
    const event = { target: el };
    for (const fn of this.windowListeners.click ?? []) fn(event as never);
    for (const fn of el.listeners.click ?? []) fn(event as never);
    for (const fn of this.documentListeners.click ?? []) fn(event as never);
    await flush();
    return true;
  }

  /** 用手指在画面上往一个方向滑一下 */
  async swipe(dir: keyof typeof KEY_NAMES): Promise<void> {
    const canvas = this.el('stage');
    const [dx, dy] = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] }[dir];
    const fire = (type: string, event: object): void => {
      for (const fn of canvas.listeners[type] ?? []) fn(event as never);
    };
    fire('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 100 });
    fire('pointermove', { pointerId: 7, clientX: 100 + dx * 10, clientY: 100 + dy * 10 });
    fire('pointermove', { pointerId: 7, clientX: 100 + dx * 40, clientY: 100 + dy * 40 });
    fire('pointerup', { pointerId: 7 });
    await flush();
  }

  /** 窗口大小变了 */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (const fn of this.windowListeners.resize ?? []) fn({} as never);
  }

  /** 切到别的标签页（或切回来） */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const fn of this.documentListeners.visibilitychange ?? []) fn({} as never);
  }

  /** 选关面板里的那些木片 */
  tiles(): FakeEl[] {
    return this.el('levels-grid').children.map((item) => item.children[0]);
  }
}
