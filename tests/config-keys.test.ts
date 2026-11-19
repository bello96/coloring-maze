// 配置页画笔的快捷键：W 墙、F 地面、S 起点。
import { describe, expect, it } from 'vitest';
import { brushForKey } from '../src/config/keys.ts';

/** 一下普通的按键：没按着别的键，也没在输入框里 */
const press = (key: string, code: string, more: Partial<Parameters<typeof brushForKey>[0]> = {}): ReturnType<typeof brushForKey> =>
  brushForKey({ key, code, ctrlKey: false, metaKey: false, altKey: false, ...more }, false);

describe('the brush shortcuts of the level editor', () => {
  it('pick the wall brush with W, the floor brush with F and the start brush with S', () => {
    expect(press('w', 'KeyW')).toBe('wall');
    expect(press('f', 'KeyF')).toBe('floor');
    expect(press('s', 'KeyS')).toBe('start');
  });

  it('work the same with caps lock on or shift held', () => {
    expect(press('W', 'KeyW')).toBe('wall');
    expect(press('F', 'KeyF')).toBe('floor');
    expect(press('S', 'KeyS')).toBe('start');
  });

  it('go by where the key sits when a Chinese input method keeps the letter to itself', () => {
    // 输入法开着的时候，浏览器报上来的字符是 "Process"，只有键的位置还认得出
    expect(press('Process', 'KeyW')).toBe('wall');
    expect(press('Process', 'KeyF')).toBe('floor');
    expect(press('Process', 'KeyS')).toBe('start');
  });

  it('leave the shortcuts of the browser alone', () => {
    // Ctrl+S 存网页、Ctrl+W 关标签页、Ctrl+F 查找，Mac 上是 ⌘；Alt+F 开菜单
    expect(press('s', 'KeyS', { ctrlKey: true })).toBeNull();
    expect(press('w', 'KeyW', { metaKey: true })).toBeNull();
    expect(press('f', 'KeyF', { altKey: true })).toBeNull();
  });

  it('do nothing while something is being typed into a box', () => {
    for (const [key, code] of [
      ['w', 'KeyW'],
      ['f', 'KeyF'],
      ['s', 'KeyS'],
    ]) {
      expect(brushForKey({ key, code, ctrlKey: false, metaKey: false, altKey: false }, true)).toBeNull();
    }
  });

  it('ignore every other key', () => {
    expect(press('a', 'KeyA')).toBeNull();
    expect(press('Enter', 'Enter')).toBeNull();
    expect(press('ArrowUp', 'ArrowUp')).toBeNull();
    expect(press('1', 'Digit1')).toBeNull();
    expect(press(' ', 'Space')).toBeNull();
    // 别的布局上同一个位置打出来的是别的字母：以打出来的字母为准，位置只在认不出字母时才看
    expect(press('z', 'KeyW')).toBeNull();
  });
});
