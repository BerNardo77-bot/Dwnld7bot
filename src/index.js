// Debe ser el primer import: registra los procesos de descarga para poder cancelar/pausar
import { installDlControl } from './dl-control-tg.js'
import path from 'path'
import { initMtproto, sendBigFile, MTPROTO_MAX_SEND } from './mtproto.js'
import { splitVideoEach, hasRoomToSplitEach, roomText, freeDisk, MAX_SPLIT_PARTS, partsFor, bigWarning } from './video-split.js'
import { setSendLimit } from './api.js'
import { offerOversize, registerOversize } from './oversize.js'
import { findTiktokUrls } from './tt-url.js'
import 'dotenv/config'
import fs from 'fs'
import { Bot, InputFile } from 'grammy'
import {
  resolveYoutube,
  getAudioLink,
  getVideoLink,
  getXvideosDownload,
  searchXvideos,
  downloadToFile,
  downloadYoutubeWithYtDlp,
  compressForTelegram,
  isDirectMediaUrl,
  tmpPath,
  safeUnlink,
  mb,
  MAX_DOWNLOAD,
  argText,
  errText,
  isNsfwEnabled,
  IS_TERMUX,
  extractYoutubeId,
  cleanYtError
} from './api.js'
import { handleSticker, handlePhotoCaption } from './commands/stickers.js'
import { handleHelp, handlePing } from './commands/info.js'
import { handleGrokStickers } from './commands/grokstickers.js'
import { handleGrokGifs } from './commands/grokgifs.js'
import { handleGrokMovimientos } from './commands/grokmov.js'
import { handleGrokMovCian } from './commands/movcian.js'
import { handleGrokMovColor } from './commands/movcolor.js'
import { handleGrokMovNube, handleGrokMovCuadro } from './commands/movforma.js'
import { handleGrokMovCalabaza } from './commands/movcalabaza.js'
import { handleTranslate, TRANSLATE_COMMANDS } from './commands/translate.js'
import { createDownloadHandlers } from './commands/downloads.js'
import { handleGoogle, GOOGLE_COMMANDS } from './commands/google.js'
import { createPdfHandler, PDF_COMMANDS } from './commands/gdrive.js'
import { createXHandler } from './commands/x.js'
import { createPodcastHandlers } from './commands/podcast.js'
import { createYtPicker } from './commands/ytpick.js'
import { handleApple, registerMusic, setVideoHandler, playAudio, APPLE_COMMANDS } from './commands/music.js'
import { handleRadio, registerRadio, RADIO_COMMANDS } from './commands/radio.js'
import { handleSpace, SPACE_COMMANDS } from './commands/space.js'
import { handleMapa, registerMapa, MAPA_COMMANDS } from './commands/mapa.js'
import { handleEnvivo, registerEnvivo, ENVIVO_COMMANDS } from './commands/envivo.js'
import { createTvHandler, TV_COMMANDS, isDirectStream } from './commands/tv.js'
import { createNsfwPicker } from './commands/nsfwpick.js'
import {
  handleDanbooru,
  handleGelbooru,
  handleR34,
  handleNsfwInteraction,
  NSFW_INTERACTION_COMMANDS,
  createXnxxHandler
} from './commands/nsfw.js'
import { bumpCount } from './store.js'
import { resolveApiRoot } from './tgapi.js'
import {
  handleBalance, handleDaily, handleDeposit, handleWithdraw, handleWork, handleCrime,
  handleSlut, handleFish, handleHunt, handleMine, handleRitual, handleDungeon,
  handleSteal, handleGiveCoins, handleFlip, handleSlot, handleRoulette, handlePpt,
  handleMath, handleResponder, handleBoard, handleCount, handleTopCount, handleWait,
  handleRoll, handleClaim, handleHarem, handleWinfo, handleSerieInfo, handleSerieList,
  handleGinfo, handleSell, handleBuyChar, handleGiveChar, handleDelChar, handleWaifuBoard,
  handleVote, handleTrade, handleProfile, handleLevel, handleSetDesc, handleDelDesc,
  handleSetBirth, handleDelBirth, handleSetGenre, handleDelGenre, handleSetHobby,
  handleDelHobby, handleMarry, handleDivorce, handleWiki, handleImagen,
  handlePin, handleYtSearch, setYtSearchPicker, handleTtSearch, handleApk, handleAms, handleAnime,
  ANIME_COMMANDS, handleStatus, handleInfobot, handleInvite, handleSuggest,
  handleRpg, handleGachaToggle, handleWelcomeToggle, handleByeToggle, handleSetWelcome,
  handleSetBye, handleKick, handlePromote, handleDemote, handleLink, handleGp,
  handleWarn, handleWarns, handleDelWarn, handleSetWarnLimit, handleSetGpName,
  handleSetGpDesc, handleOpen, handleCloset, handleHidetag, handleClear, handlePfp,
  waOnly, onNewMember, onLeftMember
} from './commands/world.js'
import {
  handleIa,
  handleGemini,
  handleDeepseek,
  handleGrok,
  handleNano
} from './commands/ai.js'

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('Falta TELEGRAM_BOT_TOKEN en .env')
  process.exit(1)
}

// Railway/Render inyectan PORT. Un HTTP minimo evita que un "Web Service" mate el proceso.
const cloudPort = Number(process.env.PORT)
if (Number.isFinite(cloudPort) && cloudPort > 0) {
  import('http')
    .then((http) => {
      http
        .createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('Dwnld7bot ok\n')
        })
        .listen(cloudPort, '0.0.0.0', () => {
          console.log('[cloud] HTTP health en puerto', cloudPort)
        })
    })
    .catch((e) => console.error('[cloud] http', e?.message || e))
}

