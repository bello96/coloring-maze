import { Sound } from './audio/sound.ts';
import { parseLevel, transposeDef, type Dir, type Level, type LevelDef } from './game/level.ts';
import { LEVELS } from './game/levels.ts';
import { bestOf, isUnlocked, mergeProgress, readProgress, record, writeProgress, type Progress } from './game/progress.ts';
import { isDone, newGame, roll, steps, undo, type Game } from './game/rules.ts';
import { starsFor } from './game/stars.ts';
import { showBroken } from './ui/broken.ts';
import { Hud } from './ui/hud.ts';
import { listen } from './ui/input.ts';
import { dyeCss, dyeOf } from './view/dyes.ts';
import { GameView } from './view/view.ts';

const STORAGE_KEY = 'coloring-maze.v1';
/** 弹珠还在滚的时候，最多先记下这么多次操作，等它停了接着做 */
const QUEUE_LIMIT = 2;

type Action = { readonly kind: 'roll'; readonly dir: Dir } | { readonly kind: 'undo' } | { readonly kind: 'restart' };

/** 把规则、画面、界面、声音、存档串在一起 */
export class App {
  private readonly sound = new Sound();
  private readonly view: GameView;
  private readonly hud: Hud;
  private progress: Progress;
  private index = 0;
  /** 现在这一关，按摆在屏幕上的朝向（长方形的关卡可能是翻过来摆的，见 facing） */
  private def: LevelDef = LEVELS[0];
  private level: Level = parseLevel(LEVELS[0].rows);
  private game: Game = newGame(this.level);
  /** 只有 playing 的时候接受操作：entering 是托盘正在换、弹珠还没落下，done 是已经通关 */
  private phase: 'entering' | 'playing' | 'done' = 'entering';
  private queue: Action[] = [];
  private pumping = false;

