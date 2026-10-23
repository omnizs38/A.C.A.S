import { Chess } from './chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const placement = fen => fen.split(' ')[0];
export const uci = move => move.from + move.to + (move.promotion || '');

// Only advance through legal chess moves. Pixels cannot reveal turn/castling/EP.
export class PositionTracker {
    constructor(fen = START_FEN) { this.reset(fen); }
    reset(fen = START_FEN) {
        const chess = new Chess();
        if(!chess.load(fen)) throw new Error('Enter a valid complete starting FEN.');
        this.chess = chess;
        this.lastSeen = null;
        this.stable = 0;
        this.orientation = null;
    }
    observe(whiteBottom, blackBottom) {
        const candidates = [{ value: whiteBottom, orientation: 'white' }, { value: blackBottom, orientation: 'black' }];
        const key = whiteBottom + '|' + blackBottom;
        this.stable = key === this.lastSeen ? this.stable + 1 : 1;
        this.lastSeen = key;
        if(this.stable < 2) return { ready: false, reason: 'Waiting for a stable position…' };
        const current = placement(this.chess.fen());
        let found = candidates.find(item => item.value === current);
        if(found) {
            this.orientation = found.orientation;
            return { ready: true, fen: this.chess.fen(), orientation: this.orientation };
        }
        const matches = [];
        // At most two plies between captures. Never invent lost history.
        const seek = depth => {
            for(const move of this.chess.moves({ verbose: true })) {
                this.chess.move(move);
                const value = placement(this.chess.fen());
                const candidate = candidates.find(item => item.value === value);
                if(candidate) matches.push({ fen: this.chess.fen(), orientation: candidate.orientation });
                else if(depth > 1) seek(depth - 1);
                this.chess.undo();
            }
        };
        seek(1);
        if(!matches.length) seek(2);
        const unique = [...new Map(matches.map(item => [item.fen, item])).values()];
        if(unique.length !== 1) return { ready: false, reason: 'Position does not match legal history. Reset or provide its full FEN.' };
        found = unique[0];
        this.chess.load(found.fen);
        this.orientation = found.orientation;
        return { ready: true, ...found };
    }
    lost() { this.lastSeen = null; this.stable = 0; }
    legalMoves(moves) {
        const legal = new Set(this.chess.moves({ verbose: true }).map(uci));
        return moves.filter(move => legal.has(move));
    }
}

export function piecePlacement(cells, flipped = false) {
    const data = flipped ? [...cells].reverse() : cells;
    const rows = [];
    for(let rank = 0; rank < 8; rank++) {
        let row = '', empty = 0;
        for(let file = 0; file < 8; file++) {
            const piece = data[rank * 8 + file];
            if(!piece) empty++;
            else { if(empty) row += empty; empty = 0; row += piece; }
        }
        if(empty) row += empty;
        rows.push(row);
    }
    return rows.join('/');
}
