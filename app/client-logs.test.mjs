import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import express from 'express';
import { clientLogsRouter } from './src/client-logs.js';

test('logs exigem sessão e origem correta; sanitizam e limitam os eventos', async () => {
  const emitted=[];
  const app=express();
  app.use((req,_res,next)=>{if(req.headers['x-test-user'])req.user={id:'test'};next();});
  app.use(clientLogsRouter({origin:'https://live.example.test',emit:(...args)=>emitted.push(args)}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/api/client-logs`;
  const send=(body,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:'https://live.example.test',...headers},body:JSON.stringify(body)});
  try {
    assert.equal((await send({events:[]})).status,401);
    assert.equal((await send({events:[]},{'x-test-user':'1',origin:'https://evil.test'})).status,403);
    assert.equal((await send({events:'invalid'},{'x-test-user':'1'})).status,400);
    assert.equal((await send({platform:'desktop',version:'1.2.3',events:[{level:'ERROR',message:'wss://user:secret@example.test/path?token=secret fol_session=cookie-secret',target:'capture'}]},{'x-test-user':'1'})).status,204);
    assert.equal(emitted.length,1);
    assert.ok(!JSON.stringify(emitted).includes('secret'));
    assert.equal(emitted[0][2]['client.platform'],'desktop');
    assert.equal((await send({events:Array.from({length:31},()=>({level:'ERROR',message:'x'}))},{'x-test-user':'1'})).status,400);
    for(let i=0;i<3;i++)await send({events:Array.from({length:30},()=>({level:'WARN',message:'x'}))},{'x-test-user':'1'});
    await send({events:Array.from({length:29},()=>({message:'x'}))},{'x-test-user':'1'});
    assert.equal((await send({events:[{message:'x'}]},{'x-test-user':'1'})).status,429);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
