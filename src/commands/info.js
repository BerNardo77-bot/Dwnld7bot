const startedAt = Date.now()

function uptimeStr() {
  const ms = Date.now() - startedAt
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

export const helpText = `⚓ Dwnld7bot v1.3.0

Descargas a disco hasta 50 GB (videos en partes de hasta ~1.9 GB, máx. 26 partes).
Todas en alta calidad. Si pesa más que el tope de envío (49 MB, o ~1.9 GB con servidor local), comprime o manda link.

📥 Descargas (HD)
/play /mp3 — audio YouTube
/ytvideo /mp4 /ytvideohd /mp4hd — video YouTube 1080p
/ytvideo @canal [palabras] — 10 videos del canal para elegir
/tiktok /tt — TikTok video
/tiktokmp3 /ttmp3 — TikTok audio
/podcast /pod /antennapod — Podcasts (buscar, RSS, AntennaPod, mp3)
/ig /instagram — Instagram
/fb /facebook — Facebook
/x /twitter /xdl /tw /xdownloader — X/Twitter video e imágenes
/spotify /sp — Spotify
/mediafire /mf — MediaFire
/pdf /gdrive /drive /gd — Google Drive público, link directo a PDF o página web → PDF (más que el tope de envío → solo link)
/dl /get — link directo .mp4/.mp3
/xvideos /xv — XVideos HD
/xnxx — XNXX HD

🎨 Stickers
/sticker /s — responde a una foto, o envía foto con caption /sticker
/stickers — los 8 stickers de Grok Bot

🔍 Utilidades
/traducir /traduce /tr /translate — traduce texto (ej: /traducir en Hola) o 🎙️🖼️ responde a una nota de voz/audio o a una foto/captura: te mando el texto, la traducción, cómo se pronuncia y la voz (/tr = español→inglés u otro→español · /tr ja · /tr fr · /tr pt>es) · audio de hasta 5 horas (te marco el avance; si es muy largo te llega en .txt)
/ping — latencia
/menu /help /start — este menú

🔞 NSFW
/danbooru /dbooru — tag
/gelbooru /gbooru — tag
/r34 /rule34 /rule — tag
/xnxx — XNXX search o URL
/anal /violar — interaction
/cum /eyacular — interaction
/undress /encuerar — interaction
/fuck /coger — interaction
/spank /nalgada — interaction
/lickpussy /lameruncoño — interaction
/fap /paja — interaction
/grope — interaction
/sixnine /69 — interaction
/suckboobs /chupartetas — interaction
/grabboobs — interaction
/blowjob /mamar /bj — interaction
/boobjob /rusa — interaction
/yuri /tijeras — interaction
/footjob — interaction
/cummouth — interaction
/cumshot — interaction
/handjob — interaction
/lickass /lamercullo — interaction
/lickdick /lamerpolla — interaction
(responde a un mensaje para apuntar a alguien)


🎮 Economia (on por defecto)
/daily /bal /work /crime /fish /hunt /mine /steal /pay
/dep /withdraw /flip /slot /rt /ppt /math /eboard /einfo

🃏 Gacha
/rw /roll /rf — roll waifu (15 min, con imagen)
/claim /c — reclama el roll (2 min)
/harem /miswaifus — tu lista
/winfo /charinfo — info + imagen
/serieinfo /animeinfo · /slist /animelist
/ginfo — ayuda gacha
/sell /vender · /givechar (responde a alguien)
/delchar · /waifusboard · /vote
/trade /haremshop /buychar /gacha enable|disable

👤 Perfil
/perfil /level /setdesc /setgenre /sethobby /marry /divorce

🤖 IA
/ia /chatgpt /gpt — ChatGPT
/gemini /geminis — Gemini
/deepseek /ds — DeepSeek
/grok — Grok
/nano /nanobanana — editar foto con prompt (o generar desde texto)

🔍 Busqueda
/google /gg /buscar — búsqueda web (top 5 con link)
/wiki /wikipedia — Wikipedia
/imagen /img /image — imagen (Google + Pinterest)
/pin /pinterest — Pinterest (tema o link)
/ytsearch /search /yts — YouTube
/ttsearch /tiktoksearch /tts — TikTok
/apk /aptoide /apkdl — busca APK por nombre (no por link; más que el tope de envío → solo link)
/ams /applemusicsearch — Apple Music / iTunes
/apple /am — Apple Music: link de canción → audio MP3, álbum → lista, o nombre / página web
/radio /fm — radios en vivo (Radio Browser): busca por nombre, país o ciudad y graba un fragmento MP3 (60 s; "2 10" = 10 min, máx. 30)
/space — grabación de un Space de X (link x.com/i/spaces/…) en MP3; en partes si es muy largo
/mapa /maps /ubicacion — ubicación en el mapa (lugar, lat,lon o link de Google Maps) + link de Google Maps
/envivo /envivos /live — en vivo de YouTube (link o @canal) o TikTok (tiktok @usuario o link): link directo para VLC + grabar 5-30 min en MP3
/tv /canal — TV en vivo: /tv <canal> (busca en listas públicas iptv-org, ej. /tv milenio · /tv antena 3 es) o /tv <link .m3u8/rtmp>; eliges canal y graba de 5 min a 5 horas en video (/tvmin <min> para otro número); /tvcancel cancela la grabación

🎭 Anime (responde a alguien para apuntar)
/hug /abrazo /kiss /muak /beso /pat /slap /dance /baile /cry
/bite /morder /blush /bonk /bully /cuddle /handhold /highfive
/lick /wave /wink /happy /feliz /sad /triste /angry /bored
/coffee /cafe /sleep /smoke /punch /kill /eat /nom y mas
(/menu completo: mismos nombres que WhatsApp)

👥 Grupo (bot admin)
/kick /promote /demote /warn /link /gp /open /closet
/rpg /gacha /welcome enable|disable

Uptime: ${'{uptime}'}
`

export async function handleHelp(ctx) {
  try {
    await ctx.reply(helpText.replace('{uptime}', uptimeStr()))
  } catch (e) {
    console.error('[menu]', e)
    await ctx.reply('Menu listo. Prueba /ping. Si no responde, cierra otros procesos del bot.').catch(() => {})
  }
}

export async function handlePing(ctx) {
  console.log('[ping] enter')
  const start = Date.now()
  try {
    const sent = await ctx.reply('Pong...')
    const latency = Date.now() - start
    console.log('[ping] replied', latency, 'ms')
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        sent.message_id,
        `Pong!\nTiempo: ${latency}ms\nUptime: ${uptimeStr()}`
      )
      .catch(() => {})
  } catch (e) {
    console.error('[ping] fail', e)
    try { await ctx.reply('Pong') } catch (e2) { console.error('[ping] fail2', e2) }
  }
}
