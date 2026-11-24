import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { initTelemetry, httpTelemetry, tracedFetch } from './src/telemetry.js';
import { logger } from './src/logger.js';
import { registerPageRoutes } from './src/page-routes.js';

test('exporta trace HTTP, chamada filha, log e métricas sem tokens ou IDs nas dimensões', async () => {
  const payloads = [];
  const collector = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    payloads.push({ path: req.url, data: JSON.parse(body) });
    res.setHeader('content-type', 'application/json'); res.end('{}');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const endpoint = `http://127.0.0.1:${collector.address().port}`;
  const telemetry = initTelemetry({ enabled: true, endpoint, interval: 60000 });
  const downstream = http.createServer((req, res) => res.end(req.headers.traceparent || 'missing')).listen(0, '127.0.0.1');
  await once(downstream, 'listening');
  const app = express(); app.use(httpTelemetry);
  registerPageRoutes(app, (_req,res) => res.send('page'));
  app.get('/events', (_req,res) => {
    res.setHeader('content-type','text/event-stream');res.flushHeaders();res.write('data: hello\n\n');
  });
  app.get('/clips/:id', async (_req, res) => {
    logger.error('falha em https://user:password@example.com/callback?code=oauth-secret', { token: 'attribute-secret' });
    logger.error('wss://user:ws-password@example.com/live?access_token=ws-secret');
    logger.error('/callback?access_token=relative-secret&state=state-secret');
    logger.error('Cookie: session=cookie-secret; other=other-secret');
    logger.error('{"client_secret":"json-secret","access_token":"json-token"}');
    logger.error(new Error('opaque-upstream-secret'));
    const response = await tracedFetch(`http://127.0.0.1:${downstream.address().port}/clip?token=fetch-secret`);
    res.send(await response.text());
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/clips/private-id?token=request-secret`, {
      headers: { traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01', cookie: 'secret-cookie' },
    });
    assert.match(await response.text(), /^00-1234567890abcdef1234567890abcdef-/);
    await fetch(`http://127.0.0.1:${server.address().port}/unknown/private-id?code=unknown-secret`);
    for(const page of ['/c/private-id','/u/private-id','/convite/private-id']) await fetch(`http://127.0.0.1:${server.address().port}${page}`);
    const stream = await fetch(`http://127.0.0.1:${server.address().port}/events`);
    await telemetry.flush();
    const encoded = JSON.stringify(payloads);
    for (const secret of ['oauth-secret','password','attribute-secret','fetch-secret','request-secret','secret-cookie','unknown-secret','private-id','ws-password','ws-secret','relative-secret','state-secret','cookie-secret','other-secret','json-secret','json-token','opaque-upstream-secret']) {
      assert.ok(!encoded.includes(secret), `vazou ${secret}`);
    }
    const traces = payloads.filter(p => p.path === '/v1/traces').flatMap(p => p.data.resourceSpans).flatMap(r => r.scopeSpans).flatMap(s => s.spans);
    assert.ok(traces.some(s => s.name === 'GET /clips/:id' && s.traceId === '1234567890abcdef1234567890abcdef'));
    assert.ok(traces.some(s => s.kind === 3 && s.traceId === '1234567890abcdef1234567890abcdef'));
    for(const page of ['/c/:id','/u/:username','/convite/:code']) assert.ok(traces.some(s => s.name === `GET ${page}`));
    assert.ok(traces.some(s => s.name === 'GET /events' && s.attributes.some(a => a.key === 'http.response.status_code' && Number(a.value.intValue) === 200)), 'SSE deve aparecer enquanto a conexão está aberta');
    await stream.body.cancel();
    const logs = payloads.filter(p => p.path === '/v1/logs').flatMap(p => p.data.resourceLogs).flatMap(r => r.scopeLogs).flatMap(s => s.logRecords);
    assert.ok(logs.some(l => l.traceId === '1234567890abcdef1234567890abcdef' && l.severityText === 'ERROR'));
    assert.ok(payloads.some(p => p.path === '/v1/metrics'));
    collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve));
    const started = performance.now();
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/clips/another-id`)).status, 200);
    await telemetry.flush();
    assert.ok(performance.now() - started < 3000, 'exportação indisponível deve ter prazo limitado');
  } finally {
    await telemetry.shutdown();
    for (const s of [server, downstream, collector]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  }
});

test('collector indisponível e modo desabilitado não impedem HTTP', async () => {
  const telemetry = initTelemetry({ enabled: false });
  const app = express(); app.use(httpTelemetry); app.get('/ok', (_req,res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/ok`)).text(), 'ok');
    await telemetry.shutdown();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
