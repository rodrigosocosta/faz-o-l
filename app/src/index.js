import { registerPageRoutes } from './page-routes.js';
import { clientLogsRouter } from './client-logs.js';
import { httpTelemetry } from './telemetry.js';
import { logger } from './logger.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { authRouter, sessionMiddleware } from './auth.js';
import { canCreateChannels, channelsRouter, migrateLegacy } from './channels.js';
import { livekitRouter } from './livekit.js';
import { clipsRouter } from './clips.js';
import { eventsRouter } from './events.js';
import { startBot } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const require = createRequire(import.meta.url);
const livekitClientDist = path.dirname(require.resolve('livekit-client'));

migrateLegacy();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(httpTelemetry);

app.get('/healthz', (_req, res) => res.send('ok'));

app.use(sessionMiddleware);
app.use(clientLogsRouter({origin:new URL(config.publicUrl).origin}));
app.use(authRouter());
app.use(channelsRouter());
app.use(livekitRouter());
app.use(await clipsRouter());
app.use(eventsRouter());

app.get('/api/me', (req, res) => {
  res.json({
    user: req.user,
    authMode: config.authMode,
    canCreate: canCreateChannels(req.user),
    limits: { maxStreamers: config.maxStreamers, maxViewers: config.maxViewers },
  });
});

// SDK do LiveKit servido localmente (sem depender de CDN)
// "no-cache" = sempre revalida com o servidor (ETag): depois de atualizar o servidor,
// o site e o app desktop pegam o código novo na hora, sem esperar o cache expirar.
const revalidate = (res) => res.setHeader('Cache-Control', 'no-cache');

app.use(
  '/vendor/livekit',
  express.static(livekitClientDist, {
    setHeaders: (res, file) => {
      revalidate(res);
      if (file.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    },
  }),
);

app.use(express.static(publicDir, { setHeaders: revalidate }));

// Rotas do site (canal, perfil, convite): o app.js decide o que mostrar
registerPageRoutes(app, (_req, res) => {
  revalidate(res);
  res.sendFile(path.join(publicDir, 'index.html'));
});

export const server = app.listen(config.port, () => {
  logger.info(`[app] Faz o L rodando em ${config.publicUrl} (porta ${config.port}, login: ${config.authMode})`);
});

startBot().catch((err) => logger.error('[bot] Não foi possível iniciar o bot:', err));
