/** 染料的颜色，按关卡轮着用：靛蓝、茜红、松绿、藤黄、紫、叶绿、玫红、湖蓝 */
const DYES: readonly number[] = [0x2646b8, 0xc0302b, 0x0e8a78, 0xdd8e10, 0x6f3bb5, 0x3f8f2e, 0xcf3f77, 0x1787c2];

/** 第 index 关（从 0 数起）用哪种染料 */
export function dyeOf(index: number): number {
  return DYES[index % DYES.length];
}

/** 写成 CSS 认识的颜色，例如 "#2646b8" */
export function dyeCss(index: number): string {
  return `#${dyeOf(index).toString(16).padStart(6, '0')}`;
}
