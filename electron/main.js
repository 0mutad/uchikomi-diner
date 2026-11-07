const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

/* 画面右下に置くカード。中身の寸法は src/style.css の変数と揃えること。
 * ウィンドウ自体はカードより一回り大きく、余った部分はクリックが下のアプリに抜ける。 */
const MARGIN = 14;
const CARD_W = 480;
const STRIP_H = 190;
const PANEL_H = 340;
const WIN_W = CARD_W + MARGIN * 2;
const WIN_H = STRIP_H + PANEL_H + MARGIN * 2 + 8;

let win = null;

function place() {
  if (!win) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: area.x + area.width - WIN_W,
    y: area.y + area.height - WIN_H,
    width: WIN_W,
    height: WIN_H,
  });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    x: area.x + area.width - WIN_W,
    y: area.y + area.height - WIN_H,
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: 'うちこみ食堂',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'normal');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  screen.on('display-metrics-changed', place);
  win.on('closed', () => { win = null; });
}

/* ---------- キー入力のカウント ----------
 * 他のアプリで打った a〜z を数える。
 * 残すのは「キーごとの回数」だけ。押した順番・時刻・その他のキーの種類は保存も送信もしない。
 * 今押されているキーの集合は、押しっぱなし（自動リピート）を除くためにメモリ上だけで持つ。 */
const MAX_PER_SEC = 20;      // これを超えた分は数えない（連打マクロ対策）
const FLUSH_MS = 200;        // 画面へまとめて送る間隔

let pending = {};            // まだ画面へ送っていない回数 { a: 3, s: 1, ... }
let pendingOther = 0;        // a〜z 以外のキー（合計の打鍵数の記録だけに使う）
const held = new Set();      // 押しっぱなし判定用（メモリのみ）
let recent = [];             // 直近1秒の受付時刻（上限判定用、メモリのみ）
let hookError = null;

function startHook() {
  let uIOhook, UiohookKey;
  try {
    ({ uIOhook, UiohookKey } = require('uiohook-napi'));
  } catch (e) {
    hookError = String(e && e.message || e);
    return;
  }

  // キーコード → 文字 の対応表（A〜Z だけ）
  const letterOf = new Map();
  for (let c = 65; c <= 90; c++) {
    const ch = String.fromCharCode(c);
    letterOf.set(UiohookKey[ch], ch.toLowerCase());
  }

  uIOhook.on('keydown', (e) => {
    if (held.has(e.keycode)) return;        // 押しっぱなし
    held.add(e.keycode);
    if (e.ctrlKey || e.altKey || e.metaKey) return;  // ショートカットは数えない

    const now = Date.now();
    recent = recent.filter((t) => now - t < 1000);
    if (recent.length >= MAX_PER_SEC) return;
    recent.push(now);

    const ch = letterOf.get(e.keycode);
    if (ch) pending[ch] = (pending[ch] || 0) + 1;
    else pendingOther++;
  });
  uIOhook.on('keyup', (e) => { held.delete(e.keycode); });

  try {
    uIOhook.start();
    console.log('[hook] キー入力の取得を開始しました');
  } catch (e) {
    hookError = String(e && e.message || e);
    console.error('[hook] 開始できませんでした:', hookError);
    return;
  }
  app.on('will-quit', () => { try { uIOhook.stop(); } catch (_) { /* 終了時なので無視 */ } });
}

setInterval(() => {
  if (!win) return;
  if (Object.keys(pending).length === 0 && pendingOther === 0) return;
  win.webContents.send('desk:keys', { letters: pending, other: pendingOther });
  pending = {};
  pendingOther = 0;
}, FLUSH_MS);

ipcMain.handle('desk:hook-status', () => ({ ok: !hookError, error: hookError }));
ipcMain.on('desk:ignore', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on('desk:quit', () => app.quit());

app.whenReady().then(() => {
  startHook();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
