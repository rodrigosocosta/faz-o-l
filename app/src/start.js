import { initTelemetry } from './telemetry.js';

const telemetry = initTelemetry();
const { server } = await import('./index.js');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await telemetry.shutdown();
    process.exit(0);
  });
}
