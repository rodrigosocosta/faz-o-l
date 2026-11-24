import express from 'express';
import { emitLog, sanitize } from './telemetry.js';

export function clientLogsRouter({origin,emit=emitLog}) {
  const router=express.Router();
  const budgets=new Map();
  router.post('/api/client-logs',(req,res,next)=>{
    if(!req.user)return res.sendStatus(401);
    if(req.get('origin')!==origin)return res.sendStatus(403);
    if(!req.is('application/json'))return res.sendStatus(415);
    next();
  },express.json({limit:'32kb'}),(req,res)=>{
    const {events,platform,version}=req.body||{};
    if(!Array.isArray(events)||events.length>30||events.some(e=>!e||typeof e.message!=='string'||e.message.length>2048))return res.sendStatus(400);
    const now=Date.now();
    for(const [key,value] of budgets)if(value.until<=now)budgets.delete(key);
    let budget=budgets.get(req.user.id);
    if(!budget){if(budgets.size>=2000)return res.sendStatus(429);budget={count:0,until:now+60000};budgets.set(req.user.id,budget);}
    if(budget.count+events.length>120)return res.sendStatus(429);
    budget.count+=events.length;
    for(const event of events)emit(['INFO','WARN','ERROR'].includes(event.level)?event.level:'ERROR',sanitize(event.message),{
      'client.platform':platform==='desktop'?'desktop':'browser',
      'client.version':typeof version==='string'&&/^[a-zA-Z0-9._-]{1,40}$/.test(version)?version:'unknown',
      'client.target':typeof event.target==='string'&&/^[a-zA-Z0-9_:.-]{1,80}$/.test(event.target)?event.target:'client',
    });
    res.sendStatus(204);
  });
  return router;
}
