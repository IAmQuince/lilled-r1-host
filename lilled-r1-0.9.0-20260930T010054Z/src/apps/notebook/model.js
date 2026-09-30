export function calculatorInput(state,key){
  const next={...state};
  if(key==='C')return {display:'0',stored:null,operator:null,fresh:true};
  if(/[0-9]/.test(key)&&key.length===1){next.display=(next.fresh||next.display==='0'?key:next.display+key).slice(0,12);next.fresh=false;return next;}
  if(key==='.'&&!next.display.includes('.')){next.display+='.';next.fresh=false;return next;}
  const left=Number(next.stored),right=Number(next.display);
  if(key==='='&&next.operator){const result=next.operator==='+'?left+right:next.operator==='-'?left-right:next.operator==='×'?left*right:right===0?NaN:left/right;next.display=Number.isFinite(result)?String(Number(result.toPrecision(10))):'ERROR';next.stored=null;next.operator=null;next.fresh=true;return next;}
  if(['+','-','×','÷'].includes(key)){next.stored=right;next.operator=key;next.fresh=true;}
  return next;
}
export function monthGrid(year,month){const first=new Date(year,month,1).getDay(),days=new Date(year,month+1,0).getDate();return Array.from({length:42},(_,i)=>i-first+1).map(day=>day>=1&&day<=days?day:null);}
export function rulerPixels(mm,pxPerMm){return Math.max(0,mm*pxPerMm);}
