// 画面画得多精细：一个屏幕像素画几个点（"倍数"）。
// 点越多越清楚，也越吃显卡；这里按屏幕大小和显卡的档次定一个起点，带不动时再往下调。

/** 再细的屏幕也最多画到 2 倍，再往上肉眼看不出差别 */
const FINEST = 2;
/** 最粗不低于 0.75 倍，再粗就糊得明显了 */
const COARSEST = 0.75;

/**
 * 一开始用几倍来画。
 * @param width、height 画面的大小（屏幕像素）
 * @param deviceRatio 屏幕本身是几倍的
 * @param budget 一帧最多画多少个点
 */
export function sharpnessFor(width: number, height: number, deviceRatio: number, budget: number): number {
  const affordable = Math.sqrt(budget / Math.max(1, width * height));
  return Math.max(COARSEST, Math.min(deviceRatio, FINEST, affordable));
}

/** 带不动了，画粗一档：减掉五分之一 */
export function coarser(ratio: number): number {
  return Math.max(COARSEST, ratio * 0.8);
}

/**
 * 从显卡的名字看它是不是"普通"的那一类（集成显卡、入门手机芯片、软件渲染）。
 * 认不出来的名字、拿不到名字，都按普通的算——宁可先画粗一点。
 */
export function isModestGpu(renderer: string): boolean {
  if (/Apple|NVIDIA|GeForce|Radeon|AMD|Adreno/i.test(renderer)) return false;
  return true;
}

/** 每看这么多帧下一次判断 */
const WINDOW = 40;
/** 一帧超过这么久（秒），就是没赶上 60 帧每秒的节拍 */
const LATE = 0.021;
/** 超过这么久的不是"画得慢"，是停顿（比如切到别的标签页又回来），不算数 */
const STALL = 0.25;
/** 画粗一档之后，平均每帧至少要快出这个比例才算有用 */
const WORTH_IT = 0.87;
/** 刚开始、刚改完画面大小的头这么多帧不看：那时在上传贴图、重新分配显存，慢是正常的 */
const WARM_UP = 45;

/**
 * 盯着每一帧花了多久，带不动就把画面画粗一档。
 *
 * 画粗之后如果并没有变快，说明慢不是因为画得太细（比如手机开了省电模式，浏览器把画面限制在每秒 30 帧）。
 * 那就改回去，并且以后不再调——免得白白变糊。
 */
export class Governor {
  /** 现在用几倍来画 */
  ratio: number;
  private count = 0;
  private late = 0;
  private total = 0;
  /** 刚画粗了一档、正在观察有没有用：记着之前的倍数和之前平均每帧多久 */
  private trial: { previous: number; average: number } | null = null;
  private givenUp = false;
  private skip = WARM_UP;

  constructor(start: number) {
    this.ratio = start;
  }

  /** 报告刚画完的一帧距上一帧过了多久（秒）。返回 true 表示倍数变了，画面要按新的倍数重设大小。 */
  frame(elapsed: number): boolean {
    if (this.givenUp || elapsed > STALL) return false;
    if (this.skip > 0) {
      this.skip--;
      return false;
    }
    this.count++;
    this.total += elapsed;
    if (elapsed > LATE) this.late++;
    if (this.count < WINDOW) return false;

    const average = this.total / this.count;
    const mostlyLate = this.late > WINDOW / 2;
    this.count = this.late = this.total = 0;

    if (this.trial) {
      const { previous, average: before } = this.trial;
      this.trial = null;
      if (average > before * WORTH_IT) {
        this.ratio = previous;
        this.givenUp = true;
        return true;
      }
    }
    if (!mostlyLate) return false;
    const next = coarser(this.ratio);
    if (next >= this.ratio) return false;
    this.trial = { previous: this.ratio, average };
    this.ratio = next;
    this.skip = WARM_UP;
    return true;
  }
}
