# Dwnld7bot

Bot de Telegram **@Dwnld7ds_bot** para correr en **Termux** (Android). Basado en el código de bbboy v1.5.33, pero es un proyecto aparte: sin Render, sin Railway, sin servidor local de Bot API (tope de envío ~50 MB).

Descargas (YouTube, TikTok, X/Twitter, Instagram, Facebook, podcasts), búsqueda, PDF y más. `/menu` muestra todo.

## Instalar en Termux

1. Detén el script viejo de Pydroid (dos programas con el mismo token = error 409).
2. Abre una **sesión nueva** de Termux (desliza desde la izquierda → New session). No toques `~/Luffy7`.
3. Instala:
   ```
   pkg update
   pkg install -y git nodejs-lts ffmpeg python
   pip install -U yt-dlp
   ```
4. Clona (repo privado: en *Password* pega tu token de GitHub):
   ```
   git clone https://github.com/BerNardo77-bot/Dwnld7bot.git ~/Dwnld7bot
   cd ~/Dwnld7bot
   cp .env.example .env
   nano .env
   ```
   Pon tu token de @BotFather después de `TELEGRAM_BOT_TOKEN=`. Guarda con CTRL+O, Enter, CTRL+X.
5. Instala y arranca:
   ```
   npm install --omit=optional
   npm start
   ```

"Unauthorized" = token mal o revocado → saca el actual en @BotFather.

## Actualizar
```
cd ~/Dwnld7bot
git pull
npm install --omit=optional
npm start
```

## Modo 2 GB (servidor local de Bot API)

Sin esto Telegram solo deja enviar ~50 MB. Con el servidor local en el mismo teléfono: hasta ~2 GB.

1. Entra a https://my.telegram.org → *API development tools* y copia `api_id` y `api_hash` (no los pegues en ningún chat).
2. `nano .env` y llena `TELEGRAM_API_ID=` y `TELEGRAM_API_HASH=`.
3. Una sola vez: `npm run install-botapi` (paquete ya compilado de Termux, 1-3 min).
4. Arranca con `npm run start2gb`.

La primera vez el bot hace `logOut` en la API oficial (Telegram lo exige para moverlo al servidor local). Si después vuelves a `npm start` (50 MB), Telegram puede tardar ~10 min en aceptarlo.
Logs del servidor: `~/.tgbotapi/server.log`.
