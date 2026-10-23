// Run with Electron, not Node. This checks real preload + IPC on a Windows runner;
// it does not capture the desktop or claim to verify real-world board recognition.
import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const profile = fs.mkdtempSync(path.join(os.tmpdir(),'acas-desktop-smoke-'));
app.setPath('userData',profile);
if(process.platform!=='win32') {
    app.commandLine.appendSwitch('no-sandbox');
    app.disableHardwareAcceleration();
    if(!process.env.DISPLAY) {
        app.commandLine.appendSwitch('headless');
        app.commandLine.appendSwitch('ozone-platform','headless');
    }
}
const timeout=setTimeout(()=>{console.error('Desktop smoke timed out.');app.exit(1);},20000);
let testedMain = false;
app.on('browser-window-created',(_event,win)=>{
    if(testedMain) return;
    testedMain = true;
    win.webContents.on('preload-error',(_event,_path,error)=>{console.error('Preload failed:',error.message);app.exit(1);});
    win.webContents.once('did-finish-load',async()=>{
        try {
            await new Promise(resolve=>setTimeout(resolve,500));
            const state=await win.webContents.executeJavaScript(`(async()=>({
                api:typeof window.desktopAPI, engineAPI:typeof window.engineAPI,
                mode:(await window.desktopAPI.state()).mode,
                visible:!document.querySelector('#desktop-panel').hidden,
                portHidden:document.querySelector('#portSettingsBtn').hidden
            }))()`);
            if(state.api!=='object'||state.engineAPI!=='object'||state.mode!=='desktop'||!state.visible||!state.portHidden)
                throw new Error('Desktop UI or preload is unavailable: '+JSON.stringify(state));
            const listening=await new Promise(resolve=>{
                const socket=net.createConnection({host:'127.0.0.1',port:2800});
                socket.on('connect',()=>{socket.destroy();resolve(true);});
                socket.on('error',()=>resolve(false));
                socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});
            });
            if(listening)throw new Error('Port 2800 is unexpectedly listening in Desktop mode.');
            const directory=path.dirname(fileURLToPath(import.meta.url));
            const overlay=new BrowserWindow({width:400,height:400,show:false,transparent:true,frame:false,
                webPreferences:{preload:path.join(directory,'../backend/desktop/overlay-preload.mjs'),
                    contextIsolation:true,nodeIntegration:false,sandbox:false}});
            await overlay.loadFile(path.join(directory,'../ui/desktop/overlay.html'));
            overlay.webContents.send('desktop:overlay',{moves:['e2e4'],orientation:'white'});
            await new Promise(resolve=>setTimeout(resolve,150));
            const rendered=await overlay.webContents.executeJavaScript(`(()=>{
                const canvas=document.querySelector('canvas');
                const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
                return typeof window.overlayAPI==='object' && pixels.some((value,index)=>index%4===3&&value>0);
            })()`);
            overlay.destroy();
            if(!rendered)throw new Error('Transparent overlay preload or arrow rendering failed.');
            console.log('Desktop Electron preload/IPC/overlay smoke passed; no local WebSocket server.');
            clearTimeout(timeout);app.quit();
        } catch(error) {console.error(error);app.exit(1);}
    });
});
await import('../backend/main.js');
