// Instrumentação explícita: funciona com ESM e não captura cookies, queries ou corpos.
import { context, propagation, trace, metrics, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

let runtime;
const noop = async () => {};
const knownMethod = method => ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(method) ? method : 'OTHER';

export function sanitize(value) {
  return String(value).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, raw => {
    try { const u = new URL(raw); return `${u.protocol}//${u.host}`; } catch { return '[url]'; }
  }).replace(/\b(cookie|set-cookie|authorization)\s*:[^\r\n]+/gi, '$1: [redacted]')
    .replace(/(["']?(?:access_token|refresh_token|client_secret|fol_session|state|token|secret|password|code|cookie|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;}\]]+)/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]').replace(/\?[^\s"'<>]*/g, '?[redacted]').slice(0, 8192);
}

export function emitLog(level, message, attributes = {}) {
  runtime?.logger.emit({
    severityNumber: { INFO: 9, WARN: 13, ERROR: 17 }[level],
    severityText: level, body: sanitize(message), context: context.active(), attributes,
  });
}

export function initTelemetry({
  enabled = process.env.OTEL_ENABLED === 'true',
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://fazol-otel-collector:4318',
  interval = 15000,
} = {}) {
  if (!enabled) return { flush: noop, shutdown: noop };
  if (runtime) return runtime.lifecycle;
  const base = endpoint.replace(/\/+$/, '');
  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'fazol-app',
    'service.version': process.env.APP_VERSION || 'development',
    'deployment.environment.name': process.env.OTEL_ENVIRONMENT || 'production',
  });
  const options = path => ({ url: `${base}/v1/${path}`, timeoutMillis: 1000 });
  const traces = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(
    new OTLPTraceExporter(options('traces')), { maxQueueSize: 1024, maxExportBatchSize: 128, scheduledDelayMillis: 5000, exportTimeoutMillis: 1500 },
  )] });
  traces.register();
  const reader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(options('metrics')), exportIntervalMillis: interval, exportTimeoutMillis: 1500 });
  const meters = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(meters);
  const logs = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({
    exporter: new OTLPLogExporter(options('logs')), maxQueueSize: 1024, maxExportBatchSize: 128, scheduledDelayMillis: 5000, exportTimeoutMillis: 1500,
  })] });
  const meter = meters.getMeter('fazol.http');
  const requests = meter.createCounter('http.server.request.count');
  const duration = meter.createHistogram('http.server.request.duration', { unit: 's' });
  meter.createObservableGauge('process.memory.usage', { unit: 'By' }).addCallback(result => result.observe(process.memoryUsage().rss));
  meter.createObservableGauge('process.uptime', { unit: 's' }).addCallback(result => result.observe(process.uptime()));
  meter.createObservableCounter('process.cpu.time', { unit: 's' }).addCallback(result => {
    const cpu = process.cpuUsage(); result.observe((cpu.user + cpu.system) / 1e6);
  });
  const lifecycle = {
    async flush() { await Promise.allSettled([traces.forceFlush(), meters.forceFlush(), logs.forceFlush()]); },
    async shutdown() {
      runtime = undefined;
      await Promise.allSettled([traces.shutdown(), meters.shutdown(), logs.shutdown()]);
    },
  };
  runtime = { tracer: trace.getTracer('fazol.http'), logger: logs.getLogger('fazol'), requests, duration, lifecycle };
  return lifecycle;
}

export function httpTelemetry(req, res, next) {
  if (!runtime || req.path === '/healthz') return next();
  const current = runtime;
  const method = knownMethod(req.method);
  const parent = propagation.extract(context.active(), req.headers);
  const span = current.tracer.startSpan(method, { kind: SpanKind.SERVER }, parent);
  const started = performance.now();
  let ended = false;
  const finish = (streaming = false) => {
    if (ended) return; ended = true;
    // req.route usa o padrão do Express, nunca o ID/URL enviado pelo usuário.
    const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
    const status = streaming || res.writableFinished ? res.statusCode : 499;
    const attrs = { 'http.request.method': method, 'http.route': route, 'http.response.status_code': status };
    span.updateName(`${method} ${route}`); span.setAttributes(attrs);
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    current.requests.add(1, attrs); current.duration.record((performance.now() - started) / 1000, attrs);
    span.end();
  };
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const result = writeHead.apply(this, args);
    if (String(res.getHeader('content-type')).startsWith('text/event-stream')) finish(true);
    return result;
  };
  res.once('finish', () => finish()); res.once('close', () => finish());
  context.with(trace.setSpan(parent, span), next);
}

export async function tracedFetch(url, options = {}) {
  if (!runtime) return fetch(url, options);
  const method = knownMethod((options.method || 'GET').toUpperCase());
  return runtime.tracer.startActiveSpan(`HTTP ${method}`, { kind: SpanKind.CLIENT }, async span => {
    const headers = new Headers(options.headers);
    propagation.inject(context.active(), headers, { set: (carrier,key,value) => carrier.set(key,value) });
    span.setAttribute('http.request.method', method);
    try {
      const response = await fetch(url, { ...options, headers });
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    } catch (err) {
      span.setAttribute('error.type', err.name || 'Error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally { span.end(); }
  });
}
