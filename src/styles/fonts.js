/**
 * 字体注入
 *
 * 微应用运行在 Shadow DOM 里，@font-face 必须注入到 document.head 才能全局生效。
 * 字体文件放在 public/fonts/，运行时通过 staticPath 拼出真实 URL。
 */

const STYLE_ID = 'mslx-mc-fonts';

/** 只注入一次 */
export function ensureFontFaces(staticPath) {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(STYLE_ID)) return;

  const base = String(staticPath || '').replace(/\/+$/, '');
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
@font-face {
  font-family: 'MSLXUnifont';
  src: url('${base}/fonts/unifont-subset.ttf') format('truetype');
  font-display: swap;
}
@font-face {
  font-family: 'MSLXMojangles';
  src: url('${base}/fonts/mojangles-subset.ttf') format('truetype');
  font-display: swap;
}
`;
  document.head.appendChild(style);
}

/** 可选字体 */
export const FONTS = [
  { key: 'default', label: '跟随后台（默认）' },
  { key: 'mojangles', label: 'Mojangles（MC 原版）' },
  { key: 'unifont', label: 'Unifont（像素等宽）' },
];

/** 取字体对应的 class 名 */
export function fontClass(key) {
  if (key === 'mojangles') return 'font-mojangles';
  if (key === 'unifont') return 'font-unifont';
  return '';
}
