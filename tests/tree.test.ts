// 选关树怎么排：纯几何，不碰页面。画出来的样子靠截图看，这里只查"排得对不对"。
import { describe, expect, it } from 'vitest';
import { DYES } from '../src/game/levelset.ts';
import { inkOn, layoutTree, leafEngraving, leafOutline, MAX_BOARD, tintOf, type Spot, type TreeLayout } from '../src/ui/tree.ts';

type Point = [number, number];

/** 路径里出现的所有数字，两个一组就是一个个点 */
function pointsOf(path: string): Point[] {
  const nums = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

/** 路径里一段一段闭合的线，各是哪些点 */
const ringsOf = (path: string): Point[][] => path.split('M').filter(Boolean).map(pointsOf);

/** 一圈点在高度 y 处从左到右占了多宽；这个高度上没有它就是 null */
function spanAt(ring: readonly Point[], y: number): [number, number] | null {
  let left = Infinity;
  let right = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    if ((y0 - y) * (y1 - y) > 0 || y0 === y1) continue;
    const x = x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
    left = Math.min(left, x);
    right = Math.max(right, x);
  }
  return left <= right ? [left, right] : null;
}

/** 叶片朝哪个方向伸（屏幕上往上是负的） */
const heading = (spot: Spot): Point => [spot.side * Math.cos(spot.tilt), -Math.sin(spot.tilt)];
/** 叶片上的一点：沿着叶片从叶柄（along = 0）到叶尖（along = 1），再往旁边偏 across 个半宽 */
function onLeaf(tree: TreeLayout, spot: Spot, along: number, across: number): Point {
  const [dx, dy] = heading(spot);
  const far = (along - 0.48) * tree.leaf.long;
  const off = across * tree.leaf.half;
  return [spot.x + dx * far - dy * off, spot.y + dy * far + dx * off];
}
/** 叶片轮廓上的一圈点（照着 leafOutline 的形状，取叶柄、叶尖和两侧最宽、次宽的几处） */
const leafRim = (tree: TreeLayout, spot: Spot): Point[] =>
  ([[0, 0], [0.22, -1], [0.43, -1], [0.7, -0.8], [1, 0], [0.7, 0.8], [0.43, 1], [0.22, 1]] as const).map(([along, across]) => onLeaf(tree, spot, along, across));
/** 这一点是不是落在叶片上（叶片当成一个略小一圈的椭圆） */
function underLeaf(tree: TreeLayout, spot: Spot, [x, y]: Point): boolean {
  const [dx, dy] = heading(spot);
  // 椭圆的正中在叶柄到叶尖的一半处
  const cx = spot.x + dx * 0.02 * tree.leaf.long;
  const cy = spot.y + dy * 0.02 * tree.leaf.long;
  const along = ((x - cx) * dx + (y - cy) * dy) / (tree.leaf.long * 0.5);
  const across = (-(x - cx) * dy + (y - cy) * dx) / tree.leaf.half;
  return along * along + across * across < 0.7;
}

