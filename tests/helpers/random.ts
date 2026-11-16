/** 可重复的随机数（mulberry32）：同一个种子每次给出同一串数，测试才能复现 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机撒墙的小迷宫，起点随机挑一格地面。不保证能通关——测试正好两种都要。 */
export function randomMaze(rand: () => number, rows: number, cols: number, wallChance: number): string[] {
  for (;;) {
    const cells: string[] = [];
    for (let i = 0; i < rows * cols; i++) cells.push(rand() < wallChance ? '#' : '.');
    const floors = cells.flatMap((ch, i) => (ch === '.' ? [i] : []));
    if (floors.length === 0) continue;
    cells[floors[Math.floor(rand() * floors.length)]] = 'S';
    const out: string[] = [];
    for (let r = 0; r < rows; r++) out.push(cells.slice(r * cols, (r + 1) * cols).join(''));
    return out;
  }
}
