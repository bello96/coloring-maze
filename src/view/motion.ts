/** 一次滚动里"滚了多远"随时间的变化 */
export interface RollProfile {
  /** 从起步到撞上墙一共多久（秒） */
  readonly duration: number;
  /** 撞墙那一刻的速度 */
  readonly endSpeed: number;
  /** 起步后 t 秒滚了多远 */
  at(t: number): number;
  /** 滚到 distance 这么远是起步后第几秒 */
  timeAt(distance: number): number;
}

/**
 * 小球被推了一下：先匀加速，到了最高速度就保持，一直到撞墙（撞之前不减速）。
 * 距离短的话还没加到最高速度就撞上了。
 */
export function rollProfile(distance: number, accel: number, topSpeed: number): RollProfile {
  const rampTime = topSpeed / accel;
  const rampDist = 0.5 * accel * rampTime * rampTime;
  const short = distance <= rampDist;
  const duration = short ? Math.sqrt((2 * distance) / accel) : rampTime + (distance - rampDist) / topSpeed;
  return {
    duration,
    endSpeed: short ? accel * duration : topSpeed,
    at(t) {
      if (t <= 0) return 0;
      if (t >= duration) return distance;
      if (short || t < rampTime) return 0.5 * accel * t * t;
      return rampDist + topSpeed * (t - rampTime);
    },
    timeAt(d) {
      if (d <= 0) return 0;
      if (d >= distance) return duration;
      if (short || d < rampDist) return Math.sqrt((2 * d) / accel);
      return rampTime + (d - rampDist) / topSpeed;
    },
  };
}

/** 撞墙后弹回的力度：弹回速度 = 撞墙速度 × 这个数 */
const BOUNCE = 0.35;
/** 回到格子中间的那股"劲"有多快（弧度/秒）和衰减得多快 */
const SETTLE_RATE = 34;
const SETTLE_DAMPING = 0.45;

/**
 * 撞墙之后小球的位置：相对它最后停稳的地方（格子正中）偏了多少，正数是朝墙那边。
 * 撞上的那一刻（t = 0）在 offset 处贴着墙，以 speed 的一部分速度弹回，晃一小下后停稳。
 */
export function settle(t: number, offset: number, speed: number): number {
  if (t <= 0) return offset;
  const w = SETTLE_RATE;
  const z = SETTLE_DAMPING;
  const wd = w * Math.sqrt(1 - z * z);
  const v0 = -BOUNCE * speed;
  const b = (v0 + z * w * offset) / wd;
  return Math.exp(-z * w * t) * (offset * Math.cos(wd * t) + b * Math.sin(wd * t));
}
