// 关卡配置页（线上的地址是 /config）。
// 左边是关卡列表，中间是正在改的那一关的托盘，右边是这一关的设置、检查的结果和发布按钮。
// 这个文件管"现在是什么情况"和"点了之后怎么办"，别的各有各的文件：
//   画托盘和缩略图 grid.ts；关卡列表 list.ts；口令弹层 gate.ts；和服务端打交道 api.ts；
//   草稿和各种改动 model.ts；检查、以及查到的情况该怎么说 check.ts；后台线程 checker.ts、worker.ts。
import './config.css';
import { parseLevel } from '../game/level.ts';
import { BUILTIN, DYES, LIMITS, type LevelEntry, type LevelSet } from '../game/levelset.ts';
import { shortfall } from '../game/solver.ts';
import { applyChanges } from '../solve/repair.ts';
import { fetchLevels, publishLevels, verifyToken } from './api.ts';
import { adviceText, precheck, publishNote, reportOf, type Report } from './check.ts';
import { Checker, type CheckState, type WorkerLike } from './checker.ts';
import { Gate } from './gate.ts';
import { Grid } from './grid.ts';
import { brushForKey, type Brush } from './keys.ts';
import { LevelList } from './list.ts';
import { draftsOf, maxSide, moved, moveStart, newDraft, paint, resize, setOf, withRows, type Draft } from './model.ts';
import { recentlyPublished, rememberPublished, type Store } from './published.ts';

const BRUSHES: readonly Brush[] = ['wall', 'floor', 'start'];

/** 八种染料的名字，顺序和 DYES 一样。页面上不显示，是给读屏软件念的 */
const DYE_NAMES: readonly string[] = ['靛蓝', '茜红', '松绿', '藤黄', '紫', '叶绿', '玫红', '湖蓝'];

const PUBLISHED = '已发布，玩家刷新页面后生效（全球同步最长约一分钟）';
const SEARCHING = '正在找修改建议…';

type Early = ReturnType<typeof precheck>;

/** 发布要用的口令 */
interface Session {
  token(): string;
  /** 口令不管用了：重新要一个。要到了才算完 */
  renew(): Promise<void>;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 浏览器的存储。localStorage 这几个字要到真用的时候才碰：有的环境里一碰就抛异常（用到的地方都接着） */
const store: Store = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};

const setText = (node: HTMLElement, text: string): void => {
  if (node.textContent !== text) node.textContent = text;
};

/** 起一个后台线程。Vite 靠这一行的写法认出 worker.ts 是线程的入口，单独打一个包（求解库只在那个包里） */
function spawn(): WorkerLike {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const like: WorkerLike = {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    onmessage: null,
    onerror: null,
  };
  worker.onmessage = (event) => like.onmessage?.(event);
  worker.onerror = (event) => like.onerror?.(event);
  return like;
}

class Editor {
  /** 正在编辑的全部关卡，按顺序 */
  private drafts: Draft[];
  /** 上次发布的那一份（刚打开时是读到的那一份）。拿它判断有没有没发布的修改；图改回原样时，也从它这里找回原来的最少步数 */
  private published: LevelSet;
  private entries: ReadonlyMap<string, LevelEntry>;
  /** 正在改的那一关 */
  private current: string;
  /** "开放全部关卡"那个开关现在是不是开着。它管的是整份关卡表，和关卡一样发布了才生效 */
  private openAll: boolean;
  private brush: Brush = 'wall';
  /** 后台线程查每一关现在这张图查到哪了。图一变，旧的就作废 */
  private readonly checks = new Map<string, CheckState>();
  /** 便宜的那两步的结论、"保证不会走进死局"，都按图记着：图是不改的，改了就是另一个数组 */
  private readonly earlies = new WeakMap<readonly string[], { readonly early: Early }>();
  private readonly safes = new WeakMap<readonly string[], boolean>();
  /** 上一次发布的结果，写在发布按钮下面；一有改动就清掉 */
  private said: { readonly text: string; readonly failed: boolean } | null = null;
  /** 发布的请求发出去了，还没回来 */
  private sending = false;
  /** 大于 0 时先不刷新页面：一口气改好几样，改完再统一刷新一次 */
  private holding = 0;

  private readonly session: Session;
  private readonly checker: Checker;
  private readonly grid: Grid;
  private readonly list: LevelList;

