import { emitLog, sanitize } from './telemetry.js';

const write = (level, args) => {
  // Erros de upstream podem conter credenciais em formatos arbitrários.
  const message = sanitize(args.map(value => value instanceof Error ? (['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError'].includes(value.name) ? value.name : 'Error') : String(value)).join(' '));
  const record = { timestamp: new Date().toISOString(), severity: level, 'service.name': 'fazol-app', message };
  process.stdout.write(`${JSON.stringify(record)}\n`);
  emitLog(level, message);
};

export const logger = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
};
