import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('api', {
  loadVault: () => ipcRenderer.invoke('vault:load'),
  pickVault: () => ipcRenderer.invoke('vault:pick'),
  writeNote: (path: string, content: string) => ipcRenderer.invoke('note:write', path, content),
  movePath: (from: string, to: string) => ipcRenderer.invoke('note:rename', from, to),
  trashPath: (path: string) => ipcRenderer.invoke('note:delete', path),
  createDir: (path: string) => ipcRenderer.invoke('dir:create', path),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  onVaultEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, event: unknown): void => cb(event)
    ipcRenderer.on('vault:event', listener)
    return () => ipcRenderer.removeListener('vault:event', listener)
  }
})
