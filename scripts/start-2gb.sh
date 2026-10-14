#!/data/data/com.termux/files/usr/bin/bash
# Arranca el servidor local de Bot API (hasta ~2 GB) y luego el bot.
# Si algo falla, el bot arranca igual con api.telegram.org (50 MB).
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PORT_TG="${LOCAL_BOT_API_PORT:-8089}"
DIR="${TGBOTAPI_DIR:-$HOME/.tgbotapi}"
if ! command -v telegram-bot-api >/dev/null 2>&1; then
  echo "[2gb] falta telegram-bot-api. Corre primero: bash scripts/install-botapi.sh"
  exec node src/index.js
fi
if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
  echo "[2gb] faltan TELEGRAM_API_ID / TELEGRAM_API_HASH en .env (my.telegram.org). Arranco con 50 MB."
  exec node src/index.js
fi
mkdir -p "$DIR/work" "$DIR/tmp"
# Si quedó uno viejo corriendo en ese puerto, lo reutiliza
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT_TG/"; then
  echo "[2gb] servidor local ya estaba corriendo en $PORT_TG"
else
  echo "[2gb] iniciando telegram-bot-api local en 127.0.0.1:$PORT_TG"
  telegram-bot-api --local --api-id="$TELEGRAM_API_ID" --api-hash="$TELEGRAM_API_HASH" \
    --http-ip-address=127.0.0.1 --http-port="$PORT_TG" --dir="$DIR/work" --temp-dir="$DIR/tmp" \
    --verbosity=1 > "$DIR/server.log" 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null' EXIT INT TERM
  ok=0; i=0
  while [ $i -lt 40 ]; do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT_TG/"; then ok=1; break; fi
    if ! kill -0 $SRV 2>/dev/null; then break; fi
    i=$((i+1)); sleep 1
  done
  if [ $ok != 1 ]; then
    echo "[2gb] el servidor local no arrancó (mira $DIR/server.log). Arranco con 50 MB."
    tail -5 "$DIR/server.log" 2>/dev/null
    unset TELEGRAM_API_ROOT
    node src/index.js
    exit $?
  fi
  echo "[2gb] servidor local listo en ${i}s"
fi
# Limpieza de archivos viejos del servidor (cada 10 min, >30 min)
( while sleep 600; do find "$DIR/work" "$DIR/tmp" -type f -mmin +30 -delete 2>/dev/null; done ) &
CLEAN=$!
export TELEGRAM_API_ROOT="http://127.0.0.1:$PORT_TG"
node src/index.js
code=$?
kill $CLEAN 2>/dev/null
exit $code
