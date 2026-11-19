// 关卡的地址：第 12 关是 /12。
import { describe, expect, it } from 'vitest';
import { levelOfPath, pathOfLevel } from '../src/game/route.ts';

describe('the address of a level', () => {
  it('is its number right after the slash', () => {
    expect(pathOfLevel(1)).toBe('/1');
    expect(pathOfLevel(12)).toBe('/12');
    expect(pathOfLevel(80)).toBe('/80');
  });

  it('is read back as that number', () => {
    expect(levelOfPath('/1')).toBe(1);
    expect(levelOfPath('/12')).toBe(12);
    expect(levelOfPath('/200')).toBe(200);
  });

  it('is still understood with a slash at the end or zeros in front', () => {
    expect(levelOfPath('/12/')).toBe(12);
    expect(levelOfPath('/012')).toBe(12);
  });

  it.each(['/', '', '/0', '/00', '/-3', '/1.5', '/abc', '/12abc', '/a12', '/12/3', '/config', '/index.html', '/1234567', '12'])(
    'reads %j as no level at all',
    (path) => {
      expect(levelOfPath(path)).toBe(0);
    },
  );
});
