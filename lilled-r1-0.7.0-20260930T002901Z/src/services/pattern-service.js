const ITERATIONS=20000;
const SHORT_LOCK_MS=5*60*1000;
const LONG_LOCK_MS=60*60*1000;

export const samePattern = (a,b) => a.length===b.length && a.every((v,i)=>v===b[i]);
export const validPattern = nodes => Array.isArray(nodes) && nodes.length>=4 && nodes.length<=9 &&
  new Set(nodes).size===nodes.length && nodes.every(n=>Number.isInteger(n)&&n>=0&&n<9);

export function appendPatternNode(nodes,node) {
  if(!Number.isInteger(node)||node<0||node>8||nodes.includes(node)||nodes.length>=9)return [...nodes];
  const result=[...nodes],previous=result.at(-1);
  if(previous!==undefined){
    const row0=Math.floor(previous/3),col0=previous%3,row1=Math.floor(node/3),col1=node%3;
    const dr=row1-row0,dc=col1-col0;
    if((dr===0||dc===0||dr===dc||dr===-dc)&&(Math.abs(dr)===2||Math.abs(dc)===2)){
      const middle=(row0+dr/2)*3+col0+dc/2;
      if(!result.includes(middle))result.push(middle);
    }
  }
  result.push(node);
  return result;
}

async function digest(nodes,salt) {
  if(!globalThis.crypto?.subtle)throw new Error('CRYPTO UNAVAILABLE');
  const material=new Uint8Array([nodes.length,...nodes]);
  const key=await crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new Uint8Array(salt),iterations:ITERATIONS},key,256));
}

function equalBytes(a,b) {
  if(a.length!==b.length)return false;
  let difference=0;
  for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
  return difference===0;
}

function validCredential(value) {
  return value?.version===1 && Array.isArray(value.salt) && value.salt.length===16 &&
    Array.isArray(value.hash) && value.hash.length===32 &&
    [...value.salt,...value.hash].every(n=>Number.isInteger(n)&&n>=0&&n<=255) &&
    Number.isInteger(value.failures) && value.failures>=0 && value.failures<=255 &&
    Number.isSafeInteger(value.lockoutUntil) && value.lockoutUntil>=0;
}

export class PatternService {
  constructor(platform) { this.platform=platform; this.credential=null; }
  get enrolled() { return Boolean(this.credential); }
  get failures() { return this.credential?.failures||0; }
  get lockoutUntil() { return this.credential?.lockoutUntil||0; }
  lockedOut(now=Date.now()) { return this.lockoutUntil>now; }
  async load() {
    const value=await this.platform.loadCredential();
    if(value!=null&&!validCredential(value))throw new Error('INVALID CREDENTIAL RECORD');
    this.credential=value;
    return this.enrolled;
  }
  async enroll(nodes,now=Date.now()) {
    if(!validPattern(nodes))return {ok:false,reason:'PATTERN TOO SHORT OR INVALID'};
    if(this.enrolled&&this.lockedOut(now))return {ok:false,reason:'LOCKED OUT'};
    if(!globalThis.crypto?.getRandomValues||!globalThis.crypto?.subtle)return {ok:false,reason:'CRYPTO UNAVAILABLE'};
    const salt=[...crypto.getRandomValues(new Uint8Array(16))];
    const hash=[...await digest(nodes,salt)];
    const credential={version:1,salt,hash,failures:0,lockoutUntil:0};
    await this.platform.saveCredential(credential);
    this.credential=credential;
    return {ok:true,reason:'PATTERN SAVED'};
  }
  async verify(nodes,now=Date.now()) {
    if(!this.enrolled)return {ok:false,reason:'PATTERN NOT ENROLLED'};
    if(!validPattern(nodes))return {ok:false,reason:'PATTERN TOO SHORT OR INVALID'};
    if(this.lockedOut(now))return {ok:false,reason:'LOCKED OUT'};
    let computed;
    try { computed=await digest(nodes,this.credential.salt); }
    catch { return {ok:false,reason:'CRYPTO UNAVAILABLE'}; }
    if(equalBytes(computed,this.credential.hash)){
      if(this.failures){this.credential.failures=0;this.credential.lockoutUntil=0;await this.platform.saveCredential(this.credential);}
      return {ok:true,reason:'ACCEPTED'};
    }
    const next={...this.credential,failures:Math.min(255,this.failures+1)};
    if(next.failures>=10)next.lockoutUntil=now+LONG_LOCK_MS;
    else if(next.failures>=5)next.lockoutUntil=now+SHORT_LOCK_MS;
    await this.platform.saveCredential(next);
    this.credential=next;
    return {ok:false,reason:next.lockoutUntil>now?`LOCKED OUT · ${next.failures>=10?'60':'5'} MIN`:'NO MATCH / RETRY'};
  }
  async clear() {
    await this.platform.deleteCredential();
    this.credential=null;
  }
}