const renderExternalUrl = process.env.RENDER_EXTERNAL_URL?.trim()
const configuredKeepaliveMs = Number(process.env.KEEPALIVE_MS)
const keepaliveMs = Number.isFinite(configuredKeepaliveMs) && configuredKeepaliveMs > 0
  ? configuredKeepaliveMs
  : 10 * 60 * 1000

if (renderExternalUrl) {
  const pingRenderHealth = async () => {
    try {
      const response = await fetch(renderExternalUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      console.log('[keepalive] ok', response.status)
    } catch {}
  }

  setInterval(() => {
    void pingRenderHealth()
  }, keepaliveMs)
}

// Servidor Telegram Local Bot API (ver LOCAL-BOT-API.md). Si TELEGRAM_API_ROOT falla al
// arrancar, se usa api.telegram.org con tope 49 MB (sin crash-loop).
const apiInfo = await resolveApiRoot(token)
const useLocalApi = apiInfo.local
const CLOUD_MAX_SEND = 49 * 1024 * 1024
const LOCAL_MAX_SEND = 1950 * 1024 * 1024
function configuredMaxSend() {
  const bytes = Number(process.env.MAX_SEND_BYTES)
  if (Number.isFinite(bytes) && bytes > 0) return bytes
  const mbs = Number(process.env.MAX_SEND) // en MB, ej. MAX_SEND=1950
  if (Number.isFinite(mbs) && mbs > 0) return Math.floor(mbs * 1024 * 1024)
  return null
}
const MAX_SEND = useLocalApi
  ? Math.min(configuredMaxSend() || LOCAL_MAX_SEND, 2000 * 1024 * 1024)
  : Math.min(configuredMaxSend() || CLOUD_MAX_SEND, CLOUD_MAX_SEND)
setSendLimit(MAX_SEND)
// Modo 2 GB sin servidor extra: MTProto (gramjs) con TELEGRAM_API_ID/HASH del .env.
const bigUpload = !useLocalApi && await initMtproto(token)
const SEND_CAP = bigUpload ? MTPROTO_MAX_SEND : MAX_SEND

// Subidas grandes (hasta ~2 GB) necesitan mas tiempo que el default de grammy.
const botOpts = useLocalApi
  ? { client: { apiRoot: apiInfo.root, timeoutSeconds: Number(process.env.TELEGRAM_API_TIMEOUT_S) || 3600 } }
  : undefined

const bot = new Bot(token, botOpts)
// ❌ Cancelar / ⏸️ Pausar / ▶️ Continuar descargas (debe ir antes de cualquier otro middleware)
installDlControl(bot)

bot.use(async (ctx, next) => {
  try {
    const text = ctx.message?.text || ctx.message?.caption || ''
    if (text || ctx.update?.update_id) {
      console.log(
        '[msg]',
        ctx.update?.update_id,
        ctx.chat?.type,
        ctx.from?.id,
        String(text).slice(0, 80)
      )
    }
  } catch {}
  try {
    if (ctx.message && ctx.from && !ctx.from.is_bot) bumpCount(ctx)
  } catch (e) {
    console.error('[count]', e?.message || e)
  }
  try {
    await next()
  } catch (e) {
    console.error('[handler]', e)
    throw e
  }
})

// Respuestas basicas forzadas (no depender del router de command)
bot.on('message:text', async (ctx, next) => {
  const raw = String(ctx.message?.text || '')
  const cmd = raw.split(/\s+/)[0].split('@')[0].toLowerCase()
  console.log('[cmd]', cmd)
  if (cmd === '/ping' || cmd === '/p') {
    return handlePing(ctx)
  }
  if (cmd === '/start' || cmd === '/help' || cmd === '/menu') {
    return handleHelp(ctx)
  }
  if (cmd === '/ia' || cmd === '/chatgpt' || cmd === '/gpt') {
    console.log('[ai] force ia')
    return handleIa(ctx)
  }
  if (cmd === '/gemini' || cmd === '/geminis') {
    console.log('[ai] force gemini')
    return handleGemini(ctx)
  }
  if (cmd === '/deepseek' || cmd === '/ds') {
    console.log('[ai] force deepseek')
    return handleDeepseek(ctx)
  }
  if (cmd === '/grok') {
    console.log('[ai] force grok')
    return handleGrok(ctx)
  }
  if (cmd === '/nano' || cmd === '/nanobanana') {
    console.log('[ai] force nano')
    return handleNano(ctx)
  }
  if (cmd === '/wiki' || cmd === '/wikipedia') {
    console.log('[search] force wiki')
    return handleWiki(ctx)
  }
  if (cmd === '/imagen' || cmd === '/img' || cmd === '/image') {
    console.log('[search] force imagen')
    return handleImagen(ctx)
  }
  if (cmd === '/pin' || cmd === '/pinterest') {
    console.log('[search] force pin')
    return handlePin(ctx)
  }
  if (cmd === '/ytsearch' || cmd === '/search' || cmd === '/yts') {
    console.log('[search] force ytsearch')
    if (/^@/.test(argText(ctx))) return ytPicker.listar(ctx, argText(ctx))
    return handleYtSearch(ctx)
  }
  if (cmd === '/ttsearch' || cmd === '/tiktoksearch' || cmd === '/tts') {
    console.log('[search] force ttsearch')
    return ttSearchOrLink(ctx)
  }
  if (cmd === '/apk' || cmd === '/aptoide' || cmd === '/apkdl') {
    console.log('[search] force apk')
    return handleApk(ctx)
  }
  if (cmd === '/ams' || cmd === '/applemusicsearch') {
    console.log('[search] force ams')
    return handleAms(ctx)
  }

  // Gacha
  const gachaCmds = new Set([
    '/rw', '/roll', '/rollwaifu', '/rf',
    '/claim', '/c',
    '/harem', '/miswaifus', '/claims',
    '/winfo', '/charinfo', '/cinfo', '/charimage', '/wimage', '/cimage',
    '/serieinfo', '/animeinfo', '/ainfo',
    '/slist', '/serielist', '/animelist',
    '/gachainfo', '/ginfo', '/infogacha',
    '/sell', '/vender',
    '/buycharacter', '/buychar', '/buyc',
    '/givechar', '/givewaifu', '/regalar',
    '/delchar', '/delwaifu', '/deletechar',
    '/waifusboard', '/waifustop', '/topwaifus',
    '/vote', '/votar',
    '/trade', '/cambiar', '/accepttrade', '/aceptarintercambio',
    '/giveallharem', '/haremshop', '/tiendawaifus', '/wshop',
    '/removesale', '/removerventa',
    '/gacha'
  ])
  if (gachaCmds.has(cmd)) {
    console.log('[gacha] force', cmd)
    if (cmd === '/gacha') return handleGachaToggle(ctx)
    if (['/rw','/roll','/rollwaifu','/rf'].includes(cmd)) return handleRoll(ctx)
    if (['/claim','/c'].includes(cmd)) return handleClaim(ctx)
    if (['/harem','/miswaifus','/claims'].includes(cmd)) return handleHarem(ctx)
    if (['/winfo','/charinfo','/cinfo','/charimage','/wimage','/cimage'].includes(cmd)) return handleWinfo(ctx)
    if (['/serieinfo','/animeinfo','/ainfo'].includes(cmd)) return handleSerieInfo(ctx)
    if (['/slist','/serielist','/animelist'].includes(cmd)) return handleSerieList(ctx)
    if (['/gachainfo','/ginfo','/infogacha'].includes(cmd)) return handleGinfo(ctx)
    if (['/sell','/vender'].includes(cmd)) return handleSell(ctx)
    if (['/buycharacter','/buychar','/buyc'].includes(cmd)) return handleBuyChar(ctx)
    if (['/givechar','/givewaifu','/regalar'].includes(cmd)) return handleGiveChar(ctx)
    if (['/delchar','/delwaifu','/deletechar'].includes(cmd)) return handleDelChar(ctx)
    if (['/waifusboard','/waifustop','/topwaifus'].includes(cmd)) return handleWaifuBoard(ctx)
    if (['/vote','/votar'].includes(cmd)) return handleVote(ctx)
    return handleTrade(ctx)
  }

  // Anime interactions
  const animeBare = cmd.replace(/^\//, '')
  if (ANIME_COMMANDS.includes(animeBare)) {
    console.log('[anime] force', animeBare)
    return handleAnime(ctx)
  }

  await next()
})


const TG_MAX_PARTS = Number(process.env.TG_MAX_PARTS) || (SEND_CAP > MAX_SEND ? MAX_SPLIT_PARTS : 10) // 26 partes de ~1950 MB (~50 GB); sin MTProto (49 MB) máx. 10 partes
// Envía un archivo: por Bot API si cabe en 49 MB; si no, por MTProto (hasta ~1950 MB).
async function sendOneFile(ctx, file, name, kind, caption, statusId) {
  const sz = fs.statSync(file).size
  if (bigUpload && sz > MAX_SEND) {
    let last = 0
    try {
      await sendBigFile(ctx.chat.id, file, {
        kind, caption, fileName: name,
        replyToMsgId: ctx.message?.message_id || ctx.callbackQuery?.message?.message_id,
        onProgress: (p) => {
          const pct = Math.floor(p * 100)
          if (statusId && pct >= last + 10) { last = pct; ctx.api.editMessageText(ctx.chat.id, statusId, `Subiendo ${mb(sz)} MB… ${pct}%`).catch(() => {}) }
        }
      })
      return
    } catch (e) {
      console.error('[mtproto] envío falló:', errText(e))
      const err = new Error('mtproto: ' + errText(e)); err.mtproto = true; throw err
    }
  }
  const input = new InputFile(file, name)
  if (kind === 'audio') return ctx.replyWithAudio(input, { title: caption })
  if (kind === 'video') {
    try { return await ctx.replyWithVideo(input, { caption, supports_streaming: true }) } catch { return ctx.replyWithDocument(input, { caption }) }
  }
  return ctx.replyWithDocument(input, { caption })
}

async function sendOrCompress(ctx, filePath, opts) {
  if (SEND_CAP > MAX_SEND) {
    try { return await sendOrCompressCap(ctx, filePath, opts, SEND_CAP) } catch (e) {
      if (!e?.mtproto || e.partsSent) throw e
      console.error('[mtproto] vuelvo al modo 49 MB')
    }
  }
  return sendOrCompressCap(ctx, filePath, opts, MAX_SEND)
}

async function sendOrCompressCap(ctx, filePath, { kind, fileName, caption, statusId, fallbackLink }, CAP) {
  let pathToSend = filePath
  let size = fs.statSync(pathToSend).size
  let compressedPath = null

  if (size > CAP && kind === 'video' && partsFor(size, CAP) <= TG_MAX_PARTS) {
    // Video más grande que el límite de Telegram: partes por tiempo (ffmpeg -c copy), misma calidad.
    // Se corta y manda UNA parte a la vez (solo hace falta espacio para el video + 1 parte).
    if (!hasRoomToSplitEach(size, CAP, path.dirname(filePath))) {
      await ctx.reply(`No hay espacio en el servidor para partir el video (${roomText(size, CAP, path.dirname(filePath))}).`).catch(() => {})
    } else {
      let sent = 0
      try {
        const n0 = partsFor(size, CAP)
        if (statusId) await ctx.api.editMessageText(ctx.chat.id, statusId, `Pesa ${mb(size)} MB (límite ${mb(CAP)} MB por archivo). Te lo mando en ${n0} partes, sin bajar la calidad…`).catch(() => {})
        const total = await splitVideoEach(filePath, CAP, {
          title: String(fileName || 'video').replace(/\.mp4$/i, ''), maxParts: TG_MAX_PARTS + 3, deleteSource: false,
          onPart: async (p) => {
            const cap = `${caption || ''}\n📦 Parte ${p.index}/${p.total}`.trim()
            await sendOneFile(ctx, p.file, p.name, 'video', cap, statusId)
            sent++
          }
        })
        const warn = bigWarning(size, total)
        if (warn) await ctx.reply(warn).catch(() => {})
        if (statusId) await ctx.api.deleteMessage(ctx.chat.id, statusId).catch(() => {})
        return true
      } catch (e) {
        console.error('[split]', errText(e))
        if (e?.mtproto && !sent) throw e
        if (sent) { await ctx.reply(`No pude mandar el resto de las partes (${errText(e).slice(0, 120)}).`).catch(() => {}); return true }
      }
    }
  }
  if (size > CAP) {
    return offerOversize(ctx, {
      file: filePath, kind, fileName, caption, statusId, link: fallbackLink || '',
      linkNote: fallbackLink && !/youtu|xnxx\.com|xvideos\.com|tiktok\.com|x\.com|twitter\.com/i.test(fallbackLink) ? 'Ese enlace puede vencer en unas horas.' : ''
    })
  }

  await sendOneFile(ctx, pathToSend, fileName, kind, caption, statusId)
  safeUnlink(compressedPath)
  if (statusId) await ctx.api.deleteMessage(ctx.chat.id, statusId).catch(() => {})
  return true
}

async function handlePlay(ctx) {
  const q = argText(ctx)
  if (!q) return ctx.reply('Uso: /play nombre o link de YouTube')
  // MP3 real verificado (192k, portada, etiquetas) con nombre "Artista - Título.mp3" (src/commands/music.js)
  return playAudio(ctx, { query: q })
}

async function handleVideo(ctx, quality = 'hd', qPicked = '') {
  if (typeof quality !== 'string') quality = 'hd'
  const q = qPicked || argText(ctx)
  if (!q) return ctx.reply('Uso: /ytvideo <link>, /ytvideo <nombre> (10 resultados), /ytvideo @canal (sus videos nuevos) o /ytvideo @canal palabras')
  // Sin link de video: lista de 10 para elegir (nunca bajar un canal entero)
  if (!qPicked && !extractYoutubeId(q)) return ytPicker.listar(ctx, q, { quality })
  const status = await ctx.reply('Buscando video...')
  const out = tmpPath(`${Date.now()}-video.mp4`)
  try {
    const video = await resolveYoutube(q)
    if (!video) {
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, 'No encontre el video.')
    }
    const expected = Number(video.seconds) || 0
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      'Video: ' + video.title + '\nObteniendo enlace...'
    )
    // 1) yt-dlp primero (mas fiable que URLs Alyacore que dan 302)
    let usedLink = video.url
    let got = { title: video.title }
    let usedYtdlp = false
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        'Alta calidad (1080p). Bajando con yt-dlp...'
      )
      let lastEdit = 0
      let lastText = ''
      const onProgress = (p) => {
        const now = Date.now()
        let t
        if (p.merging) t = 'Uniendo video y audio...'
        else if (p.pct != null) t = `Bajando (1080p, ${p.route || 'directo'}): ${p.pct.toFixed(1)}%${p.size ? ' de ' + p.size : ''}${p.speed ? ' · ' + p.speed : ''}${p.eta ? ' · faltan ' + p.eta : ''}`
        else if (p.route === 'proxy') t = 'Directo no funcionó. Probando con el proxy...'
        if (!t || t === lastText || (now - lastEdit < 15000 && !p.merging)) return
        lastEdit = now
        lastText = t
        ctx.api.editMessageText(ctx.chat.id, status.message_id, t).catch(() => {})
      }
      await downloadYoutubeWithYtDlp(video.url || q, out, quality, { onProgress, expectedSec: expected, maxTotalBytes: Math.min(SEND_CAP * TG_MAX_PARTS * 0.9, Math.max(0, freeDisk(path.dirname(out)) - SEND_CAP - 300 * 1024 * 1024)) || 1 })
      usedYtdlp = true
      // ¿Bajó en menos de 1080p por el tope de partes/espacio? Se avisa.
      try {
        const { execFileSync } = await import('child_process')
        const hgt = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', out], { timeout: 30000 }).toString().trim()) || 0
        if (quality !== 'fit' && hgt && hgt < 1000 && expected) {
          await ctx.reply(`Salió en ${hgt}p: 1080p no estaba disponible o pasaba de ${TG_MAX_PARTS} partes de ${mb(SEND_CAP)} MB (o del espacio del servidor).`).catch(() => {})
        }
      } catch {}
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Descargado. Subiendo a Telegram...').catch(() => {})
    } catch (yterr) {
      console.error('[ytvideo] yt-dlp', yterr)
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        'yt-dlp fallo. Probando API Alyacore...'
      ).catch(() => {})
      got = await getVideoLink(video.url, video.title)
      if (got.error || !got.dl) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No pude bajar el video.\n' +
            cleanYtError(errText(yterr)) +
            '\n' +
            'API de respaldo (alyacore): ' + cleanYtError(got.error || 'sin link') +
            (IS_TERMUX ? '\n\nTip Termux:\npkg install python\npip install -U yt-dlp' : '') +
            '\n\nLink limpio:\n/ytvideo https://youtu.be/' +
            (String(video.videoId || ''))
        )
      }
      usedLink = got.dl
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `Descargando API (tope ${mb(MAX_DOWNLOAD)} MB)...`
      )
      try {
        await downloadToFile(got.dl, out, { timeout: 1_800_000 })
      } catch (e) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'La descarga de respaldo falló: ' + cleanYtError(errText(e))
        )
      }
    }
    const size = fs.statSync(out).size
    const fd = fs.openSync(out, 'r')
    const head = Buffer.alloc(8)
    fs.readSync(fd, head, 0, 8, 0)
    fs.closeSync(fd)
    const brand = head.slice(4, 8).toString()
    if (brand !== 'ftyp' && !usedYtdlp) {
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, 'La API no devolvio un MP4 valido.')
    }
    if (brand !== 'ftyp' && usedYtdlp) {
      try {
        const remuxed = out.replace(/\.mp4$/i, '') + '-remux.mp4'
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)
        await execFileAsync(
          'ffmpeg',
          ['-y', '-i', out, '-c', 'copy', '-movflags', '+faststart', remuxed],
          { timeout: 300000 }
        )
        if (fs.existsSync(remuxed) && fs.statSync(remuxed).size) {
          fs.renameSync(remuxed, out)
        }
      } catch (re) {
        console.error('[ytvideo] remux', re)
      }
    }
    if (expected >= 600 && size < 5 * 1024 * 1024) {
      return ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `No envie el archivo: parece un clip incompleto (${mb(size)} MB).`
      )
    }
    const name =
      ((got.title || video.title).replace(/[^\w\s.-]/g, '').slice(0, 40) || 'video') + '.mp4'
    await sendOrCompress(ctx, out, {
      kind: 'video',
      fileName: name,
      caption: (got.title || video.title) + ' (HD)',
      statusId: status.message_id,
      fallbackLink: usedLink || video.url
    })
  } catch (e) {
    console.error(e)
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + cleanYtError(errText(e)))
      .catch(() => ctx.reply(cleanYtError(errText(e))))
  } finally {
    safeUnlink(out)
  }
}

