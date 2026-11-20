// 配置页的编辑模型：纯逻辑，不碰页面。
import { describe, expect, it } from 'vitest';
import { blankRows, draftsOf, maxSide, moved, moveStart, newDraft, newId, paint, resize, setOf, withRows, type Draft } from '../src/config/model.ts';
import { BUILTIN, checkLevelSet, DYES, sizeOk } from '../src/game/levelset.ts';
import { randomMaze, seeded } from './helpers/random.ts';

const ROWS = ['S....', '.....', '#####', '#####', '#####'];
const count = (rows: readonly string[], ch: string): number => rows.join('').split(ch).length - 1;

describe('drafts', () => {
  it('start out as the levels of the set, and turn back into the same set', () => {
    const drafts = draftsOf(BUILTIN);
    expect(drafts).toHaveLength(80);
    expect(drafts[0]).toEqual({ id: 'b01', rows: BUILTIN.levels[0].rows, dye: '#2646b8', par: 3, solution: 'ULD' });
    expect(setOf(drafts)).toEqual(BUILTIN);
  });

  it('cannot be made into a set while any level still lacks its fewest steps', () => {
    const drafts = draftsOf(BUILTIN);
    drafts[40] = { ...drafts[40], par: null, solution: null };
    expect(setOf(drafts)).toBeNull();
    expect(setOf(drafts, true)).toBeNull();
  });

  it('carry the open-all switch into the set only when it is on', () => {
    const drafts = draftsOf(BUILTIN);
    const on = setOf(drafts, true);
    expect(on).toEqual({ ...BUILTIN, openAll: true });
    expect(checkLevelSet(JSON.parse(JSON.stringify(on)))).toEqual({ ok: true, set: on });
    // 关着的时候关卡表里没有这一项，和加这个开关之前发布的一模一样
    const off = setOf(drafts, false);
    expect(off).toEqual(BUILTIN);
    expect(off !== null && 'openAll' in off).toBe(false);
    expect(JSON.stringify(setOf(drafts))).toBe(JSON.stringify(BUILTIN));
  });

  it('forget the fewest steps when the map changes, and get them back when it is changed back', () => {
    const entry = BUILTIN.levels[2];
    const draft = draftsOf(BUILTIN)[2];
    const edited = withRows(draft, paint(draft.rows, 0, '#'), entry);
    expect(edited.rows).not.toEqual(entry.rows);
    expect(edited).toMatchObject({ id: 'b03', dye: entry.dye, par: null, solution: null });
    // 改回和发布时一模一样：不用重算
    const back = withRows(edited, [...entry.rows], entry);
    expect(back).toEqual(draft);
  });

  it('have no fewest steps to get back when the level was never published', () => {
    const draft: Draft = { id: 'fresh1', rows: blankRows(), dye: DYES[0], par: 9, solution: 'RRRRRRRRR' };
    expect(withRows(draft, [...draft.rows])).toMatchObject({ par: null, solution: null });
  });

  it('are added as an empty 7×7 with the start in the corner, the next dye in turn and an id of their own', () => {
    const drafts = draftsOf(BUILTIN);
    const added = newDraft(drafts, seeded(5));
    expect(added.rows).toEqual(['S......', '.......', '.......', '.......', '.......', '.......', '.......']);
    expect(added).toMatchObject({ par: null, solution: null });
    expect(added.id).toMatch(/^[a-z0-9]{6}$/);
    expect(drafts.some((draft) => draft.id === added.id)).toBe(false);
    // 第 80 关用的是第 8 种染料，下一种轮回第 1 种
    expect(drafts[79].dye).toBe(DYES[7]);
    expect(added.dye).toBe(DYES[0]);
    expect(newDraft(drafts.slice(0, 3), seeded(5)).dye).toBe(DYES[3]);
    // 最后一关用的是自选的颜色：从第 1 种开始
    expect(newDraft([{ ...drafts[0], dye: '#123456' }], seeded(5)).dye).toBe(DYES[0]);
  });
});

describe('painting a cell', () => {
  it('turns floor into wall and wall into floor', () => {
    expect(paint(ROWS, 1, '#')).toEqual(['S#...', '.....', '#####', '#####', '#####']);
    expect(paint(ROWS, 10, '.')).toEqual(['S....', '.....', '.####', '#####', '#####']);
    expect(paint(ROWS, 24, '.')).toEqual(['S....', '.....', '#####', '#####', '####.']);
  });

  it('does not change the rows it was given', () => {
    const before = [...ROWS];
    paint(ROWS, 1, '#');
    expect(ROWS).toEqual(before);
  });

  it('gives back the very same rows when nothing changes', () => {
    expect(paint(ROWS, 1, '.')).toBe(ROWS);
    expect(paint(ROWS, 10, '#')).toBe(ROWS);
    expect(paint(ROWS, -1, '#')).toBe(ROWS);
    expect(paint(ROWS, 25, '#')).toBe(ROWS);
  });

  it('never paints over the start: there must always be exactly one', () => {
    expect(paint(ROWS, 0, '#')).toBe(ROWS);
    expect(paint(ROWS, 0, '.')).toBe(ROWS);
  });
});

