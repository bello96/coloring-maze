import { Sound } from './audio/sound.ts';
import { parseLevel, transposeDef, type Dir, type Level, type LevelDef } from './game/level.ts';
import { BUILTIN, dyeNumber, type LevelEntry, type LevelSet } from './game/levelset.ts';
import {
  advanced,
  bestOf,
  keysOf,
  landing,
  LEVEL_KEY,
  loadProgress,
  mergeProgress,
  OLD_SAVE_KEY,
  reachedFrom,
  readReached,
  record,
  SAVE_KEY,
  stateOf,
  writeProgress,
  type LevelKey,
  type Progress,
} from './game/progress.ts';
import { levelOfPath, pathOfLevel } from './game/route.ts';
import { isDone, newGame, roll, steps, undo, type Game } from './game/rules.ts';
import { starsFor } from './game/stars.ts';
import { showBroken } from './ui/broken.ts';
import { Guide } from './ui/guide.ts';
import { Hud, type ResultInfo } from './ui/hud.ts';
import { listen } from './ui/input.ts';
import { Tree, type TreeNode } from './ui/tree.ts';
import { GameView } from './view/view.ts';

/** 弹珠还在滚的时候，最多先记下这么多次操作，等它停了接着做 */
const QUEUE_LIMIT = 2;

type Action = { readonly kind: 'roll'; readonly dir: Dir } | { readonly kind: 'undo' } | { readonly kind: 'restart' };

/** 一次通关：是在第几次换屏里通的，通关面板上要写什么 */
interface Win {
  readonly screen: number;
  readonly result: ResultInfo;
}

/** 把规则、画面、界面、声音、地址、存档串在一起 */
export class App {
  private readonly sound = new Sound();
  private readonly view: GameView;
  private readonly hud: Hud;
  private readonly tree: Tree;
  private readonly guide: Guide;
  /** 按关记的成绩（最好步数），选关树上的星星和通关面板上的"最好"看它 */
  private progress: Progress;
  /**
   * 玩到第几关（从 1 数起）：它前面的关都算通过了，它自己是轮到的那一关。哪些关能进、打开网站进哪一关只看它。
   * 0 是没玩过。它单独存一项（见 progress.ts 的 LEVEL_KEY），存着的那份随时可能被另一个标签页、或者被人手改掉，
   * 所以每次要拿它拿主意之前先读一遍（见 sync）。
   */
  private reached = 0;
  /** 关卡表：启动时拿到的那一份（线上发布的，或者内置的 80 关），见 start */
  private levels: readonly LevelEntry[] = BUILTIN.levels;
  /** 每一关在存档里的编号和指纹，顺序和 levels 一样 */
  private keys: readonly LevelKey[] = keysOf(BUILTIN);
  /** 现在在第几关（在选关树上时是刚才那一关），从 0 数起；地址栏里写的就是它。还没 start 是 -1 */
  private index = -1;
  /** 现在这一关，按摆在屏幕上的朝向（长方形的关卡可能是翻过来摆的，见 facing） */
  private def: LevelDef = BUILTIN.levels[0];
  private level: Level = parseLevel(BUILTIN.levels[0].rows);
  private game: Game = newGame(this.level);
  /**
   * tree 是在选关树上，其余三种是在一关里。只有 playing 的时候接受操作：
   * entering 是托盘正在换、弹珠还没落下，done 是已经通关。
   */
  private phase: 'tree' | 'entering' | 'playing' | 'done' = 'tree';
  /** 第几次换屏：进一关、回一次树各算一次。动画演完之后的后续凭它知道自己还作不作数 */
  private screen = 0;
  private queue: Action[] = [];
  private pumping = false;
  /** 托盘还在换的时候点了「选关」：先记着，等它摆好了再回树 */
  private wantsOut = false;
  /** 托盘还在换的时候按了浏览器的后退、前进：先记着要去第几关（从 0 数起），等它摆好了再换 */
  private wantsLevel: number | null = null;

