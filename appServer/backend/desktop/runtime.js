import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DesktopSession, validateDesktopSettings } from './session.js';
import { engineEvents } from '../engineEvents.js';
import { startEngine, sendToProcess, killEngine, savedEngines } from '../engine.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

export class DesktopRuntime {
    constructor({ mainWindow, mode, settings = {} }) {
        this.getMainWindow = mainWindow;
        this.mode = mode;
        this.settings = settings;
        this.running = false;
        this.captureToken = 0;
        this.session = new DesktopSession({
            start:startEngine, send:sendToProcess, kill:killEngine, events:engineEvents,
            onStatus:(text,error=false) => {
                if(error) { this.running = false; this.clearOverlay(); }
                this.notify('status',{ text,error });
            },
            onMoves:moves => { if(!moves) this.clearOverlay(); this.notify('moves',moves); }
        });
    }
    notify(type,payload) {
        const win = this.getMainWindow();
        if(win && !win.isDestroyed()) win.webContents.send('desktop:event',{ type,payload });
    }
    state() {
        return { mode:this.mode, supported:process.platform==='win32', settings:this.settings,
            displays:screen.getAllDisplays().map(display=>({ id:String(display.id),
                label:display.label || `Display ${display.id}`, primary:display.id===screen.getPrimaryDisplay().id })),
            options:[...this.session.options?.values() || []] };
    }
    async start(input) {
        if(process.platform !== 'win32') throw new Error('Desktop screen mode currently requires Windows.');
        if(this.mode !== 'desktop') throw new Error('Switch to Desktop mode first.');
        if(this.starting) throw new Error('Engine startup is already in progress.');
        this.starting = true;
        try {
            const settings = validateDesktopSettings(input);
            const display = screen.getAllDisplays().find(item=>String(item.id)===String(input.displayId));
            if(!display) throw new Error('Select an available display.');
            const engine = savedEngines.find(item=>item.engineId===settings.engineId);
            if(!engine) throw new Error('Selected engine was removed from the library.');
            await this.stop();
            this.displayId = String(display.id);
            await this.session.start(engine,settings);
            this.settings = { ...settings, displayId:this.displayId };
            this.running = true;
            return this.state();
        } catch(error) {
            await this.stop();
            throw error;
        } finally { this.starting = false; }
    }
    async stop() {
        this.running = false;
        this.captureToken++;
        this.lastCapture = null;
        this.clearOverlay();
        await this.session.stop();
    }
    pause() {
        this.session.pause();
        this.clearOverlay();
    }
    async capture() {
        if(!this.running) throw new Error('Screen watching is stopped.');
        if(this.capturing) throw new Error('A screen capture is already in progress.');
        this.capturing = true;
        const token = ++this.captureToken;
        try {
            // Exclusion alone is unreliable on some Windows/Electron versions.
            // Hide before capture so arrows cannot become recognized pieces.
            this.clearOverlay();
            await sleep(80);
            const display = screen.getAllDisplays().find(item=>String(item.id)===this.displayId);
            if(!display) throw new Error('Selected display was disconnected.');
            const sources = await desktopCapturer.getSources({ types:['screen'],
                thumbnailSize:{ width:Math.min(4096,Math.round(display.bounds.width*display.scaleFactor)),
                    height:Math.min(4096,Math.round(display.bounds.height*display.scaleFactor)) }, fetchWindowIcons:false });
            const source = sources.find(item=>item.display_id===this.displayId);
            if(!source || source.thumbnail.isEmpty()) throw new Error('Windows did not provide a screen image.');
            if(!this.running || token !== this.captureToken) throw new Error('Screen watching stopped during capture.');
            this.lastCapture = { token, bounds:{ ...display.bounds } };
            return { token, image:source.thumbnail.toDataURL() };
        } finally { this.capturing = false; }
    }
    analyze({fen,token}) {
        if(!this.running || token!==this.lastCapture?.token) return;
        this.session.analyze(fen);
    }
    async draw({fen,token,rect,orientation,moves}) {
        if(!this.running || this.capturing || token!==this.lastCapture?.token || fen!==this.session.latest) return;
        if(!rect || ![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)
            || rect.x<0 || rect.y<0 || rect.width<=0 || rect.height<=0
            || rect.x+rect.width>1.001 || rect.y+rect.height>1.001
            || !['white','black'].includes(orientation) || !Array.isArray(moves) || moves.length>5
            || !moves.every(move=>/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) return;
        const display = this.lastCapture.bounds;
        const bounds = { x:Math.round(display.x+rect.x*display.width), y:Math.round(display.y+rect.y*display.height),
            width:Math.round(rect.width*display.width), height:Math.round(rect.height*display.height) };
        if(bounds.width<40 || bounds.height<40) return;
        if(!this.overlay || this.overlay.isDestroyed()) {
            this.overlay = new BrowserWindow({ ...bounds, frame:false,transparent:true,focusable:false,
                resizable:false,skipTaskbar:true,show:false,hasShadow:false,alwaysOnTop:true,
                webPreferences:{ preload:path.join(directory,'overlay-preload.mjs'),contextIsolation:true,nodeIntegration:false,sandbox:false } });
            this.overlay.setIgnoreMouseEvents(true,{ forward:true });
            this.overlay.setAlwaysOnTop(true,'screen-saver');
            this.overlay.setContentProtection(true);
            this.overlayReady = this.overlay.loadFile(path.join(directory,'../../ui/desktop/overlay.html'));
        }
        try { await this.overlayReady; }
        catch(error) {
            if(this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
            this.overlay = null;
            throw new Error(`Could not load the move overlay: ${error.message}`);
        }
        if(!this.overlay || this.overlay.isDestroyed()) return;
        // First load can finish after another capture or a stop request.
        if(!this.running || this.capturing || token!==this.lastCapture?.token || fen!==this.session.latest) return;
        this.overlay.setBounds(bounds);
        this.overlay.webContents.send('desktop:overlay',{ moves,orientation });
        if(moves.length) this.overlay.showInactive();
        else this.clearOverlay();
    }
    clearOverlay() { if(this.overlay && !this.overlay.isDestroyed()) this.overlay.hide(); }
    async dispose() {
        await this.stop();
        await this.session.dispose();
        if(this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    }
}
