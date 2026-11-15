import assert from 'node:assert/strict';
import { prototypeHealth, prototypeNodes, demoReturnURL } from './src/prototype-api.js';
import { readMapMode } from './src/map-settings.js';
for (const health of [{ok:true,mock:true}, {ok:true}, null, {ok:false,mock:false}, {ok:true,mock:'false'}]) {
 const calls = [];
 await assert.rejects(() => prototypeNodes(async path => { calls.push(path); return health; }), /physical prototype/i);
 assert.deepEqual(calls,['/health'], 'a mock/unverified gateway must not expose node data');
}
const calls = [], nodes = [{node:'tank-01',sim:false}];
assert.equal(await prototypeNodes(async path => { calls.push(path); return path==='/health' ? {ok:true,mock:false} : nodes; }),nodes);
assert.deepEqual(calls,['/health','/api/nodes']);
await assert.rejects(() => prototypeNodes(async path => path==='/health' ? {ok:true,mock:false} : {}), /invalid node list/);
let reconnects=0;
const changingGateway=async () => ({ok:true,mock:reconnects++>0});
await prototypeHealth(changingGateway);
await assert.rejects(()=>prototypeHealth(changingGateway),/physical prototype/i,'reconnects must recheck MOCK mode');
const store={getItem:()=>JSON.stringify({version:1,mode:'prototype'})};
assert.equal(readMapMode(store),'prototype');
assert.equal(readMapMode(store,'?mock=1'),'demo');
let back=new URL(demoReturnURL('http://localhost:8976/map/?api=http%3A%2F%2F192.168.1.20%3A8000','prototype','http://192.168.1.20:8000'));
assert.equal(back.pathname,'/demo/'); assert.equal(back.searchParams.get('mode'),'prototype');
assert.equal(back.searchParams.get('api'),'http://192.168.1.20:8000');
back=new URL(demoReturnURL('http://localhost:8976/map/','demo','http://192.168.1.20:8000'));
assert.equal(back.searchParams.get('mode'),'demo'); assert.ok(back.searchParams.has('demo')); assert.ok(!back.searchParams.has('api'));
console.log('Prototype gateway mock rejection, reconnect checks, and return-link context tests passed.');
