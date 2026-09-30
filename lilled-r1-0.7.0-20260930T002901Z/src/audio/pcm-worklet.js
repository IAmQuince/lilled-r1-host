class LilLedPcmProcessor extends AudioWorkletProcessor{
  constructor(){super();this.running=true;this.port.onmessage=event=>{if(event.data==='stop')this.running=false;};}
  process(inputs){
    if(!this.running)return false;
    const channels=inputs[0];
    if(channels?.length){
      const frames=channels[0].length,mono=new Float32Array(frames);
      for(const channel of channels)for(let i=0;i<frames;i++)mono[i]+=channel[i]/channels.length;
      this.port.postMessage(mono,[mono.buffer]);
    }
    return true;
  }
}
registerProcessor('lilled-pcm',LilLedPcmProcessor);
