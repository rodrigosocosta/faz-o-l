// Teste real Node → gravador Go; não exige uma live nem credenciais externas.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { initTelemetry, httpTelemetry, tracedFetch } from '../app/src/telemetry.js';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const express = require('express');
const binary = process.argv[2];
assert.ok(binary, 'Uso: node observability/test-integration.mjs /caminho/recorder');

const captured = [];
const collector = http.createServer(async (req,res) => {
  const chunks=[];for await (const chunk of req) chunks.push(chunk);
  const body=Buffer.concat(chunks);
  if (req.headers['content-type']?.includes('json')) {
    captured.push(JSON.parse(body));res.setHeader('content-type','application/json');res.end('{}');
  } else {res.setHeader('content-type','application/x-protobuf');res.end();}
}).listen(0,'127.0.0.1');await once(collector,'listening');
const endpoint = process.env.TEST_OTLP_ENDPOINT || `http://127.0.0.1:${collector.address().port}`;
const temporary = await mkdtemp(path.join(os.tmpdir(),'fazol-observability-'));
const reservation = http.createServer().listen(0,'127.0.0.1');await once(reservation,'listening');
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const child=spawn(binary,[],{env:{...process.env,LISTEN:`127.0.0.1:${port}`,LIVEKIT_API_KEY:'test',LIVEKIT_API_SECRET:'test',LIVEKIT_WS_URL:'ws://127.0.0.1:1',BUFFER_DIR:path.join(temporary,'buffer'),CLIPS_DIR:path.join(temporary,'clips'),OTEL_ENABLED:'true',OTEL_EXPORTER_OTLP_ENDPOINT:endpoint,OTEL_SERVICE_NAME:'fazol-recorder'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
let childError;child.on('error',error=>childError=error);
const telemetry=initTelemetry({enabled:true,endpoint});
const app=express();app.use(httpTelemetry);
app.post('/clips/:id',async (_req,res)=>{
  const response=await tracedFetch(`http://127.0.0.1:${port}/clip`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'testclip',seconds:5})});
  res.status(response.status).send(await response.text());
});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
try {
  let ready=false;
  for(let i=0;i<100;i++){
    if(childError)throw childError;
    try{ready=(await fetch(`http://127.0.0.1:${port}/health`)).ok;}catch{}
    if(ready)break;await delay(100);
  }
  assert.ok(ready,'gravador não iniciou');
  const response=await fetch(`http://127.0.0.1:${server.address().port}/clips/testclip`,{method:'POST',headers:{traceparent:'00-1234567890abcdef1234567890abcdef-1234567890abcdef-01'},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,409);await response.text();
  await telemetry.flush();await delay(50);
  const records=logs.split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
  assert.ok(records.some(record=>record.trace_id==='1234567890abcdef1234567890abcdef'&&record.msg==='clipe falhou'),'Go não recebeu o contexto W3C da API');
  if(!process.env.TEST_OTLP_ENDPOINT){
    assert.ok(JSON.stringify(captured).includes('1234567890abcdef1234567890abcdef'),'faltou trace Node no OTLP');
  }
  console.log('INTEGRATION OK: Node → Go, mesmo trace, erro de clipe observado');
} finally {
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(6000)]);if(child.exitCode===null)child.kill('SIGKILL');
  await telemetry.shutdown();collector.closeAllConnections();await new Promise(resolve=>collector.close(resolve));
  await rm(temporary,{recursive:true,force:true});
}
