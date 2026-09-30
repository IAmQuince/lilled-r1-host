import { plotRange, TRACE_VIEWS, visibleSamples } from './model.js';

const COLORS = { x:'#43d7e5', y:'#b180ef', z:'#f7c148', m:'#56dc91' };

export function drawUdaqPlot(canvas, state) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height;
  context.fillStyle = '#041019'; context.fillRect(0,0,width,height);
  const samples = visibleSamples(state.history);
  const channels = TRACE_VIEWS[state.view] || TRACE_VIEWS.XYZ;
  if (!samples.length) {
    context.fillStyle = '#91a0aa'; context.font = '9px monospace';
    const prompt = !state.running ? 'PAUSED / NO SAMPLES' :
      state.inputSource === 'DEMO' ? 'ACQUIRING DEMO' :
      state.sourceAvailable ? 'WAITING FOR FRESH IMU' : 'SENSOR NOT AVAILABLE';
    context.fillText(prompt, 9, height/2);
    return;
  }
  const { min, max } = plotRange(samples, channels);
  const yFor = value => height - 8 - (value - min) / (max - min) * (height - 16);
  context.strokeStyle = '#1c3343'; context.lineWidth = 1;
  for(let i=0;i<=4;i++) {
    const x = Math.round(i*(width-1)/4)+.5;
    const y = Math.round(i*(height-1)/4)+.5;
    context.beginPath();context.moveTo(x,0);context.lineTo(x,height);context.stroke();
    context.beginPath();context.moveTo(0,y);context.lineTo(width,y);context.stroke();
  }
  for (const key of channels) {
    context.strokeStyle = COLORS[key]; context.lineWidth = 1.5;
    context.beginPath(); let active = false;
    samples.forEach((sample,i) => {
      const value = sample[key];
      const previous = samples[i-1];
      if (!Number.isFinite(value)) { active=false; return; }
      const x = samples.length===1 ? width/2 : i*(width-1)/(samples.length-1);
      const y = yFor(value);
      if (!active || (previous && (sample.t-previous.t>1000 || sample.seq-previous.seq>1))) context.moveTo(x,y);
      else context.lineTo(x,y);
      active=true;
    });
    context.stroke();
  }
  context.fillStyle = '#eef4f8'; context.font = '8px monospace';
  context.fillText(max.toFixed(2), 2, 9);
  context.fillText(min.toFixed(2), 2, height-2);
  if (state.inputSource === 'DEMO') {
    context.fillStyle = '#f59e37'; context.fillRect(width-42,2,40,11);
    context.fillStyle = '#070a10'; context.fillText('DEMO',width-38,10);
  }
}
