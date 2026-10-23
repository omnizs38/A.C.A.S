import { arrowGeometry } from './geometry.js';
const canvas = document.getElementById('arrows');
let state = { moves:[],orientation:'white' };
function draw() {
    const ratio = window.devicePixelRatio || 1;
    const width = innerWidth, height = innerHeight;
    canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio,ratio);
    ctx.clearRect(0,0,width,height);
    state.moves.slice().reverse().forEach((move,reverseIndex)=>{
        const index = state.moves.length-reverseIndex-1;
        const geometry = arrowGeometry(move,state.orientation,width);
        if(!geometry) return;
        const from = geometry.from, to = {x:geometry.to.x,y:geometry.to.y*height/width};
        from.y *= height/width;
        const angle = Math.atan2(to.y-from.y,to.x-from.x), cell = Math.min(width,height)/8;
        const head = cell*.27, end = {x:to.x-Math.cos(angle)*head*.6,y:to.y-Math.sin(angle)*head*.6};
        ctx.globalAlpha = index===0?.88:.6;
        ctx.strokeStyle = ctx.fillStyle = ['#65d6ad','#69a8ff','#d6acff','#ffcf70','#ff9393'][index];
        ctx.lineWidth = cell*(index===0?.12:.08); ctx.lineCap='round';
        ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(end.x,end.y);ctx.stroke();
        ctx.beginPath();ctx.moveTo(to.x,to.y);
        ctx.lineTo(to.x-head*Math.cos(angle-.52),to.y-head*Math.sin(angle-.52));
        ctx.lineTo(to.x-head*Math.cos(angle+.52),to.y-head*Math.sin(angle+.52));ctx.closePath();ctx.fill();
    });
}
window.overlayAPI.onMoves(payload=>{state=payload;draw();});
addEventListener('resize',draw);
