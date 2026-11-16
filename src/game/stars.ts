/**
 * 通关给几颗星：
 * - 3 星：用的正是最少步数；
 * - 2 星：比最少步数多走不超过四分之一（至少允许多走 2 步）；
 * - 1 星：只要通关就有。
 */
export function starsFor(steps: number, par: number): 1 | 2 | 3 {
  if (steps <= par) return 3;
  const slack = Math.max(2, Math.ceil(par * 0.25));
  return steps <= par + slack ? 2 : 1;
}
