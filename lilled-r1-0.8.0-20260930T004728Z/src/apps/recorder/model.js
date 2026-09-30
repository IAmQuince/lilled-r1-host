export function recorderPrimaryIntent(state){
  if(state==='recording')return 'STOP';
  if(state==='finalizing')return 'WAIT';
  if(state==='review')return 'PLAY';
  if(state==='saved')return 'DONE';
  return 'RECORD';
}
export function recorderReadyState(){
  return {state:'idle',seconds:0,duration:0,position:0,hasClip:false,clipBytes:0,
    review:false,dirty:false,saved:false,savedId:'',sharePending:false,error:'',format:'WAV',waveform:[]};
}
