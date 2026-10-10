import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('gitcolumn', {
  platform: process.platform,
  invoke: (method: string, args: unknown) => ipcRenderer.invoke('api', method, args),
  onAskpass: (cb: (req: { id: number; prompt: string }) => void) => {
    const handler = (_e: IpcRendererEvent, req: { id: number; prompt: string }) => cb(req);
    ipcRenderer.on('askpass:request', handler);
    return () => ipcRenderer.removeListener('askpass:request', handler);
  },
  replyAskpass: (id: number, value: string | null) => ipcRenderer.send('askpass:reply', id, value),
  onMenu: (cb: (command: string) => void) => {
    const handler = (_e: IpcRendererEvent, command: string) => cb(command);
    ipcRenderer.on('menu', handler);
    return () => ipcRenderer.removeListener('menu', handler);
  },
});