  constructor(canvas: HTMLCanvasElement, font: string) {
    this.progress = loadProgress(read(SAVE_KEY), read(OLD_SAVE_KEY));
    this.sound.setMuted(this.progress.muted);
    // 回到选关树之后，没演完的动画还会在树底下接着演（见 GameView.cover）；那时它弄出来的动静不该再出声
    const heard = (): boolean => this.phase !== 'tree';
    this.view = new GameView(canvas, font, {
      impact: (strength) => void (heard() && this.sound.impact(strength)),
      land: (strength) => void (heard() && this.sound.land(strength)),
      rolling: (speed) => this.sound.rolling(heard() ? speed : 0),
      slide: () => void (heard() && this.sound.slide()),
    });
    this.hud = new Hud({
      undo: () => this.act({ kind: 'undo' }),
      restart: () => this.act({ kind: 'restart' }),
      levels: () => this.leave(),
      toggleSound: () => this.toggleSound(),
      next: () => {
        if (this.phase === 'done' && this.index + 1 < this.levels.length) void this.open(this.index + 1, true);
      },
      again: () => void this.again(),
    });
    this.tree = new Tree((index) => this.pick(index));
    this.guide = new Guide();
    this.hud.setSound(!this.progress.muted);
    listen(canvas, (dir) => {
      // 在选关树上，方向键留给浏览器去滚动那棵树
      if (this.phase === 'tree') return false;
      this.act({ kind: 'roll', dir });
      return true;
    });

    // 浏览器要等到第一次点击或按键才允许出声（iPhone 上要等手指抬起来才算数，所以几种事件都听）
    const unlock = (): void => this.sound.unlock();
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
      window.addEventListener(type, unlock, true);
    }
    document.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('.chip, .knot')) this.sound.tap();
    });
    window.addEventListener('resize', () => {
      // 在树上时 3D 的画面没亮着，不用动它：进关的时候会按那时的窗口重新取景
      if (this.phase === 'tree') this.tree.resized();
      else this.relayout(false);
    });
    // 浏览器的后退、前进：地址已经换了，画面跟过去
    window.addEventListener('popstate', () => this.routed());
    // 切到别的标签页时画面会停住；要是弹珠正滚到一半，滚动的沙沙声不能跟着一直响下去
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.sound.rolling(0);
    });
  }

  /**
   * 木纹、字体、关卡表都备好之后调用：直接摆上该进的那一关。地址栏里写着第几关（/12）、玩家又玩到了那里，就是那一关；
   * 别的情况——网站的根地址、还没轮到的关、不是一关的地址——都是轮到的那一关，地址栏跟着改过来。
   * 第一次来的人进第 1 关，上面盖着新手指引。
   * @param set 这次用哪份关卡表
   */
  start(set: LevelSet): void {
    this.levels = set.levels;
    this.keys = keysOf(set);
    this.hud.setWood(this.view.woodUrls());
    this.sync();
    if (this.reached === 0) {
      // 还没有"玩到第几关"这个数的老玩家：按他通过的关算一个出来，记下
      this.reached = reachedFrom(this.progress, this.keys);
      if (this.reached > 0) this.keep();
    }
    const fresh = this.reached === 0;
    this.show(this.allowed(levelOfPath(location.pathname)), false);
    if (fresh) {
      this.guide.open(() => {
        // 指引看完了才算玩过：中途走掉的人下次还从头看
        this.sync();
        this.reached = Math.max(this.reached, 1);
        this.keep();
      });
    }
  }

  /** 存着的"玩到第几关"可能被另一个标签页推到了前面，也可能被人手改了：以存着的那份为准 */
  private sync(): void {
    const stored = readReached(read(LEVEL_KEY));
    if (stored > 0) this.reached = stored;
  }

  /** 把"玩到第几关"存下来 */
  private keep(): void {
    try {
      localStorage.setItem(LEVEL_KEY, String(this.reached));
    } catch {
      // 存不了（比如无痕模式）就不存：这一页开着的时候照样算数
    }
  }

  /** 想进第 number 关（从 1 数起；0 是没说哪一关）的话实际进哪一关（从 0 数起）：没有这一关、还没轮到，都改进轮到的那一关 */
  private allowed(number: number): number {
    const top = landing(this.reached, this.levels.length);
    return number >= 1 && number - 1 <= top ? number - 1 : top;
  }

  /**
   * 地址栏换成第 index 关（从 0 数起）的地址，本来就是的话不动。
   * @param push 往浏览历史里添一项（玩家自己换的关，按后退能回来）；否则只是把现在这一项改掉
   */
  private address(index: number, push: boolean): void {
    const path = pathOfLevel(index + 1);
    try {
      if (location.pathname === path) return;
      if (push) history.pushState(null, '', path);
      else history.replaceState(null, '', path);
    } catch {
      // 有的环境不让改地址：不改，不影响玩
    }
  }

  /** 按了浏览器的后退、前进：去地址栏里现在写着的那一关 */
  private routed(): void {
    if (this.index < 0) return;
    this.sync();
    const index = this.allowed(levelOfPath(location.pathname));
    // 那个地址要是进不去（不是一关，或者还没轮到），地址栏改成实际去的那一关
    this.address(index, false);
    if (this.phase === 'entering') {
      // 托盘还在换：等它摆好了再换下一个（见 arrived），不然两次换托盘就叠在一起了
      this.wantsLevel = index;
    } else if (index !== this.index) {
      if (this.phase === 'tree') this.show(index, false);
      else void this.open(index, false);
    }
  }

  /** 亮出选关树，滚到第 focus 关（从 0 数起） */
  private showTree(focus: number): void {
    this.screen++;
    this.phase = 'tree';
    this.queue = [];
    this.wantsOut = false;
    // 3D 的画面被树整个盖住了：不用再画，弹珠滚动的沙沙声也停掉
    this.view.cover(true);
    this.sound.rolling(0);
    this.hud.setPlaying(false);
    this.sync();
    this.tree.render(this.nodes());
    this.tree.show(focus);
  }

  /** 树上每一关现在的样子 */
  private nodes(): TreeNode[] {
    return this.levels.map((entry, i) => {
      const state = stateOf(this.reached, this.levels.length, i);
      // 没轮到的关不写成绩，哪怕以前打过（那个数被人往回改了）
      const best = state === 'locked' ? 0 : bestOf(this.progress, this.keys[i]);
      return { state, dye: entry.dye, best, stars: best > 0 ? starsFor(best, entry.par) : 0 };
    });
  }

  /** 在树上点了第 index 关（从 0 数起）的木片 */
  private pick(index: number): void {
    if (this.phase !== 'tree') return;
    this.sync();
    if (stateOf(this.reached, this.levels.length, index) === 'locked') return;
    this.show(index, true);
  }

  /**
   * 3D 的画面没亮着的时候（刚打开网站，或者在选关树上）进第 index 关（从 0 数起）。
   * @param push 见 address
   */
  private show(index: number, push: boolean): void {
    this.tree.hide();
    this.view.cover(false);
    this.hud.setPlaying(true);
    void this.open(index, push);
  }

  /** 关里点了「选关」：回到树上，这一局不保留 */
  private leave(): void {
    // 新手指引盖着的时候，它底下的按钮都不算数
    if (this.guide.shown) return;
    // 托盘还在换的那一会儿先不动，记下来，等它摆好了再回树（见 arrived）：
    // 不然紧接着再进一关，两次换托盘就叠在一起了
    if (this.phase === 'entering') this.wantsOut = true;
    if (this.phase !== 'playing' && this.phase !== 'done') return;
    this.showTree(this.index);
  }

  /** 托盘摆好、弹珠落到起点了：可以玩了。摆的时候按过后退、前进的话现在换关；点过「选关」的话现在回树 */
  private arrived(): void {
    this.phase = 'playing';
    const want = this.wantsLevel;
    this.wantsLevel = null;
    if (want !== null && want !== this.index) {
      // 换过去的那一关摆好之后，之前记着的"回树"照样作数
      const out = this.wantsOut;
      void this.open(want, false);
      this.wantsOut = out;
      return;
    }
    if (this.wantsOut) this.leave();
  }

  private relayout(animate: boolean): void {
    this.view.layout(window.innerWidth, window.innerHeight, this.hud.insets(), animate);
  }

  /** 把按关记的成绩和"是否静音"存下来 */
  private save(): void {
    try {
      // 存之前先把已经存着的读回来合一下：另一个标签页可能刚存过，不能整份盖掉
      this.progress = mergeProgress(this.progress, loadProgress(localStorage.getItem(SAVE_KEY), null), this.keys);
      localStorage.setItem(SAVE_KEY, writeProgress(this.progress));
    } catch {
      // 存不了（比如无痕模式）就不存，不影响玩
    }
  }

  /**
   * 摆上第 index 关（从 0 数起）。地址栏跟着换成这一关的。
   * @param push 见 address
   */
  private async open(index: number, push: boolean): Promise<void> {
    const screen = ++this.screen;
    this.phase = 'entering';
    this.queue = [];
    this.wantsOut = false;
    this.index = index;
    this.address(index, push);
    this.hud.hideResult();
    const entry = this.levels[index];
    this.def = this.facing(entry);
    this.level = parseLevel(this.def.rows);
    this.game = newGame(this.level);
    this.hud.setLevel(entry.par, entry.dye);
    this.hud.setSteps(0);
    this.relayout(true);
    try {
      await this.view.enter(this.level, index + 1, dyeNumber(entry.dye));
    } catch (err) {
      // 托盘建不出来（比如手机上内存不够了）：停在这里并说明，而不是从此按什么都没反应
      showBroken(err);
      return;
    }
    if (this.screen !== screen) return;
    this.arrived();
  }

  /**
   * 长方形的关卡朝哪边摆：留给托盘的那一块地方是横的就横着摆，是竖的就竖着摆。
   * 竖着摆就是把图沿对角线翻过来，玩法、最少步数都不变。进这一关时定下来，玩到一半屏幕转了也不再变。
   */
  private facing(def: LevelDef): LevelDef {
    const rows = def.rows.length;
    const cols = def.rows[0].length;
    if (rows === cols) return def;
    const safe = this.hud.insets();
    const wide = window.innerWidth - safe.left - safe.right >= window.innerHeight - safe.top - safe.bottom;
    return cols > rows === wide ? def : transposeDef(def);
  }

  /** 玩家的一次操作：排进队里，轮到了再做 */
  private act(action: Action): void {
    // 新手指引盖着的时候不动弹珠
    if (this.guide.shown || this.phase !== 'playing' || this.queue.length >= QUEUE_LIMIT) return;
    this.queue.push(action);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length > 0 && this.phase === 'playing') {
      const action = this.queue.shift()!;
      const game = this.game;
      if (action.kind === 'roll') {
        const move = roll(game, action.dir);
        if (!move) {
          this.view.bump(action.dir);
          continue;
        }
        this.hud.setSteps(steps(game));
        // 这一步走完就通关的话，成绩现在就记，不等弹珠滚到头：这点工夫里玩家可能已经回了树、进了别的关
        const won = isDone(game) ? this.win(game) : null;
        await this.view.roll(move);
        if (won) await this.celebrate(game, won);
      } else if (action.kind === 'undo') {
        const move = undo(game);
        if (!move) continue;
        this.hud.setSteps(steps(game));
        await this.view.rewind(move);
      } else if (steps(game) > 0) {
        this.game = newGame(this.level);
        this.hud.setSteps(0);
        await this.view.restart();
      }
    }
    this.pumping = false;
  }

  /** 所有格子都染上了：不再接受操作，记下成绩；通过的是轮到的那一关的话，"玩到第几关"往前走一关 */
  private win(game: Game): Win {
    const used = steps(game);
    const key = this.keys[this.index];
    this.phase = 'done';
    this.queue = [];
    this.progress = record(this.progress, key, used);
    this.save();
    this.sync();
    this.reached = advanced(this.reached, this.index);
    this.keep();
    const result: ResultInfo = {
      steps: used,
      par: this.levels[this.index].par,
      best: bestOf(this.progress, key),
      hasNext: this.index + 1 < this.levels.length,
    };
    return { screen: this.screen, result };
  }

  /** 弹珠滚到头了：庆祝一下，亮出通关面板 */
  private async celebrate(game: Game, won: Win): Promise<void> {
    // 弹珠还在滚的时候就回了树（或者又进了别的关）：成绩已经记了，庆祝和通关面板就不要了
    if (this.screen !== won.screen) return;
    this.sound.win(starsFor(won.result.steps, won.result.par));
    await this.view.celebrate(game.pos);
    if (this.screen !== won.screen) return;
    this.hud.showResult(won.result);
    this.relayout(true);
  }

  /** 通关之后的"再来一次"：这一关从头再来 */
  private async again(): Promise<void> {
    if (this.phase !== 'done') return;
    const screen = this.screen;
    this.hud.hideResult();
    this.relayout(true);
    this.queue = [];
    this.phase = 'entering';
    const game = newGame(this.level);
    this.game = game;
    this.hud.setSteps(0);
    await this.view.restart();
    if (this.screen !== screen || this.game !== game) return;
    this.arrived();
  }

  private toggleSound(): void {
    const muted = !this.progress.muted;
    this.progress = { ...this.progress, muted };
    this.save();
    this.sound.setMuted(muted);
    this.hud.setSound(!muted);
  }

  /** 给自动化检查用：现在的局面 */
  snapshot(): {
    /** 第几关，从 1 数起。在选关树上时是刚才那一关；还没 start 是 0 */
    level: number;
    /** 这一关的固定编号；还没 start 是空串 */
    id: string;
    steps: number;
    pos: number;
    dyed: number;
    floor: number;
    /** tree 是在选关树上 */
    phase: string;
    /** 新手指引正盖在上面 */
    guide: boolean;
    /** 手头的操作都做完了（弹珠已经撞到墙），可以接着操作 */
    idle: boolean;
    /** 画面上所有动画都演完了 */
    settled: boolean;
    solution: string;
  } {
    return {
      level: this.index + 1,
      id: this.levels[this.index]?.id ?? '',
      steps: steps(this.game),
      pos: this.game.pos,
      dyed: this.game.dyedCount,
      floor: this.level.floorCount,
      phase: this.phase,
      guide: this.guide.shown,
      idle: this.queue.length === 0 && !this.pumping,
      settled: this.view.settled,
      solution: this.def.solution,
    };
  }
}

/** 读浏览器里存的一项；读不了（比如无痕模式）就当没有 */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
