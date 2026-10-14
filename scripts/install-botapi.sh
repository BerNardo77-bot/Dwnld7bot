#!/data/data/com.termux/files/usr/bin/bash
# Instala (una sola vez) el servidor local de Telegram Bot API en Termux.
# Termux ya trae el paquete compilado: no hay que compilar nada (~1-3 min, ~25 MB).
set -e
echo "[install] actualizando lista de paquetes…"
pkg update -y
echo "[install] instalando telegram-bot-api y curl…"
pkg install -y telegram-bot-api curl
telegram-bot-api --version 2>/dev/null || telegram-bot-api --help | head -1
mkdir -p "$HOME/.tgbotapi/work" "$HOME/.tgbotapi/tmp"
echo
echo "[install] Listo. Ahora pon TELEGRAM_API_ID y TELEGRAM_API_HASH en .env (nano .env)"
echo "[install] y arranca con:  npm run start2gb"
