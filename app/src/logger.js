export function sanitize(value) {
  return String(value).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, raw => {
    try { const u = new URL(raw); return `${u.protocol}//${u.host}`; } catch { return '[url]'; }
  }).replace(/\b(cookie|set-cookie|authorization)\s*:[^\r\n]+/gi, '$1: [redacted]')
    .replace(/(["']?(?:access_token|refresh_token|client_secret|fol_session|state|token|secret|password|code|cookie|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;}\]]+)/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]').replace(/\?[^\s"'<>]*/g, '?[redacted]').slice(0, 8192);
}

const write = (level, args, attributes = {}) => {
  // Erros de upstream podem conter credenciais em formatos arbitrários.
  const message = sanitize(args.map(value => value instanceof Error ? (['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError'].includes(value.name) ? value.name : 'Error') : String(value)).join(' '));
  const record = { timestamp: new Date().toISOString(), severity: level, 'service.name': 'fazol-app', message };
  if (Object.keys(attributes).length) record.attributes = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, typeof value === 'string' ? sanitize(value) : value]),
  );
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export const logger = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  event: (level, message, attributes = {}) => write(level, [message], attributes),
};
