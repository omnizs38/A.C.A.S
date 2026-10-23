const { test, before, after, beforeEach, afterEach }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
let browser,page;
before(async()=>{browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});});
after(async()=>{await browser?.close();});
beforeEach(async()=>{
    page=await browser.newPage({viewport:{width:1100,height:760}});
    await page.route('http://desktop.test/**',async route=>{
        const relative=new URL(route.request().url()).pathname.slice(1);
        if(!relative) return route.fulfill({contentType:'text/html',body:'<!doctype html><canvas id="screen" width="1100" height="760"></canvas>'});
        await route.fulfill({contentType:relative.endsWith('.svg')?'image/svg+xml':'text/javascript',
            body:await fs.readFile(path.join(__dirname,'../appServer/ui/desktop',relative))});
    });
    await page.goto('http://desktop.test/');
    await page.evaluate(async()=>{
        window.vision=await import('/vision.js');
        window.logic=await import('/tracker.js');
        window.drawBoard=async({theme='cburnett',flip=false,x=137,y=93,cell=52,fen=logic.START_FEN,scale=1}={})=>{
            const canvas=document.getElementById('screen'),ctx=canvas.getContext('2d');
            ctx.fillStyle='#222630';ctx.fillRect(0,0,canvas.width,canvas.height);
            const cells=[];
            for(const rank of fen.split(' ')[0].split('/')) for(const token of rank) {
                if(/\d/.test(token)) for(let i=0;i<Number(token);i++)cells.push(null);
                else cells.push(token);
            }
            if(flip)cells.reverse();
            for(let row=0;row<8;row++) for(let col=0;col<8;col++) {
                ctx.fillStyle=(row+col)%2?'#769656':'#eeeed2';ctx.fillRect(x+col*cell,y+row*cell,cell,cell);
                const piece=cells[row*8+col];
                if(piece) {
                    const color=piece===piece.toUpperCase()?'w':'b',type=piece.toLowerCase();
                    const image=new Image();image.src=`/pieces/${theme}/${color}${type}.svg`;await image.decode();
                    ctx.drawImage(image,x+col*cell+cell*(1-scale)/2,y+row*cell+cell*(1-scale)/2,cell*scale,cell*scale);
                }
            }
            return {x,y,size:cell*8};
        };
    });
});
afterEach(async()=>{await page.close();});

for(const theme of ['cburnett','merida']) for(const flip of [false,true]) {
    test(`detects and recognizes ${theme} starting board ${flip?'black':'white'} bottom`,async()=>{
        const result=await page.evaluate(async({theme,flip})=>{
            const expected=await drawBoard({theme,flip});
            const canvas=document.getElementById('screen'),image=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
            const rect=vision.detectBoard(image);
            const recognizer=new vision.PieceRecognizer();await recognizer.load(theme);
            const recognized=rect&&recognizer.recognize(canvas,rect);
            return {rect,expected,recognized,placement:recognized&&logic.piecePlacement(recognized.cells,flip),start:logic.placement(logic.START_FEN)};
        },{theme,flip});
        assert.ok(result.rect,'Board must be found');
        assert.ok(Math.abs(result.rect.x-result.expected.x)<3,JSON.stringify(result.rect));
        assert.ok(Math.abs(result.rect.y-result.expected.y)<3,JSON.stringify(result.rect));
        assert.ok(result.recognized,'Pieces must be confidently recognized');
        assert.equal(result.placement,result.start);
    });
}

test('detects a moved/resized board and recognizes an e4 position',async()=>{
    const result=await page.evaluate(async()=>{
        const fen='rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        await drawBoard({x:271,y:129,cell:64,fen,scale:.925});
        const canvas=document.getElementById('screen'),ctx=canvas.getContext('2d');
        const rect=vision.detectBoard(ctx.getImageData(0,0,canvas.width,canvas.height),{x:137,y:93,size:416});
        const recognizer=new vision.PieceRecognizer();await recognizer.load('cburnett');
        const pieces=rect&&recognizer.recognize(canvas,rect);
        return {rect,placement:pieces&&logic.piecePlacement(pieces.cells),expected:logic.placement(fen)};
    });
    assert.ok(result.rect);assert.equal(result.placement,result.expected);
});

test('does not detect a plain screen, and rejects a checkerboard without kings',async()=>{
    const result=await page.evaluate(async()=>{
        const canvas=document.getElementById('screen'),ctx=canvas.getContext('2d');
        ctx.fillStyle='#333';ctx.fillRect(0,0,canvas.width,canvas.height);
        const plain=vision.detectBoard(ctx.getImageData(0,0,canvas.width,canvas.height));
        const expected=await drawBoard({fen:'8/8/8/8/8/8/8/8 w - - 0 1'});
        const rect=vision.detectBoard(ctx.getImageData(0,0,canvas.width,canvas.height));
        const recognizer=new vision.PieceRecognizer();await recognizer.load('cburnett');
        return {plain,rect,pieces:recognizer.recognize(canvas,expected)};
    });
    assert.equal(result.plain,null);assert.ok(result.rect);assert.equal(result.pieces,null);
});

test('obstruction invalidates cached board and unknown pieces suppress suggestions',async()=>{
    const result=await page.evaluate(async()=>{
        const rect=await drawBoard();
        const canvas=document.getElementById('screen'),ctx=canvas.getContext('2d');
        ctx.fillStyle='#f70';ctx.fillRect(rect.x,rect.y,rect.size,rect.size/2);
        const detected=vision.detectBoard(ctx.getImageData(0,0,canvas.width,canvas.height),rect);
        return detected;
    });
    assert.equal(result,null);
});
