import * as THREE from 'three';
import { STEP, type Dir, type Level } from '../game/level.ts';
import type { Move } from '../game/rules.ts';
import { Drops } from './drops.ts';
import { Marble } from './marble.ts';
import { rollProfile, settle } from './motion.ts';
import { Governor, isModestGpu, sharpnessFor } from './sharpness.ts';
import { SQUARE, Stage, type Extent, type Insets, type WoodUrls } from './stage.ts';
import { Tray } from './tray.ts';
import { Waits } from './waits.ts';

/** 画面里发生了什么（给声音用） */
export interface ViewEvents {
  /** 小球撞上了墙，strength 是 0–1 的力度 */
  impact(strength: number): void;
  /** 小球落在了底板上，strength 是 0–1 的力度 */
  land(strength: number): void;
  /** 小球此刻滚得多快（0–1）；停下时会收到一次 0 */
  rolling(speed: number): void;
  /** 托盘在桌面上滑动（换关） */
  slide(): void;
}

/** 小球的加速度和最高速度（世界单位每秒）。托盘内框边长是 10，所以最快三分之一秒横穿整个托盘。 */
const ACCEL = 135;
const TOP_SPEED = 31;
/** 落下、弹起用的重力，和每次弹起保留多少速度 */
const GRAVITY = 62;
const RESTITUTION = 0.36;
/** 新托盘从多远的地方滑进来 */
const SLIDE = 27;
/** 没有动画之后还要继续画多久：刚滚过的地方是湿的，要等它慢慢干 */
const LINGER = 6;

/**
 * 弹珠滚动时托盘朝那个方向倾斜多少（弧度）：像是有人把托盘的一边稍稍抬起来让球滚。
 * 只要隐约看得出来就够（0.2 度多一点，电脑上托盘边抬起一两个像素）：大了每走一步整个画面都跟着晃，看着累。
 * 0.034 和 0.011 都试过，玩的人都嫌太明显。
 */
const TILT = 0.004;
/**
 * 倾斜和放平要多久（秒，越小越快）。
 * 托盘在动的每一帧影子都要重画，所以不能拖得太久：幅度小了之后用 0.06，从抬起到放平用的帧数和原来差不多。
 */
const TILT_TIME = 0.06;

interface Board {
  readonly tray: Tray;
  readonly marble: Marble;
  readonly drops: Drops;
  /** 托盘现在的倾斜（x：近的一边低；z：右边低），以及正要变成的样子 */
  readonly tilt: { x: number; z: number; toX: number; toZ: number };
}

const easeInOut = (k: number): number => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** 游戏画面：托盘、弹珠和它们的全部动画。规则不在这里，这里只管"照着演"。 */
export class GameView {
  private readonly stage: Stage;
  private readonly events: ViewEvents;
  private board: Board | null = null;
  private leaving: Board | null = null;
  /** 到点要做的事，按时间排好 */
  private timers: Array<{ at: number; run: () => void }> = [];
  /** 弹珠当前的动画；返回 false 表示演完了 */
  private ball: ((t: number) => boolean) | null = null;
  /** 其他同时进行的动画 */
  private extras: Array<(t: number) => boolean> = [];
  /** 外面正在等的动画 */
  private readonly waits = new Waits();
  private readonly epoch = performance.now();
  private lastFrame = 0;
  private activeUntil = 0;
  private raf = 0;
  /** 上一帧之后有没有接着排下一帧（连续出画面） */
  private streak = false;
  private readonly scratch = new THREE.Vector3();
  /** 取景最后要变成的样子：四边留出多少地方给界面、要放进去的托盘有多大 */
  private aimSafe: Insets | null = null;
  private aimBox: Extent = SQUARE;
  /** 现在的取景（正在平滑移动的话，是移到一半的样子） */
  private shot: { safe: Insets; box: Extent } | null = null;
  private aimToken = 0;
  private size = { width: 0, height: 0, device: 0 };
  /** 一帧最多画多少个点：看显卡的档次定 */
  private readonly budget: number;
  /** 盯着帧率、决定画面画多细 */
  private governor = new Governor(1);
  /** 上一帧各个托盘的位置和倾斜，用来看它们动没动（动了影子才要重画） */
  private trayPose = '';
  /** 画面被别的东西整个盖住了（选关树亮着），见 cover */
  private covered = false;