  constructor(canvas: HTMLCanvasElement, font: string) {
    this.progress = readProgress(load(), LEVELS.length);
    this.sound.setMuted(this.progress.muted);
    this.view = new GameView(canvas, font, {
      impact: (strength) => this.sound.impact(strength),
      land: (strength) => this.sound.land(strength),
      rolling: (speed) => this.sound.rolling(speed),
      slide: () => this.sound.slide(),
    });
    this.hud = new Hud({
      undo: () => this.act({ kind: 'undo' }),
      restart: () => this.act({ kind: 'restart' }),
      openLevels: () => this.openLevels(),
      closeLevels: () => this.hud.closeLevels(),
      toggleSound: () => this.toggleSound(),
      next: () => {
        if (this.phase === 'done' && this.index + 1 < LEVELS.length) void this.open(this.index + 1);
      },
      again: () => void this.again(),
      pick: (level) => this.pick(level),
    });
    this.hud.setSound(!this.progress.muted);
    listen(canvas, (dir) => this.act({ kind: 'roll', dir }));

    // 浏览器要等到第一次点击或按键才允许出声（iPhone 上要等手指抬起来才算数，所以几种事件都听）
    const unlock = (): void => this.sound.unlock();
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
      window.addEventListener(type, unlock, true);
    }
    document.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('.chip, .tile')) this.sound.tap();
    });
    window.addEventListener('resize', () => this.relayout(false));
    // 切到别的标签页时画面会停住；要是弹珠正滚到一半，滚动的沙沙声不能跟着一直响下去
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.sound.rolling(0);
    });
  }

  /** 木纹和字体都备好之后调用：亮出界面，摆上上次玩到的那一关 */
  start(): void {
    const wood = this.view.woodUrls();
    this.hud.show(wood.dark, wood.light);
    void this.open(this.progress.last);
  }

  private relayout(animate: boolean): void {
    this.view.layout(window.innerWidth, window.innerHeight, this.hud.insets(), animate);
  }

  private save(): void {
    try {
      // 存之前先把已经存着的读回来合一下：另一个标签页可能刚存过，不能整份盖掉
      this.progress = mergeProgress(this.progress, readProgress(localStorage.getItem(STORAGE_KEY), LEVELS.length));
      localStorage.setItem(STORAGE_KEY, writeProgress(this.progress));
    } catch {
      // 存不了（比如无痕模式）就不存，不影响玩
    }
  }

  /** 换到第 index 关（从 0 数起） */
  private async open(index: number): Promise<void> {
    this.phase = 'entering';
    this.queue = [];
    this.index = index;
    this.hud.closeLevels();
    this.hud.hideResult();
    // 新手提示牌：还没通过第 1 关的人才看得到（这时也只可能在第 1 关）
    this.hud.setGuide(index === 0 && bestOf(this.progress, 0) === 0);
    this.def = this.facing(LEVELS[index]);
    this.level = parseLevel(this.def.rows);
    const game = newGame(this.level);
    this.game = game;
    this.progress = { ...this.progress, last: index };
    this.save();
    this.hud.setLevel(LEVELS[index].par, dyeCss(index));
    this.hud.setSteps(0);
    this.relayout(true);
    try {
      await this.view.enter(this.level, index + 1, dyeOf(index));
    } catch (err) {
      // 托盘建不出来（比如手机上内存不够了）：停在这里并说明，而不是从此按什么都没反应
      showBroken(err);
      return;
    }
    if (this.game !== game) return;
    this.phase = 'playing';
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
    if (this.phase !== 'playing' || this.hud.levelsOpen || this.queue.length >= QUEUE_LIMIT) return;
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
        await this.view.roll(move);
        if (this.game === game && isDone(game)) await this.finish();
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

  private async finish(): Promise<void> {
    const game = this.game;
    const used = steps(game);
    const par = LEVELS[this.index].par;
    this.phase = 'done';
    this.queue = [];
    this.progress = record(this.progress, this.index, used);
    this.save();
    // 最后一步还在滚的时候可能已经点开了选关面板：让它马上显示刚得的星、打开下一关
    if (this.hud.levelsOpen) this.openLevels();
    this.sound.win(starsFor(used, par));
    await this.view.celebrate(game.pos);
    if (this.game !== game) return;
    // 第 1 关过了，新手提示牌从此不再出现
    this.hud.setGuide(false);
    this.hud.showResult({ steps: used, par, best: bestOf(this.progress, this.index), hasNext: this.index + 1 < LEVELS.length });
    this.relayout(true);
  }

  /** 这一关从头再来（通关之后的"再来一次"，或者在选关里又点了当前这一关） */
  private async again(): Promise<void> {
    if (this.phase === 'entering') return;
    this.hud.hideResult();
    this.relayout(true);
    this.queue = [];
    if (this.phase === 'playing' && steps(this.game) === 0) return;
    this.phase = 'entering';
    const game = newGame(this.level);
    this.game = game;
    this.hud.setSteps(0);
    await this.view.restart();
    if (this.game !== game) return;
    this.phase = 'playing';
  }

  private openLevels(): void {
    if (this.phase === 'entering') return;
    this.hud.openLevels(
      LEVELS.map((def) => def.par),
      LEVELS.map((_, i) => dyeCss(i)),
      this.progress,
      this.index,
    );
  }

  private pick(level: number): void {
    if (this.phase === 'entering' || !isUnlocked(this.progress, level)) return;
    this.hud.closeLevels();
    if (level === this.index) void this.again();
    else void this.open(level);
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
    level: number;
    steps: number;
    pos: number;
    dyed: number;
    floor: number;
    phase: string;
    /** 手头的操作都做完了（弹珠已经撞到墙），可以接着操作 */
    idle: boolean;
    /** 画面上所有动画都演完了 */
    settled: boolean;
    solution: string;
  } {
    return {
      level: this.index + 1,
      steps: steps(this.game),
      pos: this.game.pos,
      dyed: this.game.dyedCount,
      floor: this.level.floorCount,
      phase: this.phase,
      idle: this.queue.length === 0 && !this.pumping,
      settled: this.view.settled,
      solution: this.def.solution,
    };
  }
}

function load(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
