import { detectBoard, PieceRecognizer } from './vision.js';
import { PositionTracker, START_FEN, piecePlacement } from './tracker.js';

const api = window.desktopAPI;
const $ = id => document.getElementById(id);
const panel = $('desktop-panel');
let watching = false, generation = 0, timer = null, tracker, recognizer;
let previousRect = null, frame = null, lastMoves = null;
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d',{ willReadFrequently:true });
const status = (text,error=false) => {
    $('desktop-status').textContent = text;
    $('desktop-status').dataset.error = String(error);
};
const paint = async () => {
    if(!watching || !frame || !lastMoves || lastMoves.fen!==frame.fen) return;
    const moves = tracker.legalMoves(lastMoves.moves);
    await api.overlay({ ...frame,moves });
};
function controls(active,starting=false) {
    $('desktop-settings').disabled = active;
    $('desktop-start').disabled = active;
    $('desktop-stop').disabled = !active || starting;
    $('desktop-reset').disabled = !active || starting;
}
async function lost(message) {
    frame = lastMoves = null;
    tracker.lost();
    status(message);
    await api.pause();
}
async function poll(epoch) {
    if(!watching || epoch!==generation) return;
    try {
        frame = null;
        const snapshot = await api.capture();
        if(!watching || epoch!==generation) return;
        const image = new Image(); image.src = snapshot.image; await image.decode();
        if(!watching || epoch!==generation) return;
        const scale = Math.min(1,1100/Math.max(image.width,image.height));
        canvas.width = Math.round(image.width*scale); canvas.height = Math.round(image.height*scale);
        context.drawImage(image,0,0,canvas.width,canvas.height);
        const pixels = context.getImageData(0,0,canvas.width,canvas.height);
        const rect = detectBoard(pixels,previousRect);
        previousRect = rect;
        if(!rect) await lost('Waiting for one fully visible board…');
        else {
            const recognized = recognizer.recognize(canvas,rect);
            if(!recognized) await lost('Board found; pieces are uncertain. Check the piece theme, animation, or obstruction.');
            else {
                const observed = tracker.observe(piecePlacement(recognized.cells),piecePlacement(recognized.cells,true));
                if(!observed.ready) {
                    frame = lastMoves = null;
                    status(observed.reason);
                    await api.pause();
                } else {
                    frame = { token:snapshot.token, fen:observed.fen,orientation:observed.orientation,
                        rect:{ x:rect.x/canvas.width,y:rect.y/canvas.height,width:rect.size/canvas.width,height:rect.size/canvas.height } };
                    $('desktop-fen-output').textContent = observed.fen;
                    status(`Board tracked · ${observed.orientation} at bottom · ${observed.fen.split(' ')[1]==='w'?'White':'Black'} to move · ${Math.round(recognized.confidence*100)}% match`);
                    await api.analyze({fen:observed.fen,token:snapshot.token});
                    await paint();
                }
            }
        }
    } catch(error) {
        if(watching && epoch===generation) {
            watching = false; ++generation; frame = lastMoves = null;
            controls(false); status(error.message,true);
            await api.stop().catch(console.error);
        }
    } finally {
        if(watching && epoch===generation) timer = setTimeout(()=>poll(epoch),Number($('desktop-interval').value));
    }
}
function fillEngines(engines) {
    const select = $('desktop-engine'), value = select.value;
    select.replaceChildren();
    for(const engine of engines) {
        const option = document.createElement('option');option.value=engine.engineId;option.textContent=engine.title||engine.name;select.append(option);
    }
    if(!engines.length) {
        const option = document.createElement('option');option.value='';option.textContent='Add an engine below';select.append(option);
    } else if(engines.some(engine=>engine.engineId===value)) select.value=value;
}
async function initialize() {
    if(!api) return; // Older preloads and isolated regression fixtures remain usable.
    const state = await api.state();
    $('application-mode-bar').hidden=false;
    $('application-mode-label').textContent=state.mode==='desktop'?'DESKTOP · NO USERSCRIPT · NO SERVER':'LEGACY WEB MODE';
    $('application-mode-switch').textContent=state.mode==='desktop'?'Use Web mode':'Use Desktop mode';
    $('application-mode-switch').onclick=async()=>{
        if(watching && !confirm('Stop watching and restart in the other mode?')) return;
        try { await api.mode(state.mode==='desktop'?'web':'desktop'); }
        catch(error) { status(error.message,true); toast.error(error.message,5000); }
    };
    if(state.mode!=='desktop') return;
    panel.hidden=false;document.body.classList.add('desktop-mode');
    document.querySelectorAll('.engine-idle-hint').forEach(hint=>{hint.textContent='Ready for desktop analysis';});
    $('portSettingsBtn').hidden=true;
    $('acas-logo-secondary').textContent='Desktop screen analysis';
    for(const display of state.displays) {
        const option=document.createElement('option');option.value=display.id;option.textContent=display.label+(display.primary?' (primary)':'');
        if(display.primary) option.selected=true;
        $('desktop-display').append(option);
    }
    await fillEngines(await window.engineAPI.getSavedEngines());
    window.engineAPI.onRenderEngineGrid(({savedEngines})=>fillEngines(savedEngines));
    const saved=state.settings||{};
    for(const [property,id] of [['engineId','desktop-engine'],['displayId','desktop-display'],['depth','desktop-depth'],['movetime','desktop-movetime'],['launchParams','desktop-launch']])
        if(saved[property]!==undefined) $(id).value=String(saved[property]);
    $('desktop-options').value=JSON.stringify(saved.options||{});
    try {
        const theme=localStorage.getItem('desktop-piece-theme');
        if(['cburnett','merida'].includes(theme)) $('desktop-theme').value=theme;
    } catch { /* Recognition can work without localStorage. */ }
    if(!state.supported) { status('Desktop capture requires Windows. Web mode is still available.',true);$('desktop-start').disabled=true; }
    api.onEvent(({type,payload})=>{
        if(type==='moves') { lastMoves=payload;paint().catch(console.error); }
        if(type==='status') {
            status(payload.text,payload.error);
            if(payload.error) {
                watching=false;++generation;clearTimeout(timer);controls(false);frame=lastMoves=null;
                api.stop().catch(console.error);
            }
        }
    });
    $('desktop-form').addEventListener('submit',async event=>{
        event.preventDefault();
        if(watching || !$('desktop-form').reportValidity()) return;
        controls(true,true);status('Preparing screen recognition…');
        try {
            tracker=new PositionTracker($('desktop-fen').value.trim()||START_FEN);
            const settings={engineId:$('desktop-engine').value,displayId:$('desktop-display').value,
                depth:Number($('desktop-depth').value),movetime:Number($('desktop-movetime').value),
                launchParams:$('desktop-launch').value,options:JSON.parse($('desktop-options').value)};
            recognizer=new PieceRecognizer();await recognizer.load($('desktop-theme').value);
            const ready=await api.start(settings);
            try { localStorage.setItem('desktop-piece-theme',$('desktop-theme').value); } catch { /* Optional. */ }
            $('desktop-options-help').textContent='Available UCI options: '+(ready.options.map(option=>option.name).join(', ')||'none advertised');
            previousRect=frame=lastMoves=null;watching=true;controls(true);const epoch=++generation;
            status('Waiting for a supported board…');poll(epoch);
        } catch(error) {
            watching=false;controls(false);status(error.message,true);await api.stop().catch(console.error);
        }
    });
    $('desktop-stop').onclick=async()=>{
        watching=false;++generation;clearTimeout(timer);frame=lastMoves=null;
        await api.stop();controls(false);status('Stopped. Screen capture is off.');
    };
    $('desktop-reset').onclick=async()=>{
        // Keep the engine; explicitly reset history before a new game or resync.
        tracker.reset($('desktop-fen').value.trim()||START_FEN);previousRect=frame=lastMoves=null;
        await api.pause();status('Position reset. Waiting for the configured starting position…');
    };
}
initialize().catch(error=>{console.error(error);status(error.message,true);});
