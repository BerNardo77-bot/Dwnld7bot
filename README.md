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
