// Deliberately conservative, local-only 2D board recognition. No browser DOM,
// site API, OCR service, training data upload, or downloaded model is used.
const distance = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const medianColor = colors => [0,1,2].map(channel => median(colors.map(color => color[channel])));
const pixel = (image, x, y) => {
    const i = (Math.max(0,Math.min(image.height-1,Math.round(y))) * image.width
        + Math.max(0,Math.min(image.width-1,Math.round(x)))) * 4;
    return image.data.subarray(i, i+3);
};

function axisCandidates(image, vertical) {
    const extent = vertical ? image.height : image.width;
    const cross = vertical ? image.width : image.height;
    const found = new Map();
    for(let line = 3; line < cross; line += 7) {
        const runs = [];
        let start = 0, color = pixel(image, vertical ? line : 0, vertical ? 0 : line);
        for(let i = 1; i <= extent; i++) {
            const next = i < extent ? pixel(image, vertical ? line : i, vertical ? i : line) : [999,999,999];
            if(distance(color, next) > 25) {
                runs.push({ start, end: i, size: i-start, color });
                start = i; color = next;
            }
        }
        for(let i = 0; i + 5 < runs.length; i++) {
            const group = runs.slice(i, i+6), size = median(group.map(run => run.size));
            if(size < 14 || size*8 > extent || group.some(run => Math.abs(run.size-size) > 2)) continue;
            if(distance(group[0].color,group[1].color) < 25
                || group.some((run,j) => distance(run.color,group[j%2].color) > 22)) continue;
            // A run of six empty/background cells can begin at file/rank 0, 1 or 2.
            for(let offset = 0; offset <= 2; offset++) {
                const origin = group[0].start - size*offset;
                if(origin < 0 || origin + 8*size > extent) continue;
                const key = `${Math.round(origin/2)}:${Math.round(size)}`;
                const previous = found.get(key);
                found.set(key, { origin, size, votes: (previous?.votes || 0) + 1 });
            }
        }
    }
    return [...found.values()].sort((a,b) => b.votes-a.votes).slice(0,80);
}

export function boardQuality(image, rect) {
    const groups = [[],[]], squares = [];
    for(let row=0; row<8; row++) for(let col=0; col<8; col++) {
        const corners = [];
        for(const dx of [.07,.93]) for(const dy of [.07,.93])
            corners.push(pixel(image,rect.x+(col+dx)*rect.size/8,rect.y+(row+dy)*rect.size/8));
        const color = medianColor(corners), parity = (row+col)%2;
        groups[parity].push(color); squares.push({ color, parity });
    }
    const colors = groups.map(medianColor);
    if(distance(...colors) < 28) return 0;
    const good = squares.filter(square => distance(square.color,colors[square.parity]) < 28).length;
    return good/64;
}

export function detectBoard(image, previous = null) {
    if(previous && previous.x >= 0 && previous.y >= 0 && previous.x+previous.size <= image.width
        && previous.y+previous.size <= image.height && boardQuality(image,previous) >= .91) return previous;
    const horizontal = axisCandidates(image,false), vertical = axisCandidates(image,true);
    const candidates = [];
    for(const x of horizontal) for(const y of vertical) {
        if(Math.abs(x.size-y.size) > 1.5) continue;
        const size = (x.size+y.size)*4;
        const rect = { x: x.origin, y: y.origin, size };
        const quality = boardQuality(image,rect);
        if(quality >= .91) candidates.push({ ...rect, quality });
    }
    candidates.sort((a,b) => b.quality-a.quality || b.size-a.size);
    if(!candidates.length) return null;
    const best = candidates[0];
    // Two separate credible boards are ambiguous; do not pick a random game.
    if(candidates.some(item => item.quality >= best.quality-.02
        && Math.hypot(item.x-best.x,item.y-best.y) > best.size*.5)) return null;
    return { x: best.x, y: best.y, size: best.size };
}

