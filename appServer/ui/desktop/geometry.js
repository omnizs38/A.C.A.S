export function squareCenter(square, orientation = 'white', size = 800) {
    if(!/^[a-h][1-8]$/.test(square)) throw new Error('Invalid square.');
    let file = square.charCodeAt(0)-97, row = 8-Number(square[1]);
    if(orientation === 'black') { file = 7-file; row = 7-row; }
    return { x:(file+.5)*size/8, y:(row+.5)*size/8 };
}
export function arrowGeometry(move, orientation, size) {
    if(!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return null;
    return { from: squareCenter(move.slice(0,2),orientation,size), to:squareCenter(move.slice(2,4),orientation,size) };
}
