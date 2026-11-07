/* デスクトップ常駐時だけ動く処理。
 * ウィンドウ全体は「クリック透過」にしておき、カーソルがカード本体
 * （右下の帯・開いているパネル）の上に来たときだけ透過を解除する。
 * 判定は実際の要素に当てるので、CSS でレイアウトを変えても追従する。 */

(() => {
  'use strict';
  if (!window.desk) return;   // ブラウザで開いているときは何もしない

  let ignoring = null;

  function setIgnore(v) {
    if (v === ignoring) return;
    ignoring = v;
    window.desk.setIgnore(v);
  }

  function isOverCard(x, y) {
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest('#app, #panel'));
  }

  window.addEventListener('mousemove', (e) => setIgnore(!isOverCard(e.clientX, e.clientY)));
  setIgnore(true);
})();