async function downloadAndSendMedia(ctx, mediaUrl, { title = 'video', status }) {
  const out = tmpPath(`${Date.now()}-media.mp4`)
  try {
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      `Bajando a disco (tope ${mb(MAX_DOWNLOAD)} MB)...`
    )
    const size = await downloadToFile(mediaUrl, out, { timeout: 1_800_000 })
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      `Descargado ${mb(size)} MB. Preparando envio...`
    )
    await sendOrCompress(ctx, out, {
      kind: 'video',
      fileName: 'video.mp4',
      caption: title,
      statusId: status.message_id,
      fallbackLink: mediaUrl
    })
  } finally {
    safeUnlink(out)
  }
}

async function handleXvideos(ctx) {
  if (!isNsfwEnabled()) return ctx.reply('🔞 NSFW desactivado (NSFW_ENABLED=false).')
  const q = argText(ctx)
  if (!q) return ctx.reply('Uso: /xvideos nombre, URL de XVideos, o link .mp4 CDN\nAlta calidad primero. Si no cabe, comprime a ~50 MB.')
  const status = await ctx.reply('Procesando XVideos (HD)...')

  try {
    if (isDirectMediaUrl(q)) {
      const out = tmpPath(`${Date.now()}-xvideos-cdn.mp4`)
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          `Bajando a disco (tope ${mb(MAX_DOWNLOAD)} MB)...`
        )
        await downloadToFile(q, out, { timeout: 1_800_000 })
        const size = fs.statSync(out).size
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          `${mb(size)} MB (HD). Preparando envio...`
        )
        await sendOrCompress(ctx, out, {
          kind: 'video',
          fileName: 'xvideos.mp4',
          caption: 'xvideos (HD)',
          statusId: status.message_id,
          fallbackLink: q
        })
      } finally {
        safeUnlink(out)
      }
      return
    }

    let videoUrl = q
    let title = 'xvideos'

    if (!(q.startsWith('http') && q.includes('xvideos.com'))) {
      const found = await searchXvideos(q)
      if (found.error || !found.results?.length) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No se encontro el video.\n' + (found.error || '')
        )
      }
      const pick = found.results[Math.floor(Math.random() * found.results.length)]
      videoUrl = pick.url
      title = pick.title || title
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `${title}\n${pick.duration || ''}\n${videoUrl}`
      )
    }

    await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Obteniendo enlace de descarga...')
    const got = await getXvideosDownload(videoUrl)
    if (got.error || !got.candidates?.length) {
      return ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        'No se pudo obtener el video.\n' + (got.error || '')
      )
    }

    const out = tmpPath(`${Date.now()}-xvideos.mp4`)
    let usedLink = null
    let usedQuality = ''
    let lastErr = ''
    try {
      for (const c of got.candidates) {
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            status.message_id,
            `Bajando calidad ${c.quality} (HD preferido)...`
          )
          await downloadToFile(c.url, out, { timeout: 1_800_000 })
          usedLink = c.url
          usedQuality = c.quality
          break
        } catch (e) {
          lastErr = e.message || String(e)
          safeUnlink(out)
          console.error('[xvideos]', c.quality, lastErr)
        }
      }

      if (!usedLink || !fs.existsSync(out)) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'Fallo la descarga.\n' + lastErr
        )
      }

      let size = fs.statSync(out).size
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `Descargado ${mb(size)} MB (${usedQuality || 'HD'}). Preparando envio...`
      )

      await sendOrCompress(ctx, out, {
        kind: 'video',
        fileName: 'xvideos.mp4',
        caption: title + (usedQuality ? ` (${usedQuality})` : ' (HD)'),
        statusId: status.message_id,
        fallbackLink: usedLink
      })
    } finally {
      safeUnlink(out)
    }
  } catch (e) {
    console.error(e)
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e))
      .catch(() => ctx.reply(errText(e)))
  }
}

