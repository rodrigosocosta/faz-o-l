import { emitLog, sanitize } from './telemetry.js';

const write = (level, args, attributes = {}) => {
  // Erros de upstream podem conter credenciais em formatos arbitrários.
  const message = sanitize(args.map(value => value instanceof Error ? (['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError'].includes(value.name) ? value.name : 'Error') : String(value)).join(' '));
  const record = { timestamp: new Date().toISOString(), severity: level, 'service.name': 'fazol-app', message };
  process.stdout.write(`${JSON.stringify(record)}\n`);
  emitLog(level, message, attributes);
};

export const logger = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  event: (level, message, attributes = {}) => write(level, [message], attributes),
};
