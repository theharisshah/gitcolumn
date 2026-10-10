import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gitcolumn', {
  platform: process.platform,
  invoke: (method: string, args: unknown) => ipcRenderer.invoke('api', method, args),
});
