import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mdview', {
  init: () => ipcRenderer.invoke('doc:init'),
  save: (content: string) => ipcRenderer.invoke('doc:save', content),
  saveAs: (content: string) => ipcRenderer.invoke('doc:save-as', content),
  setDirty: (dirty: boolean) => ipcRenderer.send('doc:dirty', dirty),
  setEditing: (editing: boolean) => ipcRenderer.send('doc:editing', editing),
  openLink: (href: string) => ipcRenderer.send('link:open', href),
  closeAfterSave: () => ipcRenderer.send('doc:closed-after-save'),
  confirmReload: () => ipcRenderer.invoke('doc:confirm-reload'),
  onMenu: (fn: (cmd: string) => void) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onExternalChange: (fn: (content: string) => void) =>
    ipcRenderer.on('doc:external-change', (_e, content) => fn(content)),
});
