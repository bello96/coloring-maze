// 进门的口令弹层。口令记在这台电脑的浏览器里：下次打开先悄悄验一遍，还管用就不用再输。
import type { Verified } from './api.ts';

export const TOKEN_KEY = 'coloring-maze.admin-token';

/**
 * 口令里只能有看得见的 ASCII 字符（0x21–0x7E）。带了别的字符（比如中文）的口令放不进请求头——
 * 浏览器在发请求之前就会抛异常，这个请求根本发不出去。所以这样的口令不用问服务端，直接算不对。
 */
const SENDABLE = /^[\x21-\x7e]+$/;

const WRONG = '口令不对，请再试一次';
const UNREACHABLE = '连不上服务器，请稍后再试';

/** 记着的口令；没记、或者这个浏览器不让读，都是 null */
function recall(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function remember(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 记不下（比如无痕模式）就不记，下次打开再输一遍
  }
}

function forget(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 本来就没记下
  }
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class Gate {
  private readonly root = el('gate');
  private readonly input = el<HTMLInputElement>('gate-input');
  private readonly button = el<HTMLButtonElement>('gate-submit');
  private readonly error = el('gate-error');
  private readonly verify: (token: string) => Promise<Verified>;
  /** 弹层开着、等人输口令的时候：输对了交给谁 */
  private settle: ((token: string) => void) | null = null;
  /** 正在问服务端 */
  private asking = false;

  /** @param verify 问服务端这个口令对不对 */
  constructor(verify: (token: string) => Promise<Verified>) {
    this.verify = verify;
    this.input.form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  /** 进门：记着的口令还管用就直接返回它；否则弹层，等到输对为止，返回输对的那个 */
  async enter(): Promise<string> {
    const saved = recall();
    if (!saved) return this.ask('');
    if (!SENDABLE.test(saved)) {
      forget();
      return this.ask('');
    }
    const result = await this.verify(saved);
    if (result === 'ok') return saved;
    // 只有服务端明说不对才忘掉；问不成的时候它也许还是对的，留着下次再验
    if (result === 'denied') forget();
    return this.ask(result === 'unreachable' ? UNREACHABLE : '');
  }

  /** 口令不管用了（发布时服务端回了 401）：忘掉它，重新弹层，等到输对为止 */
  again(): Promise<string> {
    forget();
    return this.ask('');
  }

  private ask(error: string): Promise<string> {
    this.error.textContent = error;
    this.input.value = '';
    this.root.hidden = false;
    this.input.focus();
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  private async submit(): Promise<void> {
    if (this.asking || !this.settle) return;
    // 粘贴来的口令常常带着首尾的空格、换行，去掉（口令本身不会有空格：见 SENDABLE）
    const token = this.input.value.trim();
    if (token === '') return this.refuse('请输入管理口令');
    if (!SENDABLE.test(token)) return this.refuse(WRONG);

    this.asking = true;
    this.button.disabled = true;
    const result = await this.verify(token);
    this.asking = false;
    this.button.disabled = false;
    if (result !== 'ok') return this.refuse(result === 'denied' ? WRONG : UNREACHABLE);

    remember(token);
    this.root.hidden = true;
    this.error.textContent = '';
    this.input.value = '';
    const settle = this.settle;
    this.settle = null;
    settle(token);
  }

  private refuse(why: string): void {
    this.error.textContent = why;
    this.input.focus();
    this.input.select();
  }
}
