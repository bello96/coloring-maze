// 配置页画笔的快捷键：W 墙、F 地面、S 起点。纯逻辑，只管"这一下按键算不算、算哪支画笔"。

export type Brush = 'wall' | 'floor' | 'start';

const BY_LETTER: Readonly<Record<string, Brush>> = { w: 'wall', f: 'floor', s: 'start' };

/** 判断用得上的那一点按键信息（浏览器的 KeyboardEvent 就是这样的） */
export interface KeyPress {
  /** 打出来的字符，比如 "w"、"W"；不是字符的键是它的名字，比如 "Enter" */
  readonly key: string;
  /** 键在键盘上的位置，比如 "KeyW" */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * 这一下按键该换成哪支画笔；不是画笔的快捷键、或者这时不该管，返回 null。
 * 按着 Ctrl、⌘、Alt 的是浏览器自己的快捷键（存网页、关标签页、查找），不碰。
 * 认的是打出来的字母，大小写都行；中文输入法开着时字母被它收走了（报上来的是 "Process"），这时才看键的位置。
 * @param typing 焦点在输入框里（正在输大小、输口令）：这时字母键不是给画笔的
 */
export function brushForKey(press: KeyPress, typing: boolean): Brush | null {
  if (typing || press.ctrlKey || press.metaKey || press.altKey) return null;
  const letter = press.key.length === 1 ? press.key.toLowerCase() : /^Key([A-Z])$/.exec(press.code)?.[1].toLowerCase();
  return (letter !== undefined && BY_LETTER[letter]) || null;
}
