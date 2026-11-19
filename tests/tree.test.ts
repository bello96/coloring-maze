// 选关树怎么排：纯几何，不碰页面。画出来的样子靠截图看，这里只查"排得对不对"。
import { describe, expect, it } from 'vitest';
import { layoutTree, MAX_BOARD } from '../src/ui/tree.ts';

/** 路径里出现的所有数字，两个一组就是一个个点 */
function pointsOf(path: string): Array<[number, number]> {
  const nums = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

describe('laying out the tree', () => {
  it('is at most 560 pixels wide', () => {
    expect(MAX_BOARD).toBe(560);
  });

  it('has one spot per level, the first level lowest and each next one higher', () => {
    const tree = layoutTree(80, 560);
    expect(tree.width).toBe(560);
    expect(tree.spots).toHaveLength(80);
    expect(tree.branches).toHaveLength(80);
    expect(tree.leaves).toHaveLength(80);
    for (let i = 1; i < 80; i++) expect(tree.spots[i].y, `第 ${i + 1} 关`).toBeLessThan(tree.spots[i - 1].y);
    expect(tree.height).toBeGreaterThan(tree.spots[0].y + tree.radius);
    expect(tree.spots[79].y).toBeGreaterThan(tree.radius);
  });

  it('puts the levels on alternating sides of the trunk', () => {
    const tree = layoutTree(80, 560);
    tree.spots.forEach((spot, i) => {
      expect(spot.side, `第 ${i + 1} 关`).toBe(i % 2 === 0 ? -1 : 1);
      // 往左伸的在木板左半边，往右伸的在右半边
      expect(Math.sign(spot.x - 280), `第 ${i + 1} 关`).toBe(spot.side);
    });
  });

  it.each([560, 390, 320])('keeps every disc well inside a board %i pixels wide, and apart from its neighbours', (width) => {
    const tree = layoutTree(80, width);
    tree.spots.forEach((spot, i) => {
      expect(spot.x - tree.radius, `第 ${i + 1} 关`).toBeGreaterThanOrEqual(10);
      expect(spot.x + tree.radius, `第 ${i + 1} 关`).toBeLessThanOrEqual(width - 10);
      if (i > 0) {
        const prev = tree.spots[i - 1];
        expect(Math.hypot(spot.x - prev.x, spot.y - prev.y), `第 ${i} 关和第 ${i + 1} 关`).toBeGreaterThanOrEqual(70);
      }
      // 同一边上下相邻的两关之间，放得下木片下面的星星和步数
      if (i > 1) expect(tree.spots[i - 2].y - spot.y, `第 ${i - 1} 关和第 ${i + 1} 关`).toBeGreaterThanOrEqual(tree.radius * 2 + 60);
    });
  });

  it('keeps the centres of the discs at least 40 pixels from the edge on a phone', () => {
    for (const spot of layoutTree(80, 390).spots) {
      expect(spot.x).toBeGreaterThanOrEqual(40);
      expect(spot.x).toBeLessThanOrEqual(350);
    }
  });

  it('draws a trunk from below the first level to above the last, with a branch out to every level', () => {
    const tree = layoutTree(80, 560);
    expect(tree.trunk).toMatch(/^M/);
    const trunk = pointsOf(tree.trunk);
    const ys = trunk.map(([, y]) => y);
    expect(Math.max(...ys)).toBeGreaterThan(tree.spots[0].y);
    expect(Math.min(...ys)).toBeLessThan(tree.spots[79].y);
    // 树干在两列木片之间，不会从木片底下穿过去
    for (const [x] of trunk) {
      expect(x).toBeGreaterThan(tree.spots[0].x + tree.radius);
      expect(x).toBeLessThan(tree.spots[1].x - tree.radius);
    }
    tree.branches.forEach((branch, i) => {
      expect(branch, `第 ${i + 1} 关`).toMatch(/^M/);
      const points = pointsOf(branch);
      const [endX, endY] = points[points.length - 1];
      // 枝杈的那一头在木片底下
      expect(Math.hypot(endX - tree.spots[i].x, endY - tree.spots[i].y), `第 ${i + 1} 关`).toBeLessThanOrEqual(tree.radius);
    });
  });

  it('keeps everything it draws inside the board', () => {
    for (const width of [560, 390, 320]) {
      const tree = layoutTree(80, width);
      const all = [tree.trunk, tree.roots, tree.crown, ...tree.branches, ...tree.leaves].flatMap(pointsOf);
      expect(all.length).toBeGreaterThan(500);
      for (const [x, y] of all) {
        expect(x, `宽 ${width}`).toBeGreaterThanOrEqual(0);
        expect(x, `宽 ${width}`).toBeLessThanOrEqual(width);
        expect(y, `宽 ${width}`).toBeGreaterThanOrEqual(0);
        expect(y, `宽 ${width}`).toBeLessThanOrEqual(tree.height);
      }
    }
  });

  it.each([560, 390, 320])('gives each level leaves of its own, nearer to its disc than to any other (board %i wide)', (width) => {
    const tree = layoutTree(12, width);
    const far = (x: number, y: number, i: number): number => Math.hypot(x - tree.spots[i].x, y - tree.spots[i].y);
    tree.leaves.forEach((leaf, i) => {
      const points = pointsOf(leaf);
      expect(points.length, `第 ${i + 1} 关`).toBeGreaterThan(4);
      for (const [x, y] of points) {
        const own = far(x, y, i);
        // 叶子长在木片外面，不会压在木片上
        expect(own, `第 ${i + 1} 关`).toBeGreaterThan(tree.radius);
        for (let other = 0; other < tree.spots.length; other++) {
          if (other !== i) expect(far(x, y, other), `第 ${i + 1} 关的叶子和第 ${other + 1} 关`).toBeGreaterThan(own);
        }
      }
    });
  });

  it('is the same tree every time', () => {
    expect(layoutTree(80, 390)).toEqual(layoutTree(80, 390));
  });

  it('is as long as the levels need: one level is a short board, 200 a very long one', () => {
    const one = layoutTree(1, 560);
    expect(one.spots).toHaveLength(1);
    expect(one.height).toBeGreaterThan(200);
    expect(one.height).toBeLessThan(600);
    expect(pointsOf(one.trunk).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    const many = layoutTree(200, 320);
    expect(many.spots).toHaveLength(200);
    expect(many.height).toBeGreaterThan(200 * 70);
    for (const spot of many.spots) {
      expect(spot.x - many.radius).toBeGreaterThanOrEqual(10);
      expect(spot.x + many.radius).toBeLessThanOrEqual(310);
    }
    expect(layoutTree(0, 560).spots).toHaveLength(0);
  });
});
