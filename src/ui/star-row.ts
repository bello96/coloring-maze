const SVG = 'http://www.w3.org/2000/svg';
const STAR_PATH = 'M12 2.6l2.8 6 6.5.8-4.8 4.5 1.3 6.5L12 17.2 6.2 20.4l1.3-6.5L2.7 9.4l6.5-.8z';

/** 一排三颗星，前 won 颗是得到的。通关面板和选关树上的星都是它 */
export function starRow(won: number): HTMLElement {
  const row = document.createElement('span');
  row.className = 'stars';
  for (let i = 0; i < 3; i++) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    if (i < won) svg.classList.add('won');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', STAR_PATH);
    svg.append(path);
    row.append(svg);
  }
  return row;
}
