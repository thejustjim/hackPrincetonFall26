import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { graphPositions, scenarioSensorState, coverageComparison, createSimulationLoader, replayMinuteAt, scenarioAtTime, observationHorizon, REPLAY_DURATION_MS } from './src/simulation.js';
import { readPrototypeLocation, readMapMode } from './src/map-settings.js';
import { mockApi, mockSocket } from './src/mock.js';
import { isSimulatedNode } from './src/provenance.js';
const placement = JSON.parse(readFileSync(new URL('../web/network/placement.json', import.meta.url)));
const network = JSON.parse(readFileSync(new URL('../web/network/data.json', import.meta.url)));
assert.equal(network.scenarios.length, 7);
assert.deepEqual(placement.budgets.map(b => b.budget), [4,8,12,16,20]);
const positions = graphPositions(network.nodes);
assert.equal(positions.size, network.nodes.length);
for (const p of positions.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 960 && p.y >= 0 && p.y <= 600);
const caseWithMissing = network.scenarios.find(s => s.unavailable.length);
assert.ok(caseWithMissing);
for (const id of caseWithMissing.unavailable) assert.equal(scenarioSensorState(id, caseWithMissing, network.sensors), 'unavailable');
assert.equal(scenarioSensorState('x', {unavailable:['x'],alerts:[{sensor:'x'}],quiet:['x']}, ['x']), 'unavailable');
for (const plan of placement.budgets) {
 const c = coverageComparison(plan, placement.existing);
 assert.equal(c.total,117); assert.equal(c.observed, plan.metrics.observed);
 assert.equal(c.corroborated, plan.metrics.localized);
 assert.ok(c.observed <= c.total && c.corroborated <= c.observed);
}
// Prepared data is available in the same turn, even while remote refresh hangs.
let finishNetwork, failPlacement, refreshCalls = 0;
const snapshots = [];
const loader = createSimulationLoader({network,placement,onData:s=>snapshots.push(s),
 refreshNetwork:()=>{refreshCalls++;return new Promise(resolve=>{finishNetwork=resolve;});},
 refreshPlacement:()=>new Promise((_,reject)=>{failPlacement=reject;})});
const loading = loader.load();
assert.equal(snapshots.length,1); assert.equal(snapshots[0].network,network); assert.equal(snapshots[0].placement,placement);
assert.equal(loader.load(),loading); await Promise.resolve(); assert.equal(refreshCalls,1);
finishNetwork({...network,summary:'Refreshed independently'}); failPlacement(new Error('offline'));
await loading;
assert.equal(snapshots.at(-1).network.summary,'Refreshed independently');
assert.equal(snapshots.at(-1).placement,placement,'failed placement refresh must keep the working snapshot');
const networkOnly = [];
await createSimulationLoader({network,placement:null,onData:s=>networkOnly.push(s)}).load();
assert.equal(networkOnly[0].network,network); assert.equal(networkOnly[0].placement,null,'events must not require placement');
const malformed = [];
await createSimulationLoader({network,placement,onData:s=>malformed.push(s),
 refreshNetwork:async()=>({simulated:true,nodes:network.nodes}), refreshPlacement:async()=>({simulated:true,nodes:placement.nodes})}).load();
