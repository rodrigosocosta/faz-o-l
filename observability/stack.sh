#!/bin/sh
# SigNoz tem um projeto Compose próprio; down preserva os volumes.
set -eu
OBS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname -- "$OBS_DIR")
OBS_TRAEFIK=false
if [ "${1:-}" = "--traefik" ]; then
  OBS_TRAEFIK=true
  shift
fi
cd "$OBS_DIR"
compose() {
  if [ "$OBS_TRAEFIK" = true ]; then
    set -- -f "$OBS_DIR/pours/deployment/compose.yaml" -f "$OBS_DIR/compose.traefik.yml" "$@"
  else
    set -- -f "$OBS_DIR/pours/deployment/compose.yaml" "$@"
  fi
  if [ -f "$PROJECT_DIR/.env" ]; then
    set -- --env-file "$PROJECT_DIR/.env" "$@"
  fi
  docker compose "$@"
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
  config) shift; compose config "$@" ;;
  logs) compose logs --tail 100 -f ;;
  *) echo "Uso: sh observability/stack.sh [--traefik] render|up|down|status|logs|config" >&2; exit 2 ;;
esac