  private readonly title = el('level-title');
  private readonly sizeRows = el<HTMLInputElement>('size-rows');
  private readonly sizeCols = el<HTMLInputElement>('size-cols');
  private readonly dyeButtons: HTMLButtonElement[];
  private readonly dyeOwn = el<HTMLInputElement>('dye-custom');
  private readonly checkLines = [...el('checks').children] as HTMLElement[];
  private readonly advice = el('advice');
  private readonly adviceLine = el('advice-text');
  private readonly apply = el<HTMLButtonElement>('btn-apply');
  private readonly parNumber = el('par-number');
  private readonly publishButton = el<HTMLButtonElement>('btn-publish');
  private readonly note = el('publish-note');
  private readonly addButton = el<HTMLButtonElement>('btn-add');
  private readonly deleteButton = el<HTMLButtonElement>('btn-delete');
  private readonly openSwitch = el<HTMLButtonElement>('switch-open-all');

  /**
   * @param set 要编辑的关卡表：线上现在的那一份；线上还没发布过就是内置的 80 关
   */
  constructor(set: LevelSet, session: Session) {
    this.drafts = draftsOf(set);
    this.published = set;
    this.entries = new Map(set.levels.map((entry) => [entry.id, entry]));
    this.current = this.drafts[0].id;
    this.openAll = set.openAll === true;
    this.session = session;
    this.checker = new Checker(spawn, (id, state) => this.checked(id, state));
    this.list = new LevelList({ select: (id) => this.select(id), move: (from, to) => this.move(from, to) });
    this.grid = new Grid((cell, first) => this.stroke(cell, first));

    // 八种现成的染料，排在"自选"前面
    this.dyeButtons = DYES.map((dye, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-dye', dye);
      button.setAttribute('aria-label', DYE_NAMES[i]);
      button.style.setProperty('--swatch', dye);
      button.addEventListener('click', () => this.setDye(dye));
      return button;
    });
    el('dyes').prepend(...this.dyeButtons);
    // 取色框开着、还在挑的时候就跟着变；有的浏览器只在关上时报一次，所以两种都听
    for (const type of ['input', 'change']) this.dyeOwn.addEventListener(type, () => this.setDye(this.dyeOwn.value));

    for (const brush of BRUSHES) {
      el(`brush-${brush}`).addEventListener('click', () => {
        this.brush = brush;
        this.render();
      });
    }
    // 画笔的快捷键：W 墙、F 地面、S 起点。正在输入框里打字、口令弹层开着（这时页面是点不动的）都不管
    window.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      const brush = brushForKey(event, typing || el('bench').inert);
      if (!brush) return;
      event.preventDefault();
      if (brush === this.brush) return;
      this.brush = brush;
      this.render();
    });
    this.sizeRows.addEventListener('change', () => this.resizeBy(this.sizeRows, 0));
    this.sizeCols.addEventListener('change', () => this.resizeBy(this.sizeCols, 1));
    this.addButton.addEventListener('click', () => this.add());
    this.deleteButton.addEventListener('click', () => this.remove());
    this.apply.addEventListener('click', () => this.takeAdvice());
    this.publishButton.addEventListener('click', () => void this.publish());
    this.openSwitch.addEventListener('click', () => {
      this.batch(() => {
        this.openAll = !this.openAll;
        this.said = null;
      });
    });

    window.addEventListener('resize', () => {
      this.grid.resized();
      // 页面缩放也算窗口大小变了：缩略图要按新的清晰度重画
      this.render();
    });
    // 有没发布的修改时关页面、刷新、点「返回游戏」：让浏览器问一句"确定离开吗"。整个页面只有这一处确认
    window.addEventListener('beforeunload', (event) => {
      if (!this.dirty()) return;
      event.preventDefault();
      // 老一些的浏览器要设了这个才问
      event.returnValue = true;
    });

    this.batch(() => this.wantAdvice());
  }

  /** 给自动化检查看的：现在正在编辑的是什么 */
  snapshot(): unknown {
    return {
      current: this.current,
      dirty: this.dirty(),
      openAll: this.openAll,
      levels: this.drafts.map((draft) => ({ ...draft, standing: this.reportFor(draft).standing })),
    };
  }

  private indexOf(id: string): number {
    return this.drafts.findIndex((draft) => draft.id === id);
  }

  private now(): Draft {
    return this.drafts[this.indexOf(this.current)];
  }

  /** 改动放在 change 里做，做完统一刷新一次页面（中间后台线程报来的进展不会各刷一次） */
  private batch(change: () => void): void {
    this.holding++;
    try {
      change();
    } finally {
      this.holding--;
    }
    this.render();
  }

  // ───── 检查 ─────

  private earlyOf(rows: readonly string[]): Early {
    let kept = this.earlies.get(rows);
    if (!kept) {
      kept = { early: precheck(rows) };
      this.earlies.set(rows, kept);
    }
    return kept.early;
  }

  /** 这张图是不是保证不会走进死局。只对便宜的那两步都过了的图有意义 */
  private safeOf(rows: readonly string[]): boolean {
    let safe = this.safes.get(rows);
    if (safe === undefined) {
      safe = shortfall(parseLevel(rows)) === 0;
      this.safes.set(rows, safe);
    }
    return safe;
  }

  private reportFor(draft: Draft): Report {
    // 最少步数已经有了的关（没动过的，或者刚算出来的），图一定没毛病：便宜的那两步、会不会走进死局，
    // 只在正看着这一关的时候才现查一遍给人看，不必一打开就把上百关都查一遍
    const known = draft.par !== null;
    const watching = draft.id === this.current;
    const early = known && !watching ? null : this.earlyOf(draft.rows);
    return reportOf({
      early,
      par: draft.par,
      // 最少步数还在算的时候也查：不保证不会走进死局的图，修改建议比最少步数先到，页面得知道该不该等它
      safe: watching && !early ? this.safeOf(draft.rows) : true,
      state: this.checks.get(draft.id),
    });
  }

  /** 后台线程报来了某一关的进展 */
  private checked(id: string, state: CheckState): void {
    const at = this.indexOf(id);
    if (at < 0) return;
    this.checks.set(id, state);
    const draft = this.drafts[at];
    // 只有等着最少步数的关（图改过的）才填。没动过的关沿用关卡表里原来的最少步数和走法——
    // 去问线程只是为了要一条修改建议，它另算出来的走法不拿来换
    if (state.verdict?.kind === 'ok' && draft.par === null) {
      this.drafts[at] = { ...draft, par: state.verdict.par, solution: state.verdict.solution };
    }
    this.render();
  }

  /**
   * 正看着的这一关最少步数是现成的，却不保证不会走进死局：请后台线程找一条修改建议
   * （它会把最少步数重算一遍，那个结果不用）。问过了就不再问
   */
  private wantAdvice(): void {
    const draft = this.now();
    if (draft.par === null || this.checks.has(draft.id) || this.safeOf(draft.rows)) return;
    this.checker.request(draft.id, draft.rows);
  }

  // ───── 各种改动 ─────

  /** 正在改的这一关，图换成 rows */
  private setRows(rows: readonly string[]): void {
    const at = this.indexOf(this.current);
    const draft = this.drafts[at];
    if (rows === draft.rows || rows.join('/') === draft.rows.join('/')) return;
    this.batch(() => {
      const next = withRows(draft, rows, this.entries.get(draft.id));
      this.drafts[at] = next;
      this.said = null;
      this.checks.delete(next.id);
      if (next.par === null) {
        this.checker.request(next.id, next.rows);
        // 正在改的就是正看着的这一关：别的关排着队的话，让它先算
        this.checker.prefer(next.id);
      } else {
        // 改回了和上次发布时一模一样：最少步数是现成的，正在算的、排着队的都不用算了
        this.checker.forget(next.id);
        this.wantAdvice();
      }
    });
  }

  /** 鼠标在托盘的第 cell 格上按下，或者按住拖到了这一格 */
  private stroke(cell: number, first: boolean): void {
    const { rows } = this.now();
    if (this.brush === 'start') {
      // 起点是点一下放一次，不跟着拖
      if (first) this.setRows(moveStart(rows, cell));
    } else {
      this.setRows(paint(rows, cell, this.brush === 'wall' ? '#' : '.'));
    }
  }

  /** 大小的某一个数字框改完了。side：0 是行，1 是列 */
  private resizeBy(input: HTMLInputElement, side: 0 | 1): void {
    const draft = this.now();
    const size: [number, number] = [draft.rows.length, draft.rows[0].length];
    const typed = input.value.trim() === '' ? NaN : Math.round(Number(input.value));
    if (Number.isFinite(typed)) size[side] = Math.min(maxSide(size[1 - side]), Math.max(LIMITS.minSide, typed));
    // 不管输的是什么，框里都写回实际的大小：输 3 写回 5，输的不是数字就写回原来的
    input.value = String(size[side]);
    if (size[0] !== draft.rows.length || size[1] !== draft.rows[0].length) this.setRows(resize(draft.rows, size[0], size[1]));
  }

  /** 换染料。染料和图没关系，不用重查 */
  private setDye(dye: string): void {
    const at = this.indexOf(this.current);
    if (this.drafts[at].dye === dye) return;
    this.batch(() => {
      this.drafts[at] = { ...this.drafts[at], dye };
      this.said = null;
    });
  }

  private takeAdvice(): void {
    const draft = this.now();
    const { advice } = this.reportFor(draft);
    if (advice.kind === 'found') this.setRows(applyChanges(draft.rows, advice.repair.changes));
  }

  private select(id: string): void {
    if (id === this.current || this.indexOf(id) < 0) return;
    this.batch(() => {
      this.current = id;
      this.wantAdvice();
      // 正看着的这一关要是还排着队，让它先算
      this.checker.prefer(id);
    });
  }

  private add(): void {
    if (this.drafts.length >= LIMITS.maxLevels) return;
    const draft = newDraft(this.drafts);
    this.batch(() => {
      this.drafts.push(draft);
      this.current = draft.id;
      this.said = null;
      this.checker.request(draft.id, draft.rows);
      this.checker.prefer(draft.id);
    });
    this.list.reveal(draft.id);
  }

  /** 删掉正在改的这一关（至少留一关），接着改它后面那一关；它是最后一关的话，改前面那一关 */
  private remove(): void {
    if (this.drafts.length <= 1) return;
    const at = this.indexOf(this.current);
    this.batch(() => {
      const [gone] = this.drafts.splice(at, 1);
      this.checker.forget(gone.id);
      this.checks.delete(gone.id);
      this.current = this.drafts[Math.min(at, this.drafts.length - 1)].id;
      this.said = null;
      this.wantAdvice();
      this.checker.prefer(this.current);
    });
    this.list.reveal(this.current);
  }

  private move(from: number, to: number): void {
    this.batch(() => {
      this.drafts = moved(this.drafts, from, to);
      this.said = null;
    });
  }

  // ───── 发布 ─────

  /** 有没有还没发布的修改：关卡的增删、顺序、图、染料，还有"开放全部关卡"那个开关，和上次发布的那一份有任何不同 */
  private dirty(): boolean {
    if (this.openAll !== (this.published.openAll === true)) return true;
    const was = this.published.levels;
    if (was.length !== this.drafts.length) return true;
    return this.drafts.some((draft, i) => draft.id !== was[i].id || draft.dye !== was[i].dye || draft.rows.join('/') !== was[i].rows.join('/'));
  }

  private async publish(): Promise<void> {
    // 有一关还没算出最少步数（在算，或者被拦下了）就拼不成关卡表
    const set = setOf(this.drafts, this.openAll);
    if (!set || this.sending) return;
    this.sending = true;
    this.render();
    const outcome = await publishLevels(this.session.token(), set);
    this.sending = false;

    if (outcome.kind === 'denied') {
      this.render();
      // 口令不管用了：重新要一个。要到了就接着把这一次发出去——人已经点过「发布」了，
      // 输完口令却什么都没发生的话，很容易以为已经发布了
      await this.session.renew();
      return this.publish();
    }
    let culprit: string | undefined;
    this.batch(() => {
      if (outcome.kind === 'ok') {
        // 记在浏览器里：接下来一两分钟服务端可能还在回旧的那份，这期间刷新页面以这一份为准（见 published.ts）
        rememberPublished(store, set, Date.now());
        this.published = set;
        this.entries = new Map(set.levels.map((entry) => [entry.id, entry]));
        this.said = { text: PUBLISHED, failed: false };
      } else if (outcome.kind === 'invalid') {
        this.said = { text: outcome.level > 0 ? `第 ${outcome.level} 关：${outcome.detail}` : outcome.detail, failed: true };
        // 服务端说的"第几关"是按发出去的那一份数的；这期间顺序可能又变了，所以按编号找
        culprit = set.levels[outcome.level - 1]?.id;
        if (culprit !== undefined && culprit !== this.current && this.indexOf(culprit) >= 0) {
          this.current = culprit;
          this.wantAdvice();
          this.checker.prefer(culprit);
        }
      } else {
        this.said = { text: `发布失败（${outcome.status ?? '连不上服务器'}），请稍后再试`, failed: true };
      }
    });
    if (culprit !== undefined) this.list.reveal(culprit);
  }

  // ───── 把现在的情况显示出来 ─────

  private render(): void {
    if (this.holding > 0) return;
    const at = this.indexOf(this.current);
    const draft = this.drafts[at];
    const report = this.reportFor(draft);
    const standings = this.drafts.map((other) => (other === draft ? report : this.reportFor(other)).standing);

    this.list.render(
      this.drafts.map((other, i) => ({ id: other.id, rows: other.rows, dye: other.dye, par: other.par, bad: standings[i] === 'blocked' })),
      draft.id,
    );
    this.addButton.disabled = this.drafts.length >= LIMITS.maxLevels;
    this.deleteButton.disabled = this.drafts.length <= 1;
    if (this.openSwitch.getAttribute('aria-checked') !== String(this.openAll)) this.openSwitch.setAttribute('aria-checked', String(this.openAll));

    this.grid.show(draft.rows, draft.dye, {
      faults: this.earlyOf(draft.rows)?.cells ?? [],
      changes: report.advice.kind === 'found' ? report.advice.repair.changes : [],
    });

    setText(this.title, `第 ${at + 1} 关`);
    this.showSize(this.sizeRows, draft.rows.length, draft.rows[0].length);
    this.showSize(this.sizeCols, draft.rows[0].length, draft.rows.length);
    for (const brush of BRUSHES) el(`brush-${brush}`).setAttribute('aria-pressed', String(brush === this.brush));

    for (const button of this.dyeButtons) button.setAttribute('aria-pressed', String(button.getAttribute('data-dye') === draft.dye));
    const own = !DYES.includes(draft.dye);
    const ownLabel = this.dyeOwn.parentElement as HTMLElement;
    if (own && this.dyeOwn.value !== draft.dye) this.dyeOwn.value = draft.dye;
    ownLabel.classList.toggle('on', own);
    ownLabel.style.setProperty('--own', draft.dye);

    report.lines.forEach((line, i) => {
      const item = this.checkLines[i];
      // 没变就不去碰：正在算的那一格上有个一明一暗的弹珠，碰了会从头闪起
      if (item.className !== (line.mark ?? '')) item.className = line.mark ?? '';
      setText(item, line.text);
    });
    const { advice } = report;
    let hint = '';
    if (advice.kind === 'searching') hint = SEARCHING;
    else if (advice.kind === 'found') hint = `建议：${adviceText(advice.repair.changes)}`;
    setText(this.adviceLine, hint);
    this.advice.hidden = hint === '';
    this.apply.hidden = advice.kind !== 'found';
    setText(this.parNumber, draft.par === null ? '—' : String(draft.par));
    this.parNumber.classList.toggle('unknown', draft.par === null);

    // 还不能发布的时候，说的是哪一关拦着；能发布的时候，留着上一次发布的结果
    const held = publishNote(standings);
    this.publishButton.disabled = held !== '' || this.sending;
    setText(this.note, held || this.said?.text || '');
    this.note.className = held || !this.said ? '' : this.said.failed ? 'failed' : 'said';
  }

  /** 把大小写进数字框。other 是另一边现在的格数，这一边最多能有多少格由它定 */
  private showSize(input: HTMLInputElement, value: number, other: number): void {
    input.max = String(maxSide(other));
    const text = String(value);
    // 正在往框里输数字的时候不去动它（后台线程报进展也会刷新页面）；大小真变了、或者没在输，才写回去
    if (input.getAttribute('data-shown') !== text || document.activeElement !== input) input.value = text;
    input.setAttribute('data-shown', text);
  }
}

async function boot(): Promise<void> {
  const gate = new Gate(verifyToken);
  let token = await gate.enter();
  const fetched = await fetchLevels();
  if (fetched.kind === 'broken') {
    // 这时不退回内置的关卡：拿它们发布，会把线上的盖掉
    el('notice').hidden = false;
    return;
  }
  // 这个浏览器刚发布过的话（两分钟之内），以那一份为准：服务端这时回的可能还是上一版，甚至是"还没发布过"，
  // 照着它显示，再点一次发布就把刚发的盖掉了
  const online = fetched.kind === 'set' ? fetched.set : BUILTIN;
  const set = recentlyPublished(store, Date.now()) ?? online;
  const bench = el('bench');
  // 先亮出来再搭：托盘画多大要量页面上留给它的地方
  bench.hidden = false;
  const editor = new Editor(set, {
    token: () => token,
    async renew() {
      // 口令弹层开着的时候，底下的页面点不动
      bench.inert = true;
      token = await gate.again();
      bench.inert = false;
    },
  });
  // 给自动化检查留的口子：在控制台里输入 __config() 能看到正在编辑的关卡
  Object.assign(window, { __config: () => editor.snapshot() });
}

void boot();