async function handleDl(ctx) {
  const q = argText(ctx)
  if (!q || !/^https?:\/\//i.test(q)) {
    return ctx.reply('Uso: /dl https://....mp4')
  }
  const status = await ctx.reply('Descargando link directo...')
  try {
    await downloadAndSendMedia(ctx, q, { title: 'archivo', status })
  } catch (e) {
    console.error(e)
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e))
      .catch(() => ctx.reply(errText(e)))
  }
}

const {
  handleTiktok,
  handleTiktokMp3,
  handleInstagram,
  handleFacebook,
  handleSpotify,
  handleMediafire
} = createDownloadHandlers(sendOrCompress)

async function handleVideoHd(ctx) {
  return handleVideo(ctx, 'hd')
}

const ytPicker = createYtPicker({ onPick: (ctx, url, quality) => handleVideo(ctx, quality, url) })
const handleXnxx = createXnxxHandler(sendOrCompress)
const handlePdf = createPdfHandler({ maxSend: MAX_SEND })
const handleX = createXHandler(sendOrCompress, { maxSend: MAX_SEND })

registerMusic(bot) // antes de los otros pickers: el número va a la lista más reciente
registerRadio(bot) // /radio: número/botón solo si la lista más reciente es de radio
registerMapa(bot) // /mapa: número/botón solo si la lista más reciente es de mapa
registerEnvivo(bot)
const tvBot = createTvHandler(sendOrCompress, { partCap: () => SEND_CAP })
tvBot.register(bot)
setVideoHandler((ctx, url) => handleVideo(ctx, 'hd', url))
createPodcastHandlers({ maxSend: MAX_SEND }).register(bot)
ytPicker.register(bot)
setYtSearchPicker((ctx, list) => ytPicker.remember(ctx, list, { quality: 'hd' }))
registerOversize(bot)
const nsfwPicker = createNsfwPicker({ sendOrCompress, maxSend: MAX_SEND })
nsfwPicker.register(bot)
bot.command(['start', 'help', 'menu'], handleHelp)
bot.hears(/^\/men[uú](@\w+)?(\s|$)/i, handleHelp)
bot.command(['ping', 'p'], handlePing)
bot.command(TRANSLATE_COMMANDS, handleTranslate) // texto o traducción por voz (responder a nota de voz/audio)
bot.command(['sticker', 's'], handleSticker)
bot.command(['stickers', 'grokstickers'], handleGrokStickers)
bot.command(['gifs', 'grokgifs'], handleGrokGifs)
bot.command(['movimientos', 'grokmov'], handleGrokMovimientos)
bot.command(['movcian', 'movimientoscian'], handleGrokMovCian)
bot.command(['movcolor', 'movimientoscolor', 'colorbot'], handleGrokMovColor)
bot.command(['movnube', 'movimientosnube'], handleGrokMovNube)
bot.command(['movcuadro', 'movimientoscuadro'], handleGrokMovCuadro)
bot.command(['movcalabaza', 'movimientoscalabaza'], handleGrokMovCalabaza)
bot.on('message:photo', async (ctx, next) => {
  const cap = String(ctx.message?.caption || '')
  const cmd = cap.split(/\s+/)[0].split('@')[0].toLowerCase()
  if (cmd === '/nano' || cmd === '/nanobanana') {
    console.log('[ai] force nano caption')
    return handleNano(ctx)
  }
  return handlePhotoCaption(ctx, next)
})

