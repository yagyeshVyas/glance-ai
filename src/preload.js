const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('glance', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (c) => ipcRenderer.invoke('config:set', c),
  listModels: (o) => ipcRenderer.invoke('models:list', o),
  ask: (payload) => ipcRenderer.invoke('ask', payload),
  captureOne: () => ipcRenderer.invoke('capture:one'),
  cancel: () => ipcRenderer.invoke('cancel'),
  transcribe: (data, mime) => ipcRenderer.invoke('transcribe', { data, mime }),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('window:quit'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  stealthApply: (on) => ipcRenderer.invoke('stealth:apply', on),
  moveWindow: (dx, dy) => ipcRenderer.invoke('window:move', { dx, dy }),
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (s) => ipcRenderer.invoke('state:set', s),
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  speak: (text) => ipcRenderer.invoke('speak', { text }),
  practiceSave: (o) => ipcRenderer.invoke('practice:save', o),
  practiceExport: (o) => ipcRenderer.invoke('practice:export', o),
  wipeAll: () => ipcRenderer.invoke('wipe:all'),
  onChunk: on('chunk'),
  onReasoning: on('reasoning'),
  onReset: on('reset'),
  onDone: on('done'),
  onError: on('error'),
  onNotice: on('notice'),
  onShot: on('shot'),
  onTrigger: on('trigger'),
  onClickThrough: on('click-through'),
});