  constructor(canvas: HTMLCanvasElement, events: ViewEvents) {
    this.stage = new Stage(canvas);
    this.events = events;
    this.budget = isModestGpu(this.stage.gpuName()) ? 3_000_000 : 6_000_000;
  }

  /** 从画面创建起过了多少秒 */
  private now(): number {
    return (performance.now() - this.epoch) / 1000;
  }

  // ───────────────────────── 每一帧 ─────────────────────────

  /** 有事情要演了：保证接下来一直在画 */
  private wake(): void {
    this.activeUntil = this.now() + LINGER;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (): void => {
    this.raf = 0;
    const t = this.now();
    const elapsed = t - this.lastFrame;
    const dt = Math.min(0.05, Math.max(0, elapsed));
    this.lastFrame = t;
    // 只在连续出画面的时候量速度：停了一阵再醒过来的第一帧不算；画面被盖住的时候根本没在画，更不算
    if (this.streak && !this.covered && this.governor.frame(elapsed)) this.applyShot();
    this.streak = !this.covered;

    while (this.timers.length > 0 && this.timers[0].at <= t) this.timers.shift()!.run();
    // 动画自己可能在这一帧里换上了下一段动画，所以演完之后要确认还是它才清掉
    const step = this.ball;
    if (step && !step(t) && this.ball === step) this.ball = null;
    if (this.extras.length > 0) this.extras = this.extras.filter((extra) => extra(t));

    let dropsMoving = false;
    let tilting = false;
    let pose = '';
    for (const b of [this.board, this.leaving]) {
      if (!b) continue;
      // 托盘的倾斜一点点地跟上去；抬起一边的同时整体略微升高，这样低的那一边始终贴着桌面
      const tilt = b.tilt;
      const follow = 1 - Math.exp(-dt / TILT_TIME);
      tilt.x += (tilt.toX - tilt.x) * follow;
      tilt.z += (tilt.toZ - tilt.z) * follow;
      if (Math.abs(tilt.toX - tilt.x) + Math.abs(tilt.toZ - tilt.z) < 1e-4) {
        tilt.x = tilt.toX;
        tilt.z = tilt.toZ;
      } else {
        tilting = true;
      }
      b.tray.group.rotation.set(tilt.x, 0, -tilt.z);
      b.tray.group.position.y = (b.tray.depth / 2) * Math.abs(Math.sin(tilt.x)) + (b.tray.width / 2) * Math.abs(Math.sin(tilt.z));
      const at = b.tray.group.position;
      pose += `${at.x},${at.z},${tilt.x},${tilt.z};`;
      b.tray.stain.uniforms.uTime.value = t;
      const m = b.marble.group;
      b.tray.stain.setBall(m.position.x, m.position.y, m.position.z, m.visible ? b.marble.radius : 0);
      b.drops.update(dt);
      dropsMoving ||= b.drops.active;
    }
    // 被盖住的时候不画（上一帧的位置也不记：等露出来，影子按那时的样子重画）
    if (!this.covered) {
      this.stage.render(pose !== this.trayPose);
      this.trayPose = pose;
    }

    const busy = this.ball !== null || this.extras.length > 0 || this.timers.length > 0 || dropsMoving || tilting;
    if (busy) this.activeUntil = t + LINGER;
    // 平时动画演完还要接着画几秒（等染料变干）；被盖住的时候没人看，演完就停
    if (this.covered ? busy : t < this.activeUntil) {
      // 这一帧里可能已经有人叫过 wake() 排好了下一帧；再排一次的话，以后每帧就要画两遍
      if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    } else {
      this.streak = false;
    }
  };

  private at(time: number, run: () => void): void {
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1].at > time) i--;
    this.timers.splice(i, 0, { at: time, run });
  }

  /** 开始弹珠的一段动画，并等它演到某个时刻（演到了就调用 finish）。被别的动画顶掉也算等完，见 waits.ts。 */
  private wait(begin: (finish: () => void) => void): Promise<void> {
    const done = this.waits.wait(begin);
    this.wake();
    return done;
  }

  /** 弹珠要演别的了：之前排好的事全部作废，还在等的都不用等了 */
  private interrupt(): void {
    this.timers = [];
    this.waits.releaseAll();
  }

  /** 在 duration 秒里从 0 走到 1，每帧调用 step */
  private tween(duration: number, step: (k: number) => void): Promise<void> {
    const t0 = this.now();
    return new Promise((resolve) => {
      this.extras.push((t) => {
        const k = Math.min(1, (t - t0) / duration);
        step(k);
        if (k < 1) return true;
        resolve();
        return false;
      });
      this.wake();
    });
  }

  // ───────────────────────── 对外的操作 ─────────────────────────

  /**
   * 画面大小或界面占的地方变了，重新取景。
   * @param glide 不是一下子跳过去，而是用不到半秒的时间平滑地移过去（界面多出一块面板时用）
   */
  layout(width: number, height: number, safe: Insets, glide: boolean): void {
    const device = window.devicePixelRatio || 1;
    if (width !== this.size.width || height !== this.size.height || device !== this.size.device) {
      // 画面大小变了：画多细重新定（见 sharpness.ts），带不动的话再由 governor 往下调
      this.size = { width, height, device };
      this.governor = new Governor(sharpnessFor(width, height, device, this.budget));
    }
    this.aimSafe = safe;
    this.reframe(glide ? 0.42 : 0);
  }

  /** 把取景移到 aimSafe、aimBox 那里去：duration 秒内平滑地移过去，0 就是一下子跳过去 */
  private reframe(duration: number): void {
    const safe = this.aimSafe;
    if (!safe) return;
    const box = this.aimBox;
    const from = this.shot;
    const token = ++this.aimToken;
    const same =
      from !== null &&
      from.safe.left === safe.left &&
      from.safe.right === safe.right &&
      from.safe.top === safe.top &&
      from.safe.bottom === safe.bottom &&
      from.box.halfWidth === box.halfWidth &&
      from.box.halfDepth === box.halfDepth;
    if (duration <= 0 || !from || same) {
      this.shot = { safe, box };
      this.applyShot();
      this.wake();
      return;
    }
    void this.tween(duration, (k) => {
      // 中途又来了一次新的取景，这一次就作废
      if (token !== this.aimToken) return;
      const e = easeInOut(k);
      const mix = (a: number, b: number): number => a + (b - a) * e;
      this.shot = {
        safe: { left: mix(from.safe.left, safe.left), right: mix(from.safe.right, safe.right), top: mix(from.safe.top, safe.top), bottom: mix(from.safe.bottom, safe.bottom) },
        box: { halfWidth: mix(from.box.halfWidth, box.halfWidth), halfDepth: mix(from.box.halfDepth, box.halfDepth) },
      };
      this.applyShot();
    });
  }

  private applyShot(): void {
    if (this.shot) this.stage.resize(this.size.width, this.size.height, this.governor.ratio, this.shot.safe, this.shot.box);
  }

  /**
   * 画面被整个盖住了（选关树亮出来），或者又露出来了。
   * 盖住的时候：正演到一半的动画照常演完——外面的人还等着它结束——但一帧也不画，也不拿这些帧去量快慢
   * （滚动那棵树造成的慢，不该算到游戏画面头上）；演完就停，手机上滚树时不用和整幅 3D 画面抢显卡。
   */
  cover(on: boolean): void {
    this.covered = on;
    // 露出来：把现在的样子画上
    if (!on && this.board) this.wake();
  }

  /** 界面要用的木纹图片：木片、木牌的两种，选关树那块长木板的、那棵树的树干的，和桌面的 */
  woodUrls(): WoodUrls {
    return this.stage.woodUrls();
  }

  /**
   * 摆上一关的托盘，然后让弹珠落到起点。
   * 新托盘从右边滑进来；桌上已经有托盘的话，旧的同时往左滑走。弹珠第一次落地时结束等待（这时就可以操作了）。
   */
  async enter(level: Level, dyeHex: number): Promise<void> {
    const dye = new THREE.Color(dyeHex);
    const tray = new Tray(level, this.stage.assets, dye);
    const marble = new Marble(tray.ballRadius, dye);
    const drops = new Drops(dye, (x, z) => tray.isFloorAt(x, z));
    marble.group.visible = false;
    tray.group.add(marble.group, drops.mesh);
    const next: Board = { tray, marble, drops, tilt: { x: 0, z: 0, toX: 0, toZ: 0 } };

    this.interrupt();
    this.ball = null;
    this.events.rolling(0);
    const old = this.board;
    if (old) old.tilt.toX = old.tilt.toZ = 0;
    this.board = next;
    this.stage.board.add(tray.group);
    // 新托盘的大小可能和旧的不一样（长方形的关卡）：趁着换托盘，把镜头也移到正好装下新托盘的地方。
    // 桌上还没有托盘（刚打开网站）就没什么可移的，镜头直接到位
    this.aimBox = { halfWidth: tray.width / 2, halfDepth: tray.depth / 2 };
    this.reframe(old ? 0.9 : 0);

    this.leaving = old;
    tray.group.position.x = SLIDE;
    this.stage.setShadowReach(SLIDE + 9);
    this.events.slide();
    await this.tween(0.9, (k) => {
      const e = easeInOut(k);
      if (old) old.tray.group.position.x = -SLIDE * e;
      tray.group.position.x = SLIDE * (1 - e);
    });
    this.stage.setShadowReach();
    if (old) {
      this.leaving = null;
      this.stage.board.remove(old.tray.group);
      old.tray.dispose();
      old.marble.dispose();
      old.drops.dispose();
    }
    if (this.board !== next) return;
    const start = tray.cellCenter(tray.level.start).clone();
    await this.wait((finish) => {
      this.bounce(next, start, 7.5, 0, (when) => {
        tray.stain.dye(tray.level.start, when, 0);
        finish();
      });
    });
  }

  /** 照着这一步滚过去。撞到墙的那一刻结束等待；之后弹珠还会回弹着停稳，但已经可以接着操作。 */
  roll(move: Move): Promise<void> {
    const board = this.board;
    if (!board) return Promise.resolve();
    const { tray, marble, drops } = board;
    const [dz, dx] = STEP[move.dir];
    const from = tray.cellCenter(move.from).clone();
    const to = tray.cellCenter(move.to).clone();
    const gap = tray.cell / 2 - marble.radius;
    const profile = rollProfile(move.path.length * tray.cell + gap, ACCEL, TOP_SPEED);
    this.interrupt();
    const t0 = this.now();
    // 上一步的回弹可能还没停稳：把此刻偏出去的那一点很快地收回来，不让弹珠跳一下
    const carryX = marble.group.position.x - from.x;
    const carryZ = marble.group.position.z - from.z;

    // 每一格在弹珠滚到它正中时染上色（已经染过的就只是重新变湿）
    const from12 = dx !== 0 ? 1 : 2;
    move.path.forEach((cell, i) => {
      const when = t0 + profile.timeAt((i + 1) * tray.cell);
      const fresh = move.fresh.includes(cell);
      this.at(when, () => (fresh ? tray.stain.dye(cell, when, from12) : tray.stain.wet(cell, when)));
    });

    // 托盘朝滚动的方向倾过去，撞墙时放平
    board.tilt.toX = dz * TILT;
    board.tilt.toZ = dx * TILT;

    return this.wait((finish) => {
      let rolled = 0;
      let hit = false;
      this.ball = (t) => {
        const dt = t - t0;
        if (dt < profile.duration) {
          const s = profile.at(dt);
          const carry = Math.exp(-dt / 0.03);
          marble.group.position.set(from.x + dx * s + carryX * carry, marble.radius, from.z + dz * s + carryZ * carry);
          marble.roll(dx, dz, s - rolled);
          rolled = s;
          this.events.rolling(Math.min(1, (s > 0 ? (profile.at(dt + 0.001) - s) / 0.001 : 0) / TOP_SPEED));
          return true;
        }
        if (!hit) {
          hit = true;
          rolled = gap;
          const strength = profile.endSpeed / TOP_SPEED;
          board.tilt.toX = board.tilt.toZ = 0;
          this.events.rolling(0);
          this.events.impact(strength);
          drops.burst(to.x + dx * (gap + marble.radius * 0.9), marble.radius * 0.5, to.z + dz * (gap + marble.radius * 0.9), dx, dz, Math.round(4 + strength * 8), strength, tray.cell);
          this.nudge(tray, dx, dz, strength);
          finish();
        }
        const since = dt - profile.duration;
        // 回弹的那一点点晃动 0.7 秒后已经看不出来了，直接摆正在格子中间
        const off = since < 0.7 ? settle(since, gap, profile.endSpeed) : 0;
        marble.group.position.set(to.x + dx * off, marble.radius, to.z + dz * off);
        marble.roll(dx, dz, off - rolled);
        rolled = off;
        return since < 0.7;
      };
    });
  }

  /** 朝墙推了一下、一格也滚不动：弹珠往墙上轻轻磕一下再回来 */
  bump(dir: Dir): void {
    const board = this.board;
    if (!board || this.ball) return;
    const { tray, marble } = board;
    const [dz, dx] = STEP[dir];
    const center = marble.group.position.clone();
    const gap = tray.cell / 2 - marble.radius;
    const profile = rollProfile(gap, ACCEL * 0.6, TOP_SPEED);
    const t0 = this.now();
    let rolled = 0;
    let hit = false;
    this.ball = (t) => {
      const dt = t - t0;
      let off: number;
      if (dt < profile.duration) {
        off = profile.at(dt);
      } else {
        if (!hit) {
          hit = true;
          this.events.impact(Math.min(0.3, profile.endSpeed / TOP_SPEED));
        }
        const since = dt - profile.duration;
        off = since < 0.6 ? settle(since, gap, profile.endSpeed) : 0;
      }
      marble.group.position.set(center.x + dx * off, marble.radius, center.z + dz * off);
      marble.roll(dx, dz, off - rolled);
      rolled = off;
      return dt - profile.duration < 0.6;
    };
    this.wake();
  }

  /** 撤销这一步：弹珠沿原路滚回去，这一步染上的格子随着它经过而褪色。滚回原位后结束等待。 */
  rewind(move: Move): Promise<void> {
    const board = this.board;
    if (!board) return Promise.resolve();
    const { tray, marble } = board;
    this.interrupt();
    board.tilt.toX = board.tilt.toZ = 0;
    const [dz, dx] = STEP[move.dir];
    const from = tray.cellCenter(move.from).clone();
    const to = tray.cellCenter(move.to).clone();
    const length = move.path.length * tray.cell;
    const duration = 0.14 + 0.022 * move.path.length;
    const t0 = this.now();
    const startX = marble.group.position.x;
    const startZ = marble.group.position.z;

    move.path.forEach((cell, i) => {
      if (!move.fresh.includes(cell)) return;
      // 越靠近终点的格子越早褪色
      const when = t0 + duration * ((move.path.length - 1 - i) / move.path.length) * 0.9;
      this.at(when, () => tray.stain.fade(cell, when));
    });

    return this.wait((finish) => {
      let rolled = 0;
      this.ball = (t) => {
        const k = Math.min(1, (t - t0) / duration);
        const s = easeInOut(k) * length;
        const blend = Math.min(1, k * 6);
        const x = to.x - dx * s;
        const z = to.z - dz * s;
        marble.group.position.set(startX + (x - startX) * blend, marble.radius, startZ + (z - startZ) * blend);
        marble.roll(-dx, -dz, s - rolled);
        rolled = s;
        if (k < 1) return true;
        marble.group.position.set(from.x, marble.radius, from.z);
        finish();
        return false;
      };
    });
  }

  /** 重玩：染上的颜色全部褪掉，弹珠跳回起点。落回起点时结束等待。 */
  restart(): Promise<void> {
    const board = this.board;
    if (!board) return Promise.resolve();
    const { tray, marble } = board;
    this.interrupt();
    board.tilt.toX = board.tilt.toZ = 0;
    this.events.rolling(0);
    const t0 = this.now();
    for (let cell = 0; cell < tray.level.floor.length; cell++) {
      if (tray.stain.isDyed(cell)) tray.stain.fade(cell, t0);
    }
    const start = tray.cellCenter(tray.level.start).clone();
    const fromX = marble.group.position.x;
    const fromZ = marble.group.position.z;
    const far = Math.hypot(start.x - fromX, start.z - fromZ);
    const duration = 0.34 + far * 0.012;
    const lift = 1.4 + far * 0.12;
    return this.wait((finish) => {
      this.ball = (t) => {
        const k = Math.min(1, (t - t0) / duration);
        const e = easeInOut(k);
        marble.group.position.set(fromX + (start.x - fromX) * e, marble.radius + 4 * lift * k * (1 - k), fromZ + (start.z - fromZ) * e);
        if (k < 1) return true;
        // 落回起点：起点重新染上色，弹珠再小小地弹一下
        const when = t0 + duration;
        tray.stain.dye(tray.level.start, when, 0);
        this.events.land(0.55);
        finish();
        this.bounce(board, start, 0, ((4 * lift) / duration) * RESTITUTION, null);
        return true;
      };
    });
  }

  /**
   * 通关：一圈湿润的反光从弹珠所在处荡开，弹珠原地跳一下。演完后结束等待。
   * @param cell 弹珠停在哪一格。跳起、落下都在这一格的正中——不能用弹珠此刻的位置，它刚撞完墙，还贴在墙边没弹回来
   */
  celebrate(cell: number): Promise<void> {
    const board = this.board;
    if (!board) return Promise.resolve();
    const { tray } = board;
    const t0 = this.now() + 0.28;
    const here = tray.cellCenter(cell).clone();
    for (let cell = 0; cell < tray.level.floor.length; cell++) {
      if (!tray.level.floor[cell]) continue;
      const c = tray.cellCenter(cell, this.scratch);
      // 离弹珠越远的格子越晚亮起来，整圈大约半秒荡到最远处
      const when = t0 + Math.hypot(c.x - here.x, c.z - here.z) * 0.05;
      this.at(when, () => tray.stain.wet(cell, when));
    }
    return this.wait((finish) => {
      this.at(t0, () => this.bounce(board, here, 0, 6.4, null));
      this.at(t0 + 0.95, finish);
    });
  }

  // ───────────────────────── 内部的动画 ─────────────────────────

  /**
   * 弹珠在 spot 处竖直地落下、弹起，几下之后停稳。
   * @param height 开始时离底板多高
   * @param up 开始时向上的速度（原地跳起就给一个正数）
   * @param onFirstTouch 第一次碰到底板时调用，参数是那一刻的时间
   */
  private bounce(board: Board, spot: THREE.Vector3, height: number, up: number, onFirstTouch: ((when: number) => void) | null): void {
    const { marble } = board;
    const t0 = this.now();
    // 每一段抛物线：起始时刻、起始高度、起始的向上速度
    const arcs: Array<{ start: number; y: number; v: number }> = [{ start: t0, y: height, v: up }];
    // 每次碰到底板的时刻，和碰上那一刻的速度
    const touches: Array<{ at: number; speed: number }> = [];
    for (;;) {
      const a = arcs[arcs.length - 1];
      // 这一段什么时候落回底板：y + v·t − g·t²/2 = 0
      const air = (a.v + Math.sqrt(a.v * a.v + 2 * GRAVITY * a.y)) / GRAVITY;
      const speed = GRAVITY * air - a.v;
      touches.push({ at: a.start + air, speed });
      if (speed * RESTITUTION < 1.6) break;
      arcs.push({ start: a.start + air, y: 0, v: speed * RESTITUTION });
    }
    marble.group.visible = true;
    marble.group.position.set(spot.x, marble.radius + height, spot.z);

    let reported = 0;
    this.ball = (t) => {
      while (reported < touches.length && t >= touches[reported].at) {
        this.events.land(Math.min(1, touches[reported].speed / 22));
        if (reported === 0) onFirstTouch?.(touches[0].at);
        reported++;
      }
      if (reported >= touches.length) {
        marble.group.position.set(spot.x, marble.radius, spot.z);
        return false;
      }
      let i = arcs.length - 1;
      while (i > 0 && arcs[i].start > t) i--;
      const dt = t - arcs[i].start;
      marble.group.position.set(spot.x, marble.radius + Math.max(0, arcs[i].y + arcs[i].v * dt - 0.5 * GRAVITY * dt * dt), spot.z);
      return true;
    };
    this.wake();
  }

  /** 弹珠撞墙，托盘被带得顺着那个方向微微一晃 */
  private nudge(tray: Tray, dx: number, dz: number, strength: number): void {
    const t0 = this.now();
    const size = 0.05 * strength;
    this.extras.push((t) => {
      const dt = t - t0;
      const off = size * Math.sin(dt * 58) * Math.exp(-dt / 0.055);
      tray.group.position.x = dx * off;
      tray.group.position.z = dz * off;
      if (dt < 0.35) return true;
      tray.group.position.x = 0;
      tray.group.position.z = 0;
      return false;
    });
  }

  // ───────────────────────── 给自动化检查用 ─────────────────────────

  /** 现在是不是完全静止（没有任何动画在演） */
  get settled(): boolean {
    return this.ball === null && this.extras.length === 0 && this.timers.length === 0;
  }

  /** 弹珠现在在托盘上的位置（托盘自己的坐标） */
  marblePosition(): { x: number; y: number; z: number } | null {
    const p = this.board?.marble.group.position;
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }
}
