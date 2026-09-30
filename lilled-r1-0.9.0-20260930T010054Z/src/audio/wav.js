export function encodeWav(chunks,sampleRate){
  const frames=chunks.reduce((count,chunk)=>count+chunk.length,0);
  const bytes=new ArrayBuffer(44+frames*2),view=new DataView(bytes);
  const ascii=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
  ascii(0,'RIFF');view.setUint32(4,36+frames*2,true);ascii(8,'WAVE');ascii(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,frames*2,true);
  let offset=44;
  for(const chunk of chunks)for(const value of chunk){
    const sample=Math.max(-1,Math.min(1,value));
    view.setInt16(offset,sample<0?Math.round(sample*32768):Math.round(sample*32767),true);offset+=2;
  }
  return new Blob([bytes],{type:'audio/wav'});
}
export function waveformPeaks(chunks,bins=64){
  const total=chunks.reduce((n,chunk)=>n+chunk.length,0),peaks=new Array(bins).fill(0);
  let index=0;
  for(const chunk of chunks)for(const sample of chunk){
    const bin=Math.min(bins-1,Math.floor(index/Math.max(1,total)*bins));
    peaks[bin]=Math.max(peaks[bin],Math.abs(sample));index++;
  }
  return peaks;
}
export async function startPcmRecording(stream){
  const Context=window.AudioContext||window.webkitAudioContext;
  if(!Context||!window.AudioWorkletNode)throw new Error('AUDIO WORKLET UNAVAILABLE');
  const context=new Context({latencyHint:'interactive'});
  try{
    await context.audioWorklet.addModule(new URL('./pcm-worklet.js',import.meta.url));
    const source=context.createMediaStreamSource(stream);
    const node=new AudioWorkletNode(context,'lilled-pcm');
    const silent=context.createGain();silent.gain.value=0;
    const chunks=[];node.port.onmessage=event=>{if(event.data?.length)chunks.push(new Float32Array(event.data));};
    source.connect(node);node.connect(silent);silent.connect(context.destination);
    if(context.state==='suspended')await context.resume();
    return {format:'WAV',sampleRate:context.sampleRate,chunks,state:'recording',async stop(){
      node.port.postMessage('stop');source.disconnect();node.disconnect();silent.disconnect();
      await new Promise(resolve=>setTimeout(resolve,35));await context.close();this.state='inactive';
      return encodeWav(chunks,this.sampleRate);
    }};
  }catch(error){await context.close();throw error;}
}
