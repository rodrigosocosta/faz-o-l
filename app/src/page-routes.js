// Um padrão por rota também permite identificar cada página na telemetria.
export function registerPageRoutes(app, handler) {
  for (const route of ['/c/:id', '/c/:id/clipes', '/c/:id/clipes/:clip', '/u/:username', '/convite/:code']) app.get(route, handler);
}
