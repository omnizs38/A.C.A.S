const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
let browser,page,errors;
before(async()=>{browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});});
after(async()=>{await browser?.close();});
beforeEach(async()=>{
    page=await browser.newPage({viewport:{width:735,height:1100}});errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://acas-desktop.test/**',async route=>{
        const pathname=new URL(route.request().url()).pathname;
        const relative=pathname==='/'?'index.html':pathname.slice(1);
        const contentType=relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.svg')?'image/svg+xml':relative.endsWith('.html')?'text/html':'application/octet-stream';
        try {await route.fulfill({contentType,body:await fs.readFile(path.join(__dirname,'../appServer/ui',relative))});}
        catch {await route.fulfill({status:404,body:''});}
    });
    await page.addInitScript(()=>{
        const noop=()=>{};
        window.stats={capture:0,paused:0,stopped:0,analyzed:[],overlays:[]};
        const engines=[{engineId:'stockfish-test',name:'stockfish.exe',title:'Stockfish',path:'C:\\Chess\\stockfish.exe'}];
        window.engineAPI={getSavedEngines:async()=>engines,onRenderEngineGrid:noop,onAddConsoleView:noop,
            onRemoveConsoleView:noop,onRefreshEngineCards:noop,onLog:noop};
        window.serverAPI={sendEnginesList:async()=>{},onListening:noop,onClientChange:noop,onUnauthorized:noop};
        window.electronAPI={getVersion:async()=>'desktop-test'};window.toastAPI={onMessage:noop};
        window.desktopAPI={
            state:async()=>({mode:'desktop',supported:true,settings:{},displays:[{id:'1',label:'Primary monitor',primary:true}]}),
            onEvent:callback=>{window.desktopEvent=callback;},
            start:async settings=>{window.settings=settings;return {options:[{name:'MultiPV'}]};},
            stop:async()=>{window.stats.stopped++;},
            capture:async()=>{window.stats.capture++;return {token:window.stats.capture,image:window.screenImage};},
            pause:async()=>{window.stats.paused++;},
            analyze:async({fen})=>{window.stats.analyzed.push(fen);window.desktopEvent({type:'moves',payload:{fen,moves:['e2e4','e7e5']}});},
            overlay:async payload=>{window.stats.overlays.push(payload);}
        };
    });
    await page.goto('http://acas-desktop.test/');
    await page.waitForSelector('#desktop-panel:not([hidden])');
    await page.evaluate(async()=>{
        const {START_FEN}=await import('/desktop/tracker.js');
        const canvas=document.createElement('canvas');canvas.width=1100;canvas.height=760;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#222630';ctx.fillRect(0,0,1100,760);
        const cells=[];
        for(const row of START_FEN.split(' ')[0].split('/')) for(const ch of row) {
            if(/\d/.test(ch))for(let i=0;i<Number(ch);i++)cells.push(null);else cells.push(ch);
        }
        for(let row=0;row<8;row++)for(let col=0;col<8;col++){
            ctx.fillStyle=(row+col)%2?'#769656':'#eeeed2';ctx.fillRect(137+col*52,93+row*52,52,52);
            const piece=cells[row*8+col];
            if(piece){const image=new Image();image.src=`/desktop/pieces/cburnett/${piece===piece.toUpperCase()?'w':'b'}${piece.toLowerCase()}.svg`;await image.decode();ctx.drawImage(image,137+col*52,93+row*52,52,52);}
        }
        window.screenImage=canvas.toDataURL();
        ctx.fillStyle='#222630';ctx.fillRect(0,0,1100,760);window.emptyScreen=canvas.toDataURL();
    });
    await page.fill('#desktop-interval','500');
});
afterEach(async()=>{await page.close();assert.deepEqual(errors,[]);});

test('desktop waits for the board, starts UCI analysis, and draws only legal moves',async()=>{
    assert.equal(await page.locator('#portSettingsBtn').isVisible(),false);
    await page.click('#desktop-start');
    await page.waitForFunction(()=>window.stats.overlays.length>0,{},{timeout:10000});
    const state=await page.evaluate(()=>({stats,settings}));
    assert.equal(state.settings.engineId,'stockfish-test');
    assert.ok(state.stats.capture>=2);
    assert.deepEqual(state.stats.overlays.at(-1).moves,['e2e4']);
    assert.equal(state.stats.overlays.at(-1).orientation,'white');
    assert.equal(await page.locator('#desktop-engine').isDisabled(),true);
    await page.click('#desktop-stop');
});

test('losing the board suppresses suggestions and stopping turns capture off',async()=>{
    await page.click('#desktop-start');
    await page.waitForFunction(()=>window.stats.overlays.length>0,{},{timeout:10000});
    const before=await page.evaluate(()=>{window.screenImage=window.emptyScreen;return window.stats.paused;});
    await page.waitForFunction(before=>window.stats.paused>before,before,{timeout:10000});
    assert.match(await page.textContent('#desktop-status'),/Waiting for one fully visible board/);
    await page.click('#desktop-stop');
    const count=await page.evaluate(()=>window.stats.capture);
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(()=>window.stats.capture),count);
    assert.match(await page.textContent('#desktop-status'),/capture is off/);
});

test('desktop UI has no horizontal overflow at desktop and narrow sizes',async()=>{
    for(const width of [735,390]) {
        await page.setViewportSize({width,height:1100});
        await page.screenshot({path:path.join(process.env.ACAS_SCREENSHOT_DIR || require('node:os').tmpdir(),`acas-desktop-ui-${width}.png`),fullPage:true});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
});
