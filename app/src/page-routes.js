// Um padrão por rota também permite identificar cada página na telemetria.
export function registerPageRoutes(app, handler) {
  for (const route of ['/c/:id', '/u/:username', '/convite/:code']) app.get(route, handler);
}