describe('laying out the tree', () => {
  it('is at most 560 pixels wide', () => {
    expect(MAX_BOARD).toBe(560);
  });

  it('has one leaf per level, the first level lowest and each next one higher', () => {
    const tree = layoutTree(80, 560);
    expect(tree.width).toBe(560);
    expect(tree.spots).toHaveLength(80);
    expect(tree.branches).toHaveLength(80);
    expect(tree.leaves).toHaveLength(80);
    for (let i = 1; i < 80; i++) expect(tree.spots[i].y, `第 ${i + 1} 关`).toBeLessThan(tree.spots[i - 1].y);
    // 第 1 关下面有树根的地方，最后一关上面有树梢的地方
    expect(tree.height - tree.spots[0].y).toBeGreaterThan(150);
    expect(tree.spots[79].y).toBeGreaterThan(150);
  });

  it('puts the levels on alternating sides of the trunk, each leaf pointing outwards and a little upwards', () => {
    const tree = layoutTree(80, 560);
    tree.spots.forEach((spot, i) => {
      expect(spot.side, `第 ${i + 1} 关`).toBe(i % 2 === 0 ? -1 : 1);
      // 往左伸的在木板左半边，往右伸的在右半边
      expect(Math.sign(spot.x - 280), `第 ${i + 1} 关`).toBe(spot.side);
      // 叶尖比叶柄离中线远，也比叶柄高
      const stalk = onLeaf(tree, spot, 0, 0);
      const tip = onLeaf(tree, spot, 1, 0);
      expect(Math.abs(tip[0] - 280), `第 ${i + 1} 关`).toBeGreaterThan(Math.abs(stalk[0] - 280));
      expect(tip[1], `第 ${i + 1} 关`).toBeLessThan(stalk[1]);
      expect(spot.tilt, `第 ${i + 1} 关`).toBeGreaterThan(0.2);
      expect(spot.tilt, `第 ${i + 1} 关`).toBeLessThan(0.5);
    });
  });

  it('uses a smaller leaf on a narrow board, and one that still holds three digits', () => {
    expect(layoutTree(80, 560).leaf).toEqual({ long: 92, half: 30 });
    expect(layoutTree(80, 480).leaf).toEqual({ long: 92, half: 30 });
    expect(layoutTree(80, 390).leaf).toEqual({ long: 80, half: 26 });
    expect(layoutTree(80, 320).leaf.half * 2).toBeGreaterThanOrEqual(48);
  });

  it.each([560, 390, 320])('keeps every leaf inside a board %i pixels wide, clear of the trunk and apart from its neighbours', (width) => {
    for (const count of [80, 200, 7]) {
      const tree = layoutTree(count, width);
      const trunk = ringsOf(tree.trunk)[0];
      tree.spots.forEach((spot, i) => {
        const where = `${count} 关里的第 ${i + 1} 关`;
        for (const [x, y] of leafRim(tree, spot)) {
          expect(x, where).toBeGreaterThanOrEqual(6);
          expect(x, where).toBeLessThanOrEqual(width - 6);
          // 叶片不压在树干上
          const span = spanAt(trunk, y);
          if (span) expect(spot.side < 0 ? span[0] - x : x - span[1], where).toBeGreaterThan(4);
        }
        // 同一边上下相邻的两关之间，放得下叶片、它下面的星星和步数
        if (i > 1) expect(tree.spots[i - 2].y - spot.y, where).toBeGreaterThanOrEqual(tree.leaf.half * 2 + 90);
        // 左右相邻的两关不会并排在同一个高度上
        if (i > 0) expect(tree.spots[i - 1].y - spot.y, where).toBeGreaterThanOrEqual(70);
      });
    }
  });

  it('keeps the middle of every leaf, where it is pressed, at least 50 pixels from the edge on a phone', () => {
    for (const width of [390, 320]) {
      for (const spot of layoutTree(80, width).spots) {
        expect(spot.x, `宽 ${width}`).toBeGreaterThanOrEqual(50);
        expect(spot.x, `宽 ${width}`).toBeLessThanOrEqual(width - 50);
      }
    }
  });

  it('draws a trunk from below the first level to above the last, thick at the foot and thinner towards the top', () => {
    for (const width of [560, 390, 320]) {
      const tree = layoutTree(80, width);
      expect(tree.trunk).toMatch(/^M.*Z$/);
      const trunk = ringsOf(tree.trunk)[0];
      const ys = trunk.map(([, y]) => y);
      expect(Math.max(...ys)).toBeGreaterThan(tree.spots[0].y + 80);
      expect(Math.min(...ys)).toBeLessThan(tree.spots[79].y - 60);
      const thick = (y: number): number => {
        const span = spanAt(trunk, y)!;
        return span[1] - span[0];
      };
      const low = thick(tree.spots[0].y);
      const middle = thick(tree.spots[40].y);
      const high = thick(tree.spots[79].y);
      // 一棵大树：树脚粗得像树干，不是一根藤；但也不占掉木板的五分之一以上
      expect(low, `宽 ${width}`).toBeGreaterThan(width * 0.14);
      expect(low, `宽 ${width}`).toBeLessThanOrEqual(width * 0.22);
      expect(middle, `宽 ${width}`).toBeLessThan(low);
      expect(high, `宽 ${width}`).toBeLessThan(middle);
      // 到了树梢也还是一根树干
      expect(high, `宽 ${width}`).toBeGreaterThan(18);
      // 树干在木板中间，不歪到一边去
      for (const [x] of trunk) expect(Math.abs(x - width / 2), `宽 ${width}`).toBeLessThan(width * 0.2);
    }
  });

  it('grows a thicker trunk for more levels', () => {
    const footOf = (count: number): number => {
      const tree = layoutTree(count, 560);
      const span = spanAt(ringsOf(tree.trunk)[0], tree.spots[0].y)!;
      return span[1] - span[0];
    };
    expect(footOf(3)).toBeLessThan(footOf(20));
    expect(footOf(20)).toBeLessThan(footOf(80));
    // 关再多也有个头
    expect(footOf(200)).toBeLessThanOrEqual(560 * 0.22);
  });

  it('spreads roots out below the foot of the trunk, on both sides', () => {
    for (const width of [560, 390, 320]) {
      const tree = layoutTree(80, width);
      const roots = ringsOf(tree.roots);
      expect(roots.length).toBeGreaterThanOrEqual(4);
      const all = roots.flat();
      // 树根在第 1 关的下面，往两边都伸出去，比树干宽
      const trunk = spanAt(ringsOf(tree.trunk)[0], tree.spots[0].y)!;
      expect(Math.min(...all.map(([x]) => x)), `宽 ${width}`).toBeLessThan(trunk[0] - 30);
      expect(Math.max(...all.map(([x]) => x)), `宽 ${width}`).toBeGreaterThan(trunk[1] + 30);
      expect(Math.max(...all.map(([, y]) => y)), `宽 ${width}`).toBeGreaterThan(tree.spots[0].y + 120);
      expect(Math.min(...all.map(([, y]) => y)), `宽 ${width}`).toBeGreaterThan(tree.spots[0].y + 60);
    }
  });

  it.each([560, 390, 320])('grows a branch out of the trunk to the stalk of every leaf (board %i wide)', (width) => {
    const tree = layoutTree(80, width);
    const trunk = ringsOf(tree.trunk)[0];
    const inTrunk = ([x, y]: Point): boolean => {
      const span = spanAt(trunk, y);
      return span !== null && x > span[0] && x < span[1];
    };
    tree.branches.forEach((branch, i) => {
      const where = `第 ${i + 1} 关`;
      expect(branch, where).toMatch(/^M.*Z$/);
      const points = pointsOf(branch);
      // 一头在树干里面
      expect(points.some(inTrunk), where).toBe(true);
      // 另一头接到叶片的叶柄上
      const stalk = onLeaf(tree, tree.spots[i], 0, 0);
      expect(Math.min(...points.map(([x, y]) => Math.hypot(x - stalk[0], y - stalk[1]))), where).toBeLessThan(3);
      // 枝是从叶片的下方往上长的
      expect(Math.max(...points.filter(inTrunk).map(([, y]) => y)), where).toBeGreaterThan(tree.spots[i].y + 30);
      // 除了叶柄那一小段，枝不从叶片底下穿过去
      const hidden = points.filter((point) => underLeaf(tree, tree.spots[i], point));
      for (const [x, y] of hidden) expect(Math.hypot(x - stalk[0], y - stalk[1]), where).toBeLessThan(tree.leaf.long * 0.3);
    });
  });

  it('is one piece of wood: the trunk, the roots, every branch and the twigs of the crown', () => {
    const tree = layoutTree(12, 560);
    expect(tree.wood.startsWith(tree.trunk)).toBe(true);
    expect(tree.wood).toContain(tree.roots);
    for (const branch of tree.branches) expect(tree.wood).toContain(branch);
    // 每一段都是闭合的，而且朝同一个方向绕：叠在一起才算一整块，不会互相挖出洞来
    const rings = ringsOf(tree.wood);
    expect(rings.length).toBeGreaterThan(12 + 5);
    expect(tree.wood.split('Z')).toHaveLength(rings.length + 1);
    for (const ring of rings) {
      let area = 0;
      ring.forEach(([x0, y0], k) => {
        const [x1, y1] = ring[(k + 1) % ring.length];
        area += x0 * y1 - x1 * y0;
      });
      expect(area).toBeGreaterThan(0);
    }
  });

  it('keeps everything it draws inside the board', () => {
    for (const width of [560, 390, 320]) {
      for (const count of [80, 3, 1, 0]) {
        const tree = layoutTree(count, width);
        const drawn = [tree.wood, tree.bark, tree.light, tree.limbLight, tree.limbShade, tree.crown, tree.veins, ...tree.shade, ...tree.leaves];
        const all = drawn.flatMap(pointsOf);
        expect(all.length).toBeGreaterThan(200);
        for (const [x, y] of all) {
          expect(x, `宽 ${width}、${count} 关`).toBeGreaterThanOrEqual(2);
          expect(x, `宽 ${width}、${count} 关`).toBeLessThanOrEqual(width - 2);
          expect(y, `宽 ${width}、${count} 关`).toBeGreaterThanOrEqual(2);
          expect(y, `宽 ${width}、${count} 关`).toBeLessThanOrEqual(tree.height - 2);
        }
      }
    }
  });

  it.each([560, 390, 320])('gives each level small leaves of its own, on its own branch and not under any big leaf (board %i wide)', (width) => {
    const tree = layoutTree(40, width);
    tree.leaves.forEach((leaves, i) => {
      const where = `第 ${i + 1} 关`;
      const each = ringsOf(leaves);
      expect(each.length, where).toBeGreaterThanOrEqual(2);
      for (const leaf of each) {
        expect(leaf.length, where).toBeGreaterThanOrEqual(6);
        for (const [x, y] of leaf) {
          // 长在自己这一关的枝上：和自己这一关在同一边，不高过叶片太多，也不低到下一根枝那里去
          expect(Math.sign(x - width / 2), where).toBe(tree.spots[i].side);
          expect(y, where).toBeGreaterThan(tree.spots[i].y - 70);
          expect(y, where).toBeLessThan(tree.spots[i].y + 130);
          // 不压在哪一关的大叶片底下
          for (const j of [i - 2, i, i + 2]) {
            if (j >= 0 && j < tree.spots.length) expect(underLeaf(tree, tree.spots[j], [x, y]), `${where}的小叶子和第 ${j + 1} 关的叶片`).toBe(false);
          }
        }
      }
    });
  });

  it('crowns the tree with a tuft of leaves above the last level', () => {
    const tree = layoutTree(80, 390);
    const crown = ringsOf(tree.crown);
    expect(crown.length).toBeGreaterThanOrEqual(10);
    const ys = crown.flat().map(([, y]) => y);
    expect(Math.max(...ys)).toBeLessThan(tree.spots[79].y - tree.leaf.half);
    expect(Math.min(...ys)).toBeGreaterThan(10);
  });

  it('is the same tree every time, and a different one for a different number of levels', () => {
    expect(layoutTree(80, 390)).toEqual(layoutTree(80, 390));
    // 前几关的叶片，不管后面还有多少关，左右、朝向都一样（只是整体的高度不同）
    const short = layoutTree(10, 390);
    const long = layoutTree(80, 390);
    short.spots.forEach((spot, i) => {
      expect(spot.side).toBe(long.spots[i].side);
      expect(spot.tilt).toBe(long.spots[i].tilt);
    });
  });

  it('is as long as the levels need: one level is a short board, 200 a very long one', () => {
    const one = layoutTree(1, 560);
    expect(one.spots).toHaveLength(1);
    expect(one.height).toBeGreaterThan(300);
    expect(one.height).toBeLessThan(600);
    expect(pointsOf(one.wood).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    const many = layoutTree(200, 320);
    expect(many.spots).toHaveLength(200);
    expect(many.height).toBeGreaterThan(200 * 70);
    const none = layoutTree(0, 560);
    expect(none.spots).toHaveLength(0);
    expect(none.branches).toHaveLength(0);
    expect(pointsOf(none.wood).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});

describe('the leaf a level number is written on', () => {
  it('is a closed outline inside its own box, from the stalk on the left to a point on the right', () => {
    for (const [long, half] of [[92, 30], [80, 26]] as const) {
      const outline = leafOutline(long, half);
      expect(outline).toMatch(/^M0 \d+C.*Z$/);
      const points = pointsOf(outline);
      expect(points[0]).toEqual([0, half]);
      expect(points.some(([x, y]) => x === long && y === half)).toBe(true);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(long);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(half * 2);
      }
      // 最宽的地方够宽：三位数的序号放得下
      expect(points.some(([, y]) => y === 0)).toBe(true);
      expect(points.some(([, y]) => y === half * 2)).toBe(true);
    }
  });

  it('has its veins and its edges drawn as one picture of the same size', () => {
    const picture = leafEngraving(92, 30);
    expect(picture).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 92 60'/);
    expect(picture).toContain(leafOutline(92, 30));
    // 一条主脉加五对侧脉
    expect(picture.match(/Q/g)).toHaveLength(10);
    // 要塞进样式表的 url("…") 里：不能有双引号
    expect(picture).not.toContain('"');
  });
});

describe('the dye on a leaf', () => {
  it('is the dye of the level with a little white mixed in', () => {
    expect(tintOf('#000000')).toBe('#333333');
    expect(tintOf('#ffffff')).toBe('#ffffff');
    expect(tintOf('#2646b8')).toBe('#516bc6');
    for (const dye of DYES) expect(tintOf(dye)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('takes pale lettering on the dark dyes and dark lettering on the pale one', () => {
    // 八种染料里只有藤黄是浅的
    expect(DYES.map(inkOn)).toEqual(['light', 'light', 'light', 'dark', 'light', 'light', 'light', 'light']);
    expect(inkOn('#ffffff')).toBe('dark');
    expect(inkOn('#ffe14d')).toBe('dark');
    expect(inkOn('#000000')).toBe('light');
    expect(inkOn('#808080')).toBe('light');
  });
});
