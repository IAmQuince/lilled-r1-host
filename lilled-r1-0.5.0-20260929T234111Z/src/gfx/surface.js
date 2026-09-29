import { GLCD_FONT } from './glcd-font.js';

export const PALETTE = Object.freeze({
  bg:'#070a10', panel:'#0f161f', raised:'#19222d', line:'#344452',
  text:'#eef4f8', muted:'#91a0aa', cyan:'#43d7e5', violet:'#b180ef',
  gold:'#f7c148', green:'#56dc91', amber:'#f59e37', red:'#ef5b5b',
  water:'#41b5f2', hydrogen:'#f475b7', oxygen:'#698fff'
});

export class Surface {
  constructor(canvas) { this.canvas=canvas; this.ctx=canvas.getContext('2d',{alpha:false}); this.dpr=0; this.resize(); }
  resize() {
    const dpr=Math.max(1,window.devicePixelRatio||1);
    const viewport=Math.round(window.innerHeight||292);
    const height=viewport<=320?Math.max(292,viewport):292;
    if (this.dpr===dpr && this.height===height && this.canvas.width===Math.round(240*dpr)) return;
    this.dpr=dpr; this.height=height; this.canvas.width=Math.round(240*dpr); this.canvas.height=Math.round(height*dpr);
    this.canvas.style.width='240px'; this.canvas.style.height=`${height}px`;
    this.ctx.setTransform(dpr,0,0,dpr,0,0);
    this.ctx.imageSmoothingEnabled=false;
  }
  clear(color=PALETTE.bg) { this.resize(); this.rect(0,0,240,this.height,color); }
  rect(x,y,w,h,color) { this.ctx.fillStyle=color; this.ctx.fillRect(x,y,w,h); }
  line(x1,y1,x2,y2,color,width=1) { const c=this.ctx;c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke(); }
  frame(x,y,w,h,color=PALETTE.line) { this.line(x+.5,y+.5,x+w-.5,y+.5,color);this.line(x+.5,y+h-.5,x+w-.5,y+h-.5,color);this.line(x+.5,y+.5,x+.5,y+h-.5,color);this.line(x+w-.5,y+.5,x+w-.5,y+h-.5,color); }
  text(value,x,y,scale=1,color=PALETTE.text,maxWidth=Infinity) {
    const c=this.ctx, pixel=Math.max(1,Math.round(scale*this.dpr))/this.dpr;
    const cell=6*pixel;
    const count=Math.min(String(value).length,Math.floor(maxWidth/cell));
    c.fillStyle=color;
    for(let i=0;i<count;i++) {
      const code=String(value).charCodeAt(i)&255;
      for(let col=0;col<5;col++) {
        const bits=GLCD_FONT[code*5+col];
        for(let row=0;row<7;row++)if(bits&(1<<row)) {
          const px=Math.round((x+i*cell+col*pixel)*this.dpr)/this.dpr;
          const py=Math.round((y+row*pixel)*this.dpr)/this.dpr;
          c.fillRect(px,py,pixel,pixel);
        }
      }
    }
    return count*cell;
  }
}