bot.command(['play', 'mp3', 'ytmp3', 'ytaudio', 'playaudio'], handlePlay)
bot.command(APPLE_COMMANDS, handleApple)
bot.command(RADIO_COMMANDS, handleRadio)
bot.command(SPACE_COMMANDS, handleSpace)
bot.command(MAPA_COMMANDS, handleMapa)
// /envivo con link directo .m3u8/rtmp → grabación de TV en video (/tv); YouTube/TikTok siguen en /envivo
bot.command(ENVIVO_COMMANDS, (ctx) => isDirectStream(String(ctx.message?.text || '').split(/\s+/)[1] || '') ? tvBot.handle(ctx) : handleEnvivo(ctx))
bot.command(TV_COMMANDS, (ctx) => tvBot.handle(ctx))
bot.command(['ytvideo', 'mp4', 'playvideo', 'play2', 'ytmp4'], handleVideo)
bot.command(['ytvideohd', 'mp4hd', 'hdvideo', 'playvideohd'], handleVideoHd)
// /xvideos: búsqueda/enlace de xvideos.com con lista; enlaces .mp4 de CDN siguen por el handler viejo
const xvPick = nsfwPicker.handler('xvideos')
bot.command(['xvideos', 'xv'], (ctx) => (/https?:\/\//i.test(argText(ctx)) && !/xvideos\d*\.com|xnxx\d*\.com/i.test(argText(ctx)) ? handleXvideos(ctx) : xvPick(ctx)))
bot.command(['dl', 'get'], handleDl)

bot.command(['tiktok', 'tt', 'tk', 'tiktokdl'], handleTiktok)
bot.command(['tiktokmp3', 'ttmp3', 'ttaudio', 'tiktokaudio', 'playtt'], handleTiktokMp3)
bot.command(['ig', 'instagram', 'reel'], handleInstagram)
bot.command(['fb', 'facebook'], handleFacebook)
bot.command(['spotify', 'sp'], handleSpotify)
bot.command(['mediafire', 'mf'], handleMediafire)
bot.command(PDF_COMMANDS, handlePdf)
bot.command(['x', 'twitter', 'xdownloader', 'xdl', 'tw'], handleX)

bot.command(['danbooru', 'dbooru'], handleDanbooru)
bot.command(['gelbooru', 'gbooru'], handleGelbooru)
bot.command(['r34', 'rule34', 'rule'], handleR34)
bot.command(['xnxx'], nsfwPicker.handler('xnxx'))
bot.command(NSFW_INTERACTION_COMMANDS, handleNsfwInteraction)

bot.command(['balance', 'bal'], handleBalance)
bot.command(['daily'], handleDaily)
bot.command(['dep', 'deposit', 'd'], handleDeposit)
bot.command(['withdraw', 'with'], handleWithdraw)
bot.command(['w', 'work'], handleWork)
bot.command(['crime'], handleCrime)
bot.command(['slut'], handleSlut)
bot.command(['pescar', 'fish'], handleFish)
bot.command(['cazar', 'hunt'], handleHunt)
bot.command(['mine'], handleMine)
bot.command(['ritual'], handleRitual)
bot.command(['dungeon', 'mazmorra'], handleDungeon)
bot.command(['steal', 'rob', 'robar'], handleSteal)
bot.command(['givecoins', 'pay', 'coinsgive'], handleGiveCoins)
bot.command(['cf', 'flip', 'coinflip'], handleFlip)
bot.command(['slot'], handleSlot)
bot.command(['rt', 'roulette', 'ruleta'], handleRoulette)
bot.command(['ppt'], handlePpt)
bot.command(['math', 'matematicas'], handleMath)
bot.command(['responder'], handleResponder)
bot.command(['economyboard', 'eboard', 'baltop'], handleBoard)
bot.command(['count', 'mensajes', 'messages', 'msgcount'], handleCount)
bot.command(['topcount', 'topmensajes', 'topmsgcount', 'topmessages'], handleTopCount)
bot.command(['waittimes', 'cooldowns', 'economyinfo', 'einfo'], handleWait)

bot.command(['rollwaifu', 'roll', 'rw', 'rf'], handleRoll)
bot.command(['claim', 'c'], handleClaim)
bot.command(['harem', 'miswaifus', 'claims'], handleHarem)
bot.command(['winfo', 'charinfo', 'cinfo'], handleWinfo)
bot.command(['charimage', 'wimage', 'cimage'], handleWinfo)
bot.command(['serieinfo', 'animeinfo', 'ainfo'], handleSerieInfo)
bot.command(['slist', 'serielist', 'animelist'], handleSerieList)
bot.command(['gachainfo', 'ginfo', 'infogacha'], handleGinfo)
bot.command(['sell', 'vender'], handleSell)
bot.command(['buycharacter', 'buychar', 'buyc'], handleBuyChar)
bot.command(['givechar', 'givewaifu', 'regalar'], handleGiveChar)
bot.command(['delchar', 'delwaifu', 'deletechar'], handleDelChar)
bot.command(['waifusboard', 'waifustop', 'topwaifus'], handleWaifuBoard)
bot.command(['vote', 'votar'], handleVote)
bot.command(['trade', 'cambiar', 'accepttrade', 'aceptarintercambio', 'giveallharem', 'haremshop', 'tiendawaifus', 'wshop', 'removesale', 'removerventa'], handleTrade)

bot.command(['profile', 'perfil'], handleProfile)
bot.command(['levelup', 'level', 'lvl'], handleLevel)
bot.command(['setdescription', 'setdesc'], handleSetDesc)
bot.command(['deldescription', 'deldesc'], handleDelDesc)
bot.command(['setbirth'], handleSetBirth)
bot.command(['delbirth'], handleDelBirth)
bot.command(['setgenre'], handleSetGenre)
bot.command(['delgenre'], handleDelGenre)
bot.command(['setpasatiempo', 'sethobby'], handleSetHobby)
bot.command(['delpasatiempo', 'removehobby'], handleDelHobby)
bot.command(['marry'], handleMarry)
bot.command(['divorce'], handleDivorce)

bot.command(['ia', 'chatgpt', 'gpt'], handleIa)
bot.command(['gemini', 'geminis'], handleGemini)
bot.command(['deepseek', 'ds'], handleDeepseek)
bot.command(['grok'], handleGrok)
bot.command(['nano', 'nanobanana'], handleNano)
bot.command(['wiki', 'wikipedia'], handleWiki)
bot.command(GOOGLE_COMMANDS, handleGoogle)
bot.command(['imagen', 'img', 'image'], handleImagen)
bot.command(['pinterest', 'pin'], handlePin)
bot.command(['ytsearch', 'search', 'yts'], handleYtSearch)
// /ttsearch con enlace (tt.site, vm.tiktok.com…) descarga directo
function ttSearchOrLink(ctx) {
  return findTiktokUrls(ctx.message?.text || '').length ? handleTiktok(ctx) : handleTtSearch(ctx)
}
bot.command(['tiktoksearch', 'ttsearch', 'tts'], ttSearchOrLink)
bot.command(['aptoide', 'apk', 'apkdl'], handleApk)
bot.command(['ams', 'applemusicsearch'], handleAms)
bot.command(ANIME_COMMANDS, handleAnime)

bot.command(['status'], handleStatus)
bot.command(['infobot', 'infosocket', 'info'], handleInfobot)
bot.command(['invite', 'invitar'], handleInvite)
bot.command(['report', 'reporte', 'sug', 'suggest'], handleSuggest)
bot.command(['rpg', 'economy', 'economia'], handleRpg)
bot.command(['gacha'], handleGachaToggle)
bot.command(['welcome', 'bienvenidas'], handleWelcomeToggle)
bot.command(['bye', 'despedidas', 'goodbye'], handleByeToggle)
bot.command(['setwelcome'], handleSetWelcome)
bot.command(['setbye'], handleSetBye)
bot.command(['kick'], handleKick)
bot.command(['promote'], handlePromote)
bot.command(['demote'], handleDemote)
bot.command(['link'], handleLink)
bot.command(['gp', 'groupinfo'], handleGp)
bot.command(['warn'], handleWarn)
bot.command(['warns'], handleWarns)
bot.command(['delwarn'], handleDelWarn)
bot.command(['setwarnlimit'], handleSetWarnLimit)
bot.command(['setgpname'], handleSetGpName)
bot.command(['setgpdesc'], handleSetGpDesc)
bot.command(['open'], handleOpen)
bot.command(['closet'], handleCloset)
bot.command(['hidetag', 'tag'], handleHidetag)
bot.command(['clear'], handleClear)
bot.command(['pfp', 'getpic'], handlePfp)
bot.command(['bot'], handleStatus)

bot.on('message:new_chat_members', onNewMember)
bot.on('message:left_chat_member', onLeftMember)

bot.command(['eval', 'e', 'restart', 'fix', 'update', 'bots', 'sockets', 'leave', 'logout', 'reload', 'self', 'subbot', 'code', 'qr', 'antilink', 'antienlaces', 'antistatus', 'antiestados', 'adminonly', 'onlyadmin', 'reveal', 'viewonce', 'ver', 'newpack', 'delpack', 'getpack', 'pack', 'packlist', 'addsticker', 'delsticker', 'setbotname', 'setname', 'setbotprefix', 'setusername'], waOnly)

bot.catch((err) => console.error('Bot error', err?.error || err?.message || err, err?.ctx?.message?.text || ''))

console.log('Dwnld7bot v1.4.38 arrancando...')

async function goOnline() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true })
  } catch (e) {
    console.error('No se pudo borrar webhook:', e?.description || e?.message || e)
  }
  const me = await bot.api.getMe()
  console.log('Dwnld7bot online como @' + me.username)
  console.log(
    'download<=',
    mb(MAX_DOWNLOAD),
    'MB | send<=',
    mb(MAX_SEND),
    'MB | localApi=',
    useLocalApi,
    '|',
    apiInfo.root,
    apiInfo.requested && !useLocalApi ? '(FALLBACK: ' + apiInfo.reason + ')' : ''
  )
  console.log('Comandos: /menu /sticker /play /tiktok /ig /fb /spotify /x /google /pdf ...')
  console.log('Si mandas /start y no responde, otro proceso usa el mismo token.')
  const keepAlive = setInterval(() => {
    console.log('[vivo]', new Date().toISOString(), 'esperando mensajes...')
  }, 30000)

  await bot.start({
    drop_pending_updates: true,
    allowed_updates: ['message', 'callback_query', 'edited_message'],
    onStart: (info) => {
      console.log('Polling activo:', info.username)
      console.log('Deja esta ventana abierta. Si aparece $ el bot ya se cerro.')
    }
  })
  clearInterval(keepAlive)
  console.log('Polling terminado. El bot ya no escucha.')
}

goOnline().catch((e) => {
  const code = e?.error_code || e?.error?.error_code || e?.error?.error_code
  console.error('No arranco el bot:', e?.description || e?.message || e)
  if (code === 409 || String(e?.message || e).includes('409')) {
    console.error('409: otro Termux, celular o Railway ya usa este token. Cierra ese y reintenta.')
  }
  if (apiInfo.requested && !useLocalApi) {
    console.error(
      'Nota: se cayo a api.telegram.org. Si hace poco se hizo logOut (servidor local), la API oficial ' +
        'queda bloqueada ~10 min.'
    )
  }
  // Espera antes de salir para no entrar en crash-loop rapido (Railway/Render reinician solos).
  const waitS = Math.max(0, Number(process.env.RESTART_DELAY_S ?? 60))
  console.error(`Saliendo en ${waitS}s...`)
  setTimeout(() => process.exit(1), waitS * 1000)
})

process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection', e)
})
process.on('uncaughtException', (e) => {
  console.error('uncaughtException', e)
})
