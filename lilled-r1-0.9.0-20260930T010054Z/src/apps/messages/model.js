// Verbatim labels and leaf text from LED/apps/communications/content/
// communications/default_messages.ini and character_wheel.cpp.
export const QUICK_TREE={
  root:{label:'QUICK MESSAGE',up:['QUESTIONS','questions'],right:['STATEMENTS','statements'],down:['DIRECTIONS','directions'],left:['MOODS','moods']},
  questions:{label:'QUESTIONS',up:['STATUS?','question_status'],right:['LOCATION?','question_location'],down:['NEEDS?','question_needs'],left:['TIMING?','question_timing']},
  statements:{label:'STATEMENTS',up:['I AM SAFE','I am safe.'],right:['I AM DELAYED','I am delayed.'],down:['I ARRIVED','I have arrived.'],left:['I NEED HELP','I need help.']},
  directions:{label:'DIRECTIONS',up:['COME HERE','Come here.'],right:['HOLD','Hold position.'],down:['RETURN','Return to base.'],left:['MOVE SAFE','Move to safety.']},
  moods:{label:'MOODS',up:['CALM','I feel calm.'],right:['CONCERNED','I feel concerned.'],down:['EXCITED','I feel excited.'],left:['TIRED','I feel tired.']},
  question_status:{label:'STATUS',up:['ARE YOU SAFE','Are you safe?'],right:['YOUR STATUS','What is your status?'],down:['CAN YOU MOVE','Can you move?'],left:['NEED HELP','Do you need help?']},
  question_location:{label:'LOCATION',up:['WHERE ARE YOU','Where are you?'],right:['AT BASE','Are you at base?'],down:['NEAR MARKER','Are you near the marker?'],left:['SEND POSITION','Can you send your position?']},
  question_needs:{label:'NEEDS',up:['NEED WATER','Do you need water?'],right:['NEED MEDICAL','Do you need medical help?'],down:['NEED PICKUP','Do you need pickup?'],left:['NEED SUPPLIES','Do you need supplies?']},
  question_timing:{label:'TIMING',up:['ETA','What is your ETA?'],right:['LEAVING WHEN','When are you leaving?'],down:['ARRIVING WHEN','When will you arrive?'],left:['WAIT HOW LONG','How long should I wait?']}
};
export const QUICK_PARENTS={root:'root',questions:'root',statements:'root',directions:'root',moods:'root',question_status:'questions',question_location:'questions',question_needs:'questions',question_timing:'questions'};
export function chooseQuick(node,direction){
  const choice=QUICK_TREE[node||'root']?.[direction];
  if(!choice)return null;
  const [label,value]=choice,leaf=!(value in QUICK_TREE);
  return {label,leaf,message:leaf?value:'',node:leaf?node:value};
}
export const CHARACTER_MODES=['ABC','abc','123','?!'];
export const CHARACTER_SETS={ABC:'ABCDEFGHIJKLMNOPQRSTUVWXYZ',abc:'abcdefghijklmnopqrstuvwxyz','123':'0123456789','?!':".,?!-'/:;@#&()"};
export function wheelCharacter(mode,index){const set=CHARACTER_SETS[mode]||CHARACTER_SETS.ABC;return set[((index%set.length)+set.length)%set.length];}
export function rotateCharacter(mode,index,steps){const count=(CHARACTER_SETS[mode]||CHARACTER_SETS.ABC).length;return ((index+steps)%count+count)%count;}
export function nextCharacterMode(mode){return CHARACTER_MODES[(CHARACTER_MODES.indexOf(mode)+1)%CHARACTER_MODES.length];}
export function appendMessageCharacter(draft,char){return draft.length>=200?draft:draft+char;}
