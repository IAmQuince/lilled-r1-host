import { encodeText } from './qr-encoder.js';

const byId = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = (promise, ms) => Promise.race([Promise.resolve(promise), sleep(ms).then(() => { throw new Error('TIMEOUT'); })]);
const stamp = () => Math.round(performance.now());
const report = {
  schema: 'r1-probe/1', version: '0.1.0', generatedAt: new Date().toISOString(),
  display: {}, capabilities: {}, sensors: {}, inputs: [], events: [], frame: {}, notes: []
};
let page = 0;
let running = false;
let started = stamp();
let voiceActive = false;
const previousPluginMessage = window.onPluginMessage;
window.onPluginMessage = data => {
  try { previousPluginMessage?.(data); } catch {}
  report.notes.push(`plugin message: ${JSON.stringify(data).slice(0, 400)}`);
  render();
};

function describe(value) {
  try { return { type: typeof value, value: JSON.parse(JSON.stringify(value)) }; }
  catch { return { type: typeof value, value: String(value) }; }
}
function measureDisplay() {
  report.display = {
    dpr: devicePixelRatio, innerWidth, innerHeight,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
    viewport: window.visualViewport ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale } : null,
    userAgent: navigator.userAgent
  };
  report.capabilities = {
    creationSensors: !!window.creationSensors?.accelerometer,
    creationStoragePlain: !!window.creationStorage?.plain,
    creationStorageSecure: !!window.creationStorage?.secure,
    pluginMessages: !!window.PluginMessageHandler?.postMessage,
    voiceHandler: !!window.CreationVoiceHandler?.postMessage,
    closeWebView: !!window.closeWebView?.postMessage,
    getBattery: !!navigator.getBattery,
    wakeLock: !!navigator.wakeLock?.request,
    microphone: !!navigator.mediaDevices?.getUserMedia,
    cameraEnumeration: !!navigator.mediaDevices?.enumerateDevices,
    mediaRecorder: !!window.MediaRecorder,
    audioWorklet: !!window.AudioWorkletNode,
    downloadAttribute: 'download' in document.createElement('a'),
    webMidi: !!navigator.requestMIDIAccess
  };
  render();
}
for (const eventName of ['scrollUp', 'scrollDown', 'sideClick', 'longPressStart', 'longPressEnd']) {
  window.addEventListener(eventName, event => {
    const item = { event: eventName, atMs: stamp() - started, detail: describe(event.detail) };
    report.inputs.push(item);
    if (report.inputs.length > 100) report.inputs.shift();
    render();
  });
}
for (const eventName of ['devicemotion', 'deviceorientation']) {
  window.addEventListener(eventName, event => {
    const rows = report.events.filter(row => row.event === eventName);
    if (rows.length >= 5) return;
    report.events.push({ event: eventName, atMs: stamp() - started,
      value: eventName === 'devicemotion' ? {
        accelerationIncludingGravity: describe(event.accelerationIncludingGravity),
        acceleration: describe(event.acceleration), rotationRate: describe(event.rotationRate), interval: event.interval
      } : { alpha: event.alpha, beta: event.beta, gamma: event.gamma, absolute: event.absolute } });
    render();
  });
}
async function sampleSensor(frequency) {
  const sensor = window.creationSensors?.accelerometer;
  if (!sensor?.start) return { status: 'UNAVAILABLE', samples: [] };
  const result = { requestedHz: frequency, available: 'UNKNOWN', availabilityMs: null, samples: [], status: 'WAIT' };
  const startAt = stamp();
  if (sensor.isAvailable) {
    try { result.available = await timeout(sensor.isAvailable(), 1500); }
    catch (error) { result.available = error.message; }
  }
  result.availabilityMs = stamp() - startAt;
  try {
    sensor.start(raw => {
      result.count = (result.count || 0) + 1;
      if (result.samples.length < 5) result.samples.push({ atMs: stamp() - startAt, raw: describe(raw) });
    }, { frequency });
    await sleep(1500);
    result.status = result.count ? 'DATA' : 'NO DATA';
    result.observedHz = Math.round(((result.count || 0) / 1.5) * 10) / 10;
  } catch (error) { result.status = `ERROR: ${error.message}`; }
  finally { try { sensor.stop?.(); } catch (error) { result.stopError = error.message; } }
  return result;
}
async function measureFrame() {
  const intervals = [];
  let last = stamp();
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const now = performance.now(); intervals.push(now - last); last = now;
  }
  intervals.sort((a,b) => a-b);
  report.frame = { medianMs: +intervals[30].toFixed(2), p95Ms: +intervals[57].toFixed(2) };
}
async function measureAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try {
    const context = new Audio();
    report.capabilities.audio = { sampleRate: context.sampleRate, baseLatency: context.baseLatency ?? null, state: context.state };
    await context.close();
  } catch (error) { report.capabilities.audio = { error: error.message }; }
}
async function runProbe() {
  if (running) return;
  running = true; byId('run').textContent = 'MEASURING';
  measureDisplay();
  await measureAudio();
  if (navigator.getBattery) {
    try { const battery = await timeout(navigator.getBattery(), 1500); report.capabilities.battery = { level: battery.level, charging: battery.charging }; }
    catch (error) { report.capabilities.battery = { error: error.message }; }
  }
  if (navigator.mediaDevices?.enumerateDevices) {
    try { report.capabilities.mediaDevices = (await timeout(navigator.mediaDevices.enumerateDevices(), 1500)).map(d => ({ kind:d.kind, label:!!d.label })); }
    catch (error) { report.capabilities.mediaDevices = { error:error.message }; }
  }
  for (const rate of [10,30,60,100]) { report.sensors[`hz${rate}`] = await sampleSensor(rate); render(); }
  await measureFrame();
  report.generatedAt = new Date().toISOString();
  try {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(report))));
    await window.creationStorage?.plain?.setItem?.('r1-probe-report', encoded);
  } catch (error) { report.notes.push(`storage save: ${error.message}`); }
  try { localStorage.setItem('r1-probe-report', JSON.stringify(report)); } catch {}
  running = false; byId('run').textContent = 'RUN AGAIN'; render();
}
function row(label, value) {
  const div = document.createElement('div'); div.className = 'row';
  const name = document.createElement('span'); name.className = 'label'; name.textContent = `${label} `;
  const val = document.createElement('span'); val.textContent = typeof value === 'string' ? value : JSON.stringify(value);
  div.append(name,val); return div;
}
function addText(text, css='') { const el=document.createElement('p');el.className=css;el.textContent=text;byId('content').append(el); }
function compact() {
  const sensor = report.sensors.hz30 || {};
  const raw = sensor.samples?.[0]?.raw;
  const capabilities = Object.entries(report.capabilities).filter(([,value])=>value===true).map(([name])=>name).join(',');
  return JSON.stringify({ v:1,d:report.display.dpr,w:report.display.innerWidth,h:report.display.innerHeight,
    s:sensor.status||'NOT RUN',hz:sensor.observedHz||0,raw:raw?.type==='string' ? String(raw.value).slice(0,60) : raw?.value||null,
    dm:report.events.some(e=>e.event==='devicemotion')?1:0,
    io:report.inputs.map(i=>i.event[0]).join('').slice(-20),c:capabilities,f:report.frame.p95Ms });
}
function drawQr(data) {
  const qr = encodeText(data);
  const canvas = document.createElement('canvas');canvas.className='qr';canvas.width=canvas.height=qr.size+8;
  const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='black';for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.modules[y][x])ctx.fillRect(x+4,y+4,1,1);
  byId('content').append(canvas);
}
function render() {
  byId('page').textContent = `${page+1}/3`;
  byId('content').replaceChildren();
  if (page===0) {
    addText('Move the R1 during the probe. Try wheel up/down, side click and side hold. The sensor sweep takes about 6 seconds.');
    byId('content').append(row('DISPLAY', `${report.display.innerWidth||'?'}×${report.display.innerHeight||'?'} CSS / DPR ${report.display.dpr||'?'}`));
    byId('content').append(row('SENSORS', Object.fromEntries(Object.entries(report.sensors).map(([k,v])=>[k,`${v.status} ${v.observedHz||0} Hz`]))));
    byId('content').append(row('INPUT EVENTS', report.inputs.length));
    byId('content').append(row('MOTION EVENTS', report.events.length));
    byId('content').append(row('FRAME P95', report.frame.p95Ms??'NOT RUN'));
  } else if (page===1) {
    addText('Live physical inputs and raw payloads', 'small');
    const voice=document.createElement('button');voice.textContent=voiceActive?'STOP VOICE':'TEST VOICE';
    voice.onclick=()=>{try {window.CreationVoiceHandler?.postMessage(voiceActive?'stop':'start');voiceActive=!voiceActive;render();}
      catch(error){report.notes.push(`voice: ${error.message}`);render();}};
    byId('content').append(voice);
    for(const item of report.inputs.slice(-10).reverse()) byId('content').append(row(item.event,item.atMs));
    for(const item of report.events) byId('content').append(row(item.event,item.value));
    for(const [rate,data] of Object.entries(report.sensors)) byId('content').append(row(rate,data));
    for(const note of report.notes.slice(-5)) byId('content').append(row('NOTE',note));
  } else {
    addText('Compact report QR. Full JSON remains in Creation storage and can be downloaded if the WebView supports download.', 'small');
    try { drawQr(compact()); } catch(error) { addText(`QR unavailable: ${error.message}`,'warn'); }
    const download=document.createElement('button');download.textContent='DOWNLOAD JSON';download.onclick=()=>{
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
      a.download='r1-probe-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    };byId('content').append(download);
  }
}
byId('prev').onclick=()=>{page=(page+2)%3;render();};
byId('next').onclick=()=>{page=(page+1)%3;render();};
byId('run').onclick=runProbe;
try { const saved=localStorage.getItem('r1-probe-report');if(saved)Object.assign(report,JSON.parse(saved)); } catch {}
measureDisplay();
window.__r1Probe = { report: () => structuredClone(report), run: runProbe };
