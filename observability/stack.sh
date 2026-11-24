#!/bin/sh
# SigNoz tem um projeto Compose próprio; down preserva os volumes.
set -eu
OBS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname -- "$OBS_DIR")
cd "$OBS_DIR"
compose() {
  if [ -f "$PROJECT_DIR/.env" ]; then
    docker compose --env-file "$PROJECT_DIR/.env" -f "$OBS_DIR/pours/deployment/compose.yaml" "$@"
  else
    docker compose -f "$OBS_DIR/pours/deployment/compose.yaml" "$@"
  fi
}
case "${1:-status}" in
  render)
    FOUNDRY_BIN=${FOUNDRYCTL:-foundryctl}
    "$FOUNDRY_BIN" --no-updater --no-ledger version | grep -q 'v0.5.0' || {
      echo 'Instale Foundry v0.5.0; consulte observability/README.md.' >&2; exit 1;
    }
    "$FOUNDRY_BIN" --no-updater --no-ledger forge -f casting.yaml -p pours
    compose config --quiet
    ;;
  up) compose up -d --wait --wait-timeout 600 ;;
  down) compose down ;;
  status) compose ps -a ;;
  config) compose config ;;
  logs) compose logs --tail 100 -f ;;
  *) echo "Uso: sh observability/stack.sh render|up|down|status|logs|config" >&2; exit 2 ;;
esac
