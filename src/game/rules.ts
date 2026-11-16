import { STEP, type Dir, type Level } from './level.ts';

/** 往一个方向滚到头：停在哪一格，以及一路滚过的格子（不含出发的那格） */
export interface Slide {
  readonly to: number;
  readonly path: readonly number[];
}

/** 走过的一步 */
export interface Move {
  readonly dir: Dir;
  readonly from: number;
  readonly to: number;
  /** 这一步滚过的格子，按先后顺序，不含出发的那格 */
  readonly path: readonly number[];
  /** 其中这一步才染上色的格子 */
  readonly fresh: readonly number[];
}

/** 一局游戏的全部状态 */
export interface Game {
  readonly level: Level;
  pos: number;
  /** 每格一个数：1 是已经染上色 */
  readonly dyed: Uint8Array;
  dyedCount: number;
  /** 走过的每一步，撤销时从最后一步往回退 */
  readonly moves: Move[];
}

/** 小球从 from 往 dir 滚：一直滚到下一格是墙或棋盘外面为止。 */
export function slide(level: Level, from: number, dir: Dir): Slide {
  const [dr, dc] = STEP[dir];
  let r = Math.floor(from / level.cols);
  let c = from % level.cols;
  const path: number[] = [];
  for (;;) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr >= level.rows || nc < 0 || nc >= level.cols) break;
    const next = nr * level.cols + nc;
    if (!level.floor[next]) break;
    path.push(next);
    r = nr;
    c = nc;
  }
  return { to: r * level.cols + c, path };
}

/** 开一局：小球放在起点，起点那一格算已经染上。 */
export function newGame(level: Level): Game {
  const dyed = new Uint8Array(level.rows * level.cols);
  dyed[level.start] = 1;
  return { level, pos: level.start, dyed, dyedCount: 1, moves: [] };
}

/** 已经走了几步 */
export function steps(game: Game): number {
  return game.moves.length;
}

/** 所有地面都染上了 */
export function isDone(game: Game): boolean {
  return game.dyedCount === game.level.floorCount;
}

/**
 * 往 dir 滚一步。滚得动就算一步，返回这一步的记录；
 * 紧挨着墙、一格也滚不动时什么都不变，返回 null（不算步数）。
 */
export function roll(game: Game, dir: Dir): Move | null {
  const { to, path } = slide(game.level, game.pos, dir);
  if (path.length === 0) return null;
  const fresh: number[] = [];
  for (const cell of path) {
    if (!game.dyed[cell]) {
      game.dyed[cell] = 1;
      fresh.push(cell);
    }
  }
  game.dyedCount += fresh.length;
  const move: Move = { dir, from: game.pos, to, path, fresh };
  game.pos = to;
  game.moves.push(move);
  return move;
}

/** 撤销最后一步：小球回到那一步之前的位置，那一步新染的格子恢复原样。没有可撤销的返回 null。 */
export function undo(game: Game): Move | null {
  const move = game.moves.pop();
  if (!move) return null;
  for (const cell of move.fresh) game.dyed[cell] = 0;
  game.dyedCount -= move.fresh.length;
  game.pos = move.from;
  return move;
}