const SIDE = 32;
function feature(data) {
    const corners = [];
    for(const x of [1,SIDE-2]) for(const y of [1,SIDE-2]) corners.push(pixel(data,x,y));
    const bg = medianColor(corners), vector = new Float32Array(SIDE*SIDE);
    let norm = 0, foreground = 0;
    for(let i=0; i<vector.length; i++) {
        const p = i*4;
        // Signed contrast distinguishes black and white pieces on either color square.
        const value = ((data.data[p]-bg[0])*.299+(data.data[p+1]-bg[1])*.587+(data.data[p+2]-bg[2])*.114)/255;
        vector[i] = value;
        norm += value*value;
        if(Math.abs(value) > .07) foreground++;
    }
    norm = Math.sqrt(norm);
    if(norm) for(let i=0; i<vector.length; i++) vector[i] /= norm;
    return { vector, foreground, bg };
}

export class PieceRecognizer {
    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.canvas.height = SIDE;
        this.context = this.canvas.getContext('2d', { willReadFrequently: true });
        this.templates = [];
    }
    async load(theme) {
        this.templates = [];
        for(const color of ['w','b']) for(const type of 'pnbrqk') {
            const image = new Image();
            image.src = new URL(`./pieces/${theme}/${color}${type}.svg`,import.meta.url).href;
            await image.decode();
            for(const scale of [.85,.925,1]) {
                this.context.clearRect(0,0,SIDE,SIDE);
                this.context.drawImage(image,SIDE*(1-scale)/2,SIDE*(1-scale)/2,SIDE*scale,SIDE*scale);
                const rgba = this.context.getImageData(0,0,SIDE,SIDE);
                // Keep alpha so each frame can use the actual square background.
                this.templates.push({ piece: color==='w'?type.toUpperCase():type, rgba });
            }
        }
        this.cache = new Map();
    }
    templateFeatures(bg) {
        const key = bg.map(value => Math.round(value/16)).join(',');
        if(this.cache.has(key)) return this.cache.get(key);
        const result = this.templates.map(({piece,rgba}) => {
            const data = new Uint8ClampedArray(rgba.data.length);
            for(let i=0; i<data.length; i+=4) {
                const alpha = rgba.data[i+3]/255;
                for(let channel=0; channel<3; channel++) data[i+channel] = rgba.data[i+channel]*alpha+bg[channel]*(1-alpha);
                data[i+3] = 255;
            }
            return { piece, vector: feature({ data, width:SIDE, height:SIDE }).vector };
        });
        if(this.cache.size > 32) this.cache.clear();
        this.cache.set(key,result);
        return result;
    }
    recognize(canvas, rect) {
        const cells = [], confidence = [];
        for(let row=0; row<8; row++) for(let col=0; col<8; col++) {
            this.context.clearRect(0,0,SIDE,SIDE);
            this.context.drawImage(canvas,rect.x+col*rect.size/8,rect.y+row*rect.size/8,rect.size/8,rect.size/8,0,0,SIDE,SIDE);
            const data = this.context.getImageData(0,0,SIDE,SIDE), sample = feature(data);
            if(sample.foreground < 20) { cells.push(null); continue; }
            const scores = new Map();
            for(const template of this.templateFeatures(sample.bg)) {
                let dot = 0;
                for(let i=0;i<sample.vector.length;i++) dot += sample.vector[i]*template.vector[i];
                scores.set(template.piece,Math.max(scores.get(template.piece)??-1,dot));
            }
            const sorted = [...scores].sort((a,b)=>b[1]-a[1]);
            if(sorted[0][1] < .88 || sorted[0][1]-sorted[1][1] < .025) return null;
            cells.push(sorted[0][0]); confidence.push(sorted[0][1]);
        }
        // Even a checkerboard with icons must not be mistaken for a chess game.
        if(cells.filter(piece=>piece==='K').length !== 1 || cells.filter(piece=>piece==='k').length !== 1) return null;
        return { cells, confidence: Math.min(...confidence) };
    }
}
