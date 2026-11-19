// 关卡的地址：第 12 关是 /12，网站的根地址 / 不指定哪一关（进轮到的那一关，见 app.ts）。
// 地址栏里的数是从 1 数起的第几关，和玩家看到的"第 N 关"一样。

/** 第 number 关（从 1 数起）的地址 */
export function pathOfLevel(number: number): string {
  return `/${number}`;
}

/**
 * 这个地址写的是第几关（从 1 数起）；不是一关的地址（/、/abc、/0、/12/3……）返回 0。
 * 末尾多一个斜杠、数字前面多几个 0 都认；数字最多六位，再长的不当它是关号。
 */
export function levelOfPath(path: string): number {
  const found = /^\/0*(\d{1,6})\/?$/.exec(path);
  return found ? Number(found[1]) : 0;
}
