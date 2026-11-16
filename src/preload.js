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
  transcribe: (data, mime, who) => ipcRenderer.invoke('transcribe', { data, mime, who }),
  hide: () => ipcRenderer.invoke('window:hide'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  quit: () => ipcRenderer.invoke('window:quit'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  stealthApply: (on) => ipcRenderer.invoke('stealth:apply', on),
  ghostCheck: () => ipcRenderer.invoke('ghost:check'),
  stealthReport: () => ipcRenderer.invoke('stealth:report'),
  broadcastStatus: () => ipcRenderer.invoke('broadcast:status'),
  setBroadcastEyeContact: (on) => ipcRenderer.invoke('broadcast:eye-contact', Boolean(on)),
  windowShown: () => ipcRenderer.invoke('window:shown'),
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
  onFlagless: on('stealth:flagless'),
});

