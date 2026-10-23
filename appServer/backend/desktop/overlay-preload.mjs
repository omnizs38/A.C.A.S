import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('overlayAPI', {
    onMoves:callback=>ipcRenderer.on('desktop:overlay',(_event,data)=>callback(data))
});
