export function createClientLogs({send,authenticated,native,version='web'}) {
  const queue=[];let busy=false;let nativeAvailable=Boolean(native);let clientVersion=version;
  const record=(level,message,target='browser')=>{
    if(!authenticated())return;
    if(queue.length>=120)queue.shift();
    queue.push({level,message:String(message).slice(0,2048),target});
  };
  return {record,async flush(){
    if(busy)return;
    if(!authenticated()){queue.length=0;return;}
    busy=true;
    try {
      if(nativeAvailable){
        try {
          clientVersion=String(await native('app_version')).slice(0,40);
          for(const event of await native('take_client_logs'))record(event.level,event.message,event.target);
        } catch {nativeAvailable=false;} // Clientes antigos continuam funcionando.
      }
      if(!queue.length)return;
      const batch=queue.splice(0,30);
      const payload=()=>({platform:native?'desktop':'browser',version:clientVersion,events:batch});
      while(batch.length>1&&new TextEncoder().encode(JSON.stringify(payload())).length>24000)queue.unshift(batch.pop());
      try {
        const response=await send(payload());
        if(response.status>=500)queue.unshift(...batch);
      } catch {queue.unshift(...batch);}
      if(queue.length>120)queue.splice(0,queue.length-120);
    } finally {busy=false;}
  }};
}

export function startClientLogs(authenticated,version='web') {
  const native=globalThis.__TAURI__?.core?.invoke;
  const client=createClientLogs({authenticated,native,version,send:body=>fetch('/api/client-logs',{
    method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000),
  })});
  // Erros arbitrários não são serializados: objetos podem carregar credenciais.
  const describe=value=>value instanceof Error ? `JavaScript ${['Error','TypeError','RangeError','SyntaxError','AbortError'].includes(value.name)?value.name:'Error'}` : typeof value==='string'?value.slice(0,2048):'client diagnostic';
  addEventListener('error',()=>client.record('ERROR','Unhandled JavaScript error','uncaught'));
  addEventListener('unhandledrejection',event=>client.record('ERROR',describe(event.reason),'unhandledrejection'));
  for(const [method,level] of [['warn','WARN'],['error','ERROR']]){
    const original=console[method].bind(console);
    console[method]=(...args)=>{original(...args);client.record(level,args.map(describe).join(' '),'console');};
  }
  setInterval(()=>{void client.flush();},15000);
  return client;
}
