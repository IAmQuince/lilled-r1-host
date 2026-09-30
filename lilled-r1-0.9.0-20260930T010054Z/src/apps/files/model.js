const json=(value)=>JSON.stringify(value,null,2);
const size=text=>`${new TextEncoder().encode(text).length} B`;
export function virtualFiles(state,serializeState){
  const docs=[
    ['settings','Settings/current.json',()=>json({settings:serializeState(state).settings,motionCalibration:state.motion.calibration})],
    ['hsv','HSV/swatches.json',()=>json({swatches:state.hsv.swatches})],
    ['udaq','uDAQ/summary.json',()=>json({source:state.udaq.source,view:state.udaq.view,rateHz:state.udaq.sampleRate,samples:state.udaq.history.length,last:state.udaq.history.at(-1)||null})],
    ['messages','Messages/journal.json',()=>json({messages:state.communications.journal})],
    ['diagnostics','Diagnostics/status.json',()=>json({environment:state.motion.source,sensorFresh:state.motion.fresh,sequence:state.motion.sequence,calibration:state.motion.calibration})]
  ];
  if(state.synth.userPatch)docs.push(['synth','Synth/user.preset.json',()=>json(state.synth.userPatch)]);
  return docs.map(([id,name,makeText])=>({id:`virtual-${id}`,name,type:'JSON',kind:'virtual',size:size(makeText())}));
}
export function virtualFileText(id,state,serializeState){
  switch(id){
    case 'virtual-settings':return json({settings:serializeState(state).settings,motionCalibration:state.motion.calibration});
    case 'virtual-hsv':return json({swatches:state.hsv.swatches});
    case 'virtual-udaq':return json({source:state.udaq.source,view:state.udaq.view,rateHz:state.udaq.sampleRate,samples:state.udaq.history.length,last:state.udaq.history.at(-1)||null});
    case 'virtual-messages':return json({messages:state.communications.journal});
    case 'virtual-diagnostics':return json({environment:state.motion.source,sensorFresh:state.motion.fresh,sequence:state.motion.sequence,calibration:state.motion.calibration});
    case 'virtual-synth':return state.synth.userPatch?json(state.synth.userPatch):null;
    default:return null;
  }
}
export function syntaxTokens(line){
  const pattern=/("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|\b(-?\d+(?:\.\d+)?|true|false|null)\b/g;
  const result=[];let at=0,match;
  while((match=pattern.exec(line))){
    if(match.index>at)result.push({text:line.slice(at,match.index),kind:'plain'});
    result.push({text:match[0],kind:match[1]?'key':match[2]?'string':'value'});at=pattern.lastIndex;
  }
  if(at<line.length)result.push({text:line.slice(at),kind:'plain'});
  return result;
}
