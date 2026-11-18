/** 滚动方向：上、右、下、左 */
export type Dir = 'U' | 'R' | 'D' | 'L';

export const DIRS: readonly Dir[] = ['U', 'R', 'D', 'L'];

/** 每个方向走一格，行、列各变多少 */
export const STEP: Readonly<Record<Dir, readonly [dRow: number, dCol: number]>> = {
  U: [-1, 0],
  R: [0, 1],
  D: [1, 0],
  L: [0, -1],
};

/** 一关的迷宫。格子编号 = 行 × cols + 列，左上角是 0。 */
export interface Level {
  readonly rows: number;
  readonly cols: number;
  /** 每格一个数：1 是能滚过去的地面，0 是墙 */
  readonly floor: Uint8Array;
  /** 小球出发的格子 */
  readonly start: number;
  /** 地面一共多少格，全部染上就过关 */
  readonly floorCount: number;
}

/** 关卡表里的一关：字符画，加上求解器算好的最少步数和一种最少步数的走法 */
export interface LevelDef {
  readonly rows: readonly string[];
  readonly par: number;
  readonly solution: string;
}

/**
 * 把一关沿左上到右下的对角线翻过来：行变成列，列变成行。
 * 玩法一点没变（最少步数相同，原来的"上"变成"左"、"下"变成"右"），只是横竖对调了——
 * 长方形的关卡靠它在宽屏上横着摆、在竖屏上竖着摆。
 */
export function transposeDef(def: LevelDef): LevelDef {
  const turned: Readonly<Record<string, Dir>> = { U: 'L', L: 'U', D: 'R', R: 'D' };
  return {
    rows: Array.from({ length: def.rows[0].length }, (_, c) => def.rows.map((row) => row[c]).join('')),
    par: def.par,
    solution: [...def.solution].map((ch) => turned[ch]).join(''),
  };
}

/**
 * 把字符画读成一关：`#` 是墙，`.` 是地面，`S` 是小球出发的那格地面。
 * 每行一个字符串，所有行必须一样长，`S` 必须正好一个。
 */
export function parseLevel(rows: readonly string[]): Level {
  const cols = rows[0]?.length ?? 0;
  if (cols === 0) throw new Error('迷宫是空的');
  const floor = new Uint8Array(rows.length * cols);
  let start = -1;
  let floorCount = 0;
  rows.forEach((row, r) => {
    if (row.length !== cols) throw new Error(`第 ${r + 1} 行的长度和第 1 行不一样`);
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      if (ch === '#') continue;
      if (ch !== '.' && ch !== 'S') throw new Error(`第 ${r + 1} 行有不认识的字符 "${ch}"`);
      const cell = r * cols + c;
      floor[cell] = 1;
      floorCount++;
      if (ch === 'S') {
        if (start >= 0) throw new Error('迷宫里有不止一个起点 S');
        start = cell;
      }
    }
  });
  if (start < 0) throw new Error('迷宫里没有起点 S');
  return { rows: rows.length, cols, floor, start, floorCount };
}
