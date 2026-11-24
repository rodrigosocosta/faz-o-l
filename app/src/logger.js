import { emitLog, sanitize } from './telemetry.js';

const write = (level, args) => {
  const message = sanitize(args.map(value => value instanceof Error ? value.message : String(value)).join(' '));
  const record = { timestamp: new Date().toISOString(), severity: level, 'service.name': 'fazol-app', message };
  process.stdout.write(`${JSON.stringify(record)}\n`);
  emitLog(level, message);
};

export const logger = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
};
