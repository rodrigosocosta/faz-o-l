import assert from 'node:assert/strict';
import test from 'node:test';
import {createClientLogs} from './public/client-logs.js';

test('fila limitada, lotes, falha de rede e logout',async()=>{
 let logged=true;let failing=true;const sent=[];
 const client=createClientLogs({authenticated:()=>logged,send:async body=>{if(failing)throw new Error('offline');sent.push(body);return {status:204}}});
 for(let i=0;i<150;i++)client.record('WARN',String(i));
 await client.flush();failing=false;await client.flush();
 assert.equal(sent[0].events.length,30);assert.equal(sent[0].events[0].message,'30');
 logged=false;await client.flush();logged=true;await client.flush();assert.equal(sent.length,1);
});

test('desktop junta logs nativos e mantém compatibilidade com versões antigas',async()=>{
 const sent=[];const client=createClientLogs({authenticated:()=>true,native:async cmd=>cmd==='app_version'?'1.2.3':[{level:'WARN',message:'native warning',target:'capture'}],send:async body=>{sent.push(body);return{status:204}}});
 await client.flush();assert.equal(sent[0].platform,'desktop');assert.equal(sent[0].version,'1.2.3');assert.equal(sent[0].events[0].target,'capture');
 const old=createClientLogs({authenticated:()=>true,native:async()=>{throw new Error('unknown command')},send:async body=>{sent.push(body);return{status:204}}});
 old.record('ERROR','webview error');await old.flush();assert.equal(sent.length,2);
});

test('lotes de texto Unicode respeitam o tamanho máximo do servidor',async()=>{
 const sent=[];const client=createClientLogs({authenticated:()=>true,send:async body=>{sent.push(body);return{status:204}}});
 for(let i=0;i<30;i++)client.record('ERROR','😀'.repeat(1000));
 await client.flush();assert.ok(new TextEncoder().encode(JSON.stringify(sent[0])).length<25000);
});
