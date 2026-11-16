/**
 * 画面出不来了（多半是浏览器太旧、不支持 WebGL2，或者显存、内存不够）：
 * 在页面上说一声，别只留一片黑、或者按什么都没反应。
 */
export function showBroken(reason: unknown): void {
  console.error(reason);
  const note = document.createElement('p');
  note.className = 'broken';
  note.textContent = '这个浏览器显示不了游戏画面，换一个新一些的浏览器试试。';
  document.body.append(note);
}
