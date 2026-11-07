const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  setIgnore: (v) => ipcRenderer.send('desk:ignore', v),
  quit: () => ipcRenderer.send('desk:quit'),
  // 受け取るのは { letters: { a: 回数, ... }, other: 回数 } だけ
  onKeys: (cb) => ipcRenderer.on('desk:keys', (_e, data) => cb(data)),
  hookStatus: () => ipcRenderer.invoke('desk:hook-status'),
});