assert.equal(malformed.at(-1).network,network); assert.equal(malformed.at(-1).placement,placement);
await createSimulationLoader({network,placement,onData:s=>malformed.push(s), refreshNetwork:async()=>({...network,scenarios:[null]}),refreshPlacement:async()=>({...placement,budgets:[null]})}).load();
assert.equal(malformed.at(-1).network,network); assert.equal(malformed.at(-1).placement,placement);
// Every scenario replays from no observations to the exact recorded outcome.
assert.equal(REPLAY_DURATION_MS,24000);
assert.equal(observationHorizon(network.scenarios.find(s=>s.id==='delayed-sensor')),385);
assert.equal(scenarioAtTime(network.scenarios.find(s=>s.id==='delayed-sensor'),360,network.sensors).complete,false);
assert.equal(replayMinuteAt(0,12000),180); assert.equal(replayMinuteAt(180,12000),360); assert.equal(replayMinuteAt(0,48000),360);
for (const scenario of network.scenarios) {
 const saved = JSON.stringify(scenario);
 const start = scenarioAtTime(scenario,0,network.sensors);
 assert.equal(start.quiet.length,0); assert.equal(start.candidates.length,0);
 assert.equal(start.complete,false);
 for (const id of start.unavailable) assert.equal(scenarioSensorState(id,start,network.sensors),'unavailable');
 for (const id of start.waiting) assert.equal(scenarioSensorState(id,start,network.sensors),'waiting');
 const middle = scenarioAtTime(scenario,120,network.sensors);
 assert.ok(middle.alerts.every(a=>a.minute<=120)); assert.equal(middle.candidates.length,0);
 const end = scenarioAtTime(scenario,observationHorizon(scenario),network.sensors);
 assert.deepEqual(end.alerts,scenario.alerts); assert.deepEqual(end.quiet,scenario.quiet); assert.deepEqual(end.candidates,scenario.candidates);
 assert.equal(end.complete,true); assert.equal(JSON.stringify(scenario),saved,'replay must not mutate the prepared evidence');
}
const p12 = placement.budgets.find(b => b.budget === 12);
assert.equal(coverageComparison(p12, placement.existing).baselineObserved,87);
assert.equal(coverageComparison(p12, placement.existing).observed,103);
assert.ok(p12.metrics.median_first_alert_min > placement.existing.metrics.median_first_alert_min, 'UI must keep the conditional-median tradeoff, not claim every delay improves');
const storage = value => ({getItem:()=>JSON.stringify(value)});
const choice = {version:1,mode:'prototype',location:{name:'Chosen location',lat:41,lon:-73}};
assert.deepEqual(readPrototypeLocation(storage(choice)),choice.location);
assert.equal(readPrototypeLocation(storage(choice),true),null);
assert.equal(readPrototypeLocation(storage({...choice,mode:'demo'})),null);
assert.equal(readPrototypeLocation(storage({...choice,version:2})),null);
assert.equal(readPrototypeLocation(storage({...choice,location:{lat:'41',lon:-73}})),null);
assert.equal(readPrototypeLocation({getItem:()=>'{broken'}),null);
assert.equal(readMapMode(storage(choice)), 'prototype');
assert.equal(readMapMode(storage({...choice, mode:'demo'})), 'demo');
assert.equal(readMapMode(storage(choice), '?mock=1'), 'demo');
assert.equal(readMapMode(storage({...choice,mode:'demo'}), '?mode=prototype'), 'prototype');
assert.equal(readMapMode(storage({...choice,mode:'demo'}), '?api=http://localhost:8000'), 'prototype');
assert.equal(readMapMode(null, '?mode=demo'), 'demo');
assert.equal(readMapMode({getItem:()=>'{bad'}), 'prototype');
const sites = await mockApi.nodes();
assert.equal(sites.length,7);
assert.equal(sites.filter(n=>!isSimulatedNode(n,'mock')).length,0);
assert.ok(sites.every(n=>isSimulatedNode(n,'mock')));
assert.ok(isSimulatedNode({sim:false,latest:{mock:true}},'live'));
assert.equal(isSimulatedNode({sim:false,latest:{mock:false}},'live'),false);
assert.ok(isSimulatedNode({sim:true},'live'));
assert.equal(isSimulatedNode({sim:false},'live'),false);
for (const s of sites) { assert.equal(s.latest.verdict,'SAFE'); assert.equal(s.latest.filter,'NONE'); assert.ok(s.latest.anomaly < .2); }
for (const f of await mockApi.filters()) assert.equal(f.status,'OK');
// Drive the actual mock timers deterministically, without sleeping or network.
const originals = {setTimeout,clearTimeout,setInterval,clearInterval};
let now = 0, next = 1; const tasks = new Map();
globalThis.setTimeout = (fn,ms) => { const id=next++; tasks.set(id,{fn,at:now+ms,interval:0}); return id; };
globalThis.setInterval = (fn,ms) => { const id=next++; tasks.set(id,{fn,at:now+ms,interval:ms}); return id; };
globalThis.clearTimeout = globalThis.clearInterval = id => tasks.delete(id);
function advance(end) {
 while (true) {
  const entry=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
  if(!entry) break;
  const [id,t]=entry; now=t.at; if(t.interval) t.at+=t.interval; else tasks.delete(id); t.fn();
 }
 now=end;
}
try {
 const messages=[], socket=mockSocket(m=>messages.push({...m,emittedAt:now}));
 advance(120000);
 const background=messages.filter(m=>m.type==='reading'&&m.sim);
 assert.ok(background.length>=6);
 for(const m of background) { assert.equal(m.verdict,'SAFE'); assert.equal(m.filter,'NONE'); assert.ok(m.anomaly<.2); }
 const cups=messages.filter(m=>m.type==='reading'&&!m.sim&&m.phase==='before');
 assert.ok(cups.some(m=>m.verdict==='CLOUDY')&&cups.some(m=>m.verdict==='HIGH_TDS')&&cups.some(m=>m.verdict==='SAFE'));
 for(let i=1;i<cups.length;i++) assert.equal(cups[i].emittedAt-cups[i-1].emittedAt,24000,'cup examples must not overlap');
 for(const m of messages.filter(m=>m.type==='reading')) { assert.equal(m.mock,true); assert.ok(m.session); assert.ok(Number.isInteger(m.seq)); assert.equal(m.ph_est,!m.sim); }
 for(const m of messages.filter(m=>m.type==='decision'||m.type==='report')) assert.equal(m.source,'sample');
 const after=messages.find(m=>m.type==='reading'&&m.phase==='after');
 const pair=await mockApi.test(after.node,after.test);
 assert.equal(pair[0].session,pair[1].session); assert.equal(pair[1].id,after.id);
 socket.close(); const count=messages.length; advance(300000); assert.equal(messages.length,count);
} finally { Object.assign(globalThis,originals); }
console.log('Map simulation, placement, quiet background, cup timing and saved-location checks passed.');
