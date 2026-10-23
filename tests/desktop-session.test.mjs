import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopSession, validateDesktopSettings, isFen } from '../appServer/backend/desktop/session.js';
import { PositionTracker, START_FEN, placement } from '../appServer/ui/desktop/tracker.js';
import { squareCenter, arrowGeometry } from '../appServer/ui/desktop/geometry.js';

const other = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const engine = {engineId:'test-engine',path:'/test/engine'};
function fixture() {
    const events=new EventEmitter(),sent=[],moves=[],statuses=[],killed=[];
    let session;
    const emit=line=>events.emit('uci',{line,...session.identifier});
    session=new DesktopSession({events,start:async()=>{},kill:async id=>killed.push(id),
        send:line=>{
            sent.push(line);
            if(line==='uci') {emit('option name MultiPV type spin default 1 min 1 max 5');emit('uciok');}
            if(line==='isready') emit('readyok');
        },onStatus:(...args)=>statuses.push(args),onMoves:message=>moves.push(message)});
    return {session,sent,moves,statuses,killed,emit,events};
}

test('desktop settings reject injected commands, bad bounds, and malformed FEN',()=>{
    assert.equal(validateDesktopSettings({engineId:'id'}).depth,14);
    for(const settings of [{engineId:''},{engineId:'x',depth:0},{engineId:'x',movetime:99},
        {engineId:'x',options:{Hash:'128\nquit'}},{engineId:'x',options:[]},
        {engineId:'x',launchParams:'--device=cpu;whoami'}]) assert.throws(()=>validateDesktopSettings(settings));
    assert.equal(isFen(START_FEN),true);
    for(const value of ['no','8/8/8/8/8/8/8/9 w - - 0 1',START_FEN+'\nquit']) assert.equal(isFen(value),false);
});

test('desktop session uses existing transport and completes UCI readiness/options in order',async()=>{
    const f=fixture();
    try {
        await f.session.start(engine,{engineId:engine.engineId,options:{MultiPV:2}});
        assert.deepEqual(f.sent,['uci','setoption name MultiPV value 2','isready']);
        assert.equal(f.session.phase,'ready');
        f.session.analyze(START_FEN);
        assert.deepEqual(f.sent.slice(-2),['position fen '+START_FEN,'go depth 14 movetime 1000']);
        f.emit('info depth 3 multipv 1 pv e2e4 e7e5');
        assert.deepEqual(f.moves.at(-1),{fen:START_FEN,moves:['e2e4']});
    } finally {await f.session.dispose();}
});

test('a new position drains the old bestmove and suppresses its stale arrows',async()=>{
    const f=fixture();
    try {
        await f.session.start(engine,{engineId:engine.engineId});f.session.analyze(START_FEN);
        f.session.analyze(other);
        assert.equal(f.sent.at(-1),'stop');
        f.emit('info depth 6 pv d2d4');
        assert.equal(f.moves.at(-1),null);
        f.emit('bestmove e2e4');
        assert.equal(f.sent.at(-2),'position fen '+other);
        f.emit('info depth 4 pv e7e5');
        assert.deepEqual(f.moves.at(-1),{fen:other,moves:['e7e5']});
    } finally {await f.session.dispose();}
});

test('loss of the board pauses analysis and refuses late results',async()=>{
    const f=fixture();
    try {
        await f.session.start(engine,{engineId:engine.engineId});f.session.analyze(START_FEN);
        f.session.pause();f.emit('bestmove e2e4');
        assert.equal(f.moves.at(-1),null);assert.equal(f.session.latest,null);
        f.session.analyze(START_FEN);assert.equal(f.session.active.fen,START_FEN);
    } finally {await f.session.dispose();}
});

test('unsupported options fail explicitly and listener lifecycle is cleaned up',async()=>{
    const f=fixture();
    await assert.rejects(f.session.start(engine,{engineId:engine.engineId,options:{NoSuchOption:1}}),/Unsupported/);
    await f.session.dispose();
    assert.equal(f.events.listenerCount('uci'),0);assert.equal(f.events.listenerCount('death'),0);
});

test('tracker requires stable observations and reconstructs turn and legal e4',()=>{
    const tracker=new PositionTracker();
    assert.equal(tracker.observe(placement(START_FEN),'bad').ready,false);
    assert.equal(tracker.observe(placement(START_FEN),'bad').ready,true);
    tracker.observe(placement(other),'bad');
    const result=tracker.observe(placement(other),'bad');
    assert.equal(result.ready,true);assert.equal(result.fen.split(' ')[1],'b');
    assert.deepEqual(tracker.legalMoves(['e7e5','e2e4']),['e7e5']);
});

test('tracker handles a flipped board without changing the side to move',()=>{
    const tracker=new PositionTracker();
    tracker.observe('bad',placement(START_FEN));
    const result=tracker.observe('bad',placement(START_FEN));
    assert.equal(result.orientation,'black');assert.equal(result.fen,START_FEN);
});

test('tracker rejects arbitrary screenshots instead of inventing FEN state',()=>{
    const tracker=new PositionTracker();
    tracker.observe('8/8/8/8/8/8/8/8','bad');
    const result=tracker.observe('8/8/8/8/8/8/8/8','bad');
    assert.equal(result.ready,false);assert.equal(tracker.chess.fen(),START_FEN);
});

test('tracker reconstructs two missed plies, castling, en passant and promotions',()=>{
    for(const [fen,moves] of [[START_FEN,['e4','e5']],
        ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',['O-O']],
        ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',['exd6']],
        ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1',['a8=Q+']]]) {
        const tracker=new PositionTracker(fen),expected=new PositionTracker(fen);
        for(const move of moves) expected.chess.move(move);
        const seen=placement(expected.chess.fen());tracker.observe(seen,'bad');
        const result=tracker.observe(seen,'bad');
        assert.equal(result.ready,true,fen);assert.equal(result.fen,expected.chess.fen());
    }
});

test('arrow coordinates handle black orientation and malformed moves',()=>{
    assert.deepEqual(squareCenter('a8','white',800),{x:50,y:50});
    assert.deepEqual(squareCenter('a8','black',800),{x:750,y:750});
    assert.equal(arrowGeometry('quit','white',800),null);
    assert.deepEqual(arrowGeometry('e2e4','white',800).to,{x:450,y:450});
});


test('desktop options respect advertised minimum/maximum values',async()=>{
    const f=fixture();
    await assert.rejects(f.session.start(engine,{engineId:engine.engineId,options:{MultiPV:1000}}),/invalid UCI option/);
    await f.session.dispose();
});