describe('moving the start', () => {
  it('puts it on a floor cell and leaves plain floor where it was', () => {
    expect(moveStart(ROWS, 6)).toEqual(['.....', '.S...', '#####', '#####', '#####']);
  });

  it('does nothing on a wall, on the start itself, or outside the board', () => {
    expect(moveStart(ROWS, 10)).toBe(ROWS);
    expect(moveStart(ROWS, 0)).toBe(ROWS);
    expect(moveStart(ROWS, 99)).toBe(ROWS);
  });
});

describe('changing the size', () => {
  it('adds floor on the right and at the bottom when growing', () => {
    expect(resize(ROWS, 7, 6)).toEqual(['S.....', '......', '#####.', '#####.', '#####.', '......', '......']);
  });

  it('cuts off the right and the bottom when shrinking', () => {
    const rows = ['S.#....', '..#....', '###....', '.......', '.......', '.......', '......#'];
    expect(resize(rows, 5, 5)).toEqual(['S.#..', '..#..', '###..', '.....', '.....']);
  });

  it('moves the start to the first floor cell when the old one is cut off', () => {
    const rows = ['#......', '.......', '.......', '.......', '.......', '.......', '......S'];
    expect(resize(rows, 5, 5)).toEqual(['#S...', '.....', '.....', '.....', '.....']);
  });

  it('makes the corner the start when no floor is left at all', () => {
    const rows = ['#####.S', '#####..', '#####..', '#####..', '#####..', '.......', '.......'];
    expect(resize(rows, 5, 5)).toEqual(['S####', '#####', '#####', '#####', '#####']);
  });

  it('keeps the same rows when the size stays the same', () => {
    expect(resize(ROWS, 5, 5)).toEqual(ROWS);
  });

  it('always leaves exactly one start and keeps whatever of the old map still fits (200 random maps)', () => {
    const rand = seeded(31);
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    for (let i = 0; i < 200; i++) {
      const rows = randomMaze(rand, int(5, 12), int(5, 12), rand() * 0.9);
      const [toRows, toCols] = [int(5, 12), int(5, 12)];
      const out = resize(rows, toRows, toCols);
      const where = `${rows.join('/')} → ${toRows}×${toCols}`;
      expect(out, where).toHaveLength(toRows);
      expect(out.every((row) => row.length === toCols), where).toBe(true);
      expect(count(out, 'S'), where).toBe(1);
      expect(/^[#.S]+$/.test(out.join('')), where).toBe(true);
      // 墙和地面：新旧都有的那一块里一格不变（起点挪了地方的那一格除外），多出来的全是地面
      for (let r = 0; r < toRows; r++) {
        for (let c = 0; c < toCols; c++) {
          const now = out[r][c] === '#' ? '#' : '.';
          const was = r < rows.length && c < rows[0].length ? (rows[r][c] === '#' ? '#' : '.') : '.';
          if (now !== was) expect(out[r][c], `${where} 第 ${r} 行第 ${c} 列`).toBe('S');
        }
      }
    }
  });
});

describe('how long a side may be', () => {
  it('is 25 while the other side is at most 20, and 20 once the other side is longer', () => {
    expect([maxSide(5), maxSide(20), maxSide(21), maxSide(25)]).toEqual([25, 25, 20, 20]);
    for (let other = 5; other <= 25; other++) {
      expect(sizeOk(other, maxSide(other)), `另一边 ${other}`).toBe(true);
      expect(sizeOk(other, maxSide(other) + 1), `另一边 ${other}`).toBe(false);
    }
  });
});

describe('a new id', () => {
  it('is six lower-case letters or digits', () => {
    const rand = seeded(3);
    for (let i = 0; i < 50; i++) expect(newId(new Set(), rand)).toMatch(/^[a-z0-9]{6}$/);
  });

  it('is never one that is already taken', () => {
    // 随机数先给出一串全是 "a" 的，再给出全是 "b" 的
    let calls = 0;
    const rand = (): number => (calls++ < 6 ? 0 : 1 / 36 + 1e-9);
    expect(newId(new Set(['aaaaaa']), rand)).toBe('bbbbbb');
  });

  it('passes the check that level ids go through', () => {
    const id = newId(new Set(), seeded(8));
    const set = { version: 1, levels: [{ ...BUILTIN.levels[0], id }] };
    expect(checkLevelSet(set).ok).toBe(true);
  });
});

describe('moving a level to another place in the list', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('takes it out and puts it in at the new position', () => {
    expect(moved(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moved(list, 1, 3)).toEqual(['a', 'c', 'd', 'b']);
    expect(moved(list, 2, 2)).toEqual(list);
  });

  it('does not change the list it was given, and ignores positions that do not exist', () => {
    moved(list, 0, 3);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
    expect(moved(list, 7, 0)).toEqual(list);
    expect(moved(list, 0, -1)).toEqual(list);
  });
});
