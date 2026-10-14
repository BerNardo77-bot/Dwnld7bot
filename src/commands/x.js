import fs from 'fs'
import fetch from 'node-fetch'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { InputFile } from 'grammy'
import {
  argText,
  downloadToFile,
  resolveYtDlpBin,
  tmpPath,
  safeUnlink,
  mb,
  errText
} from '../api.js'

/**
 * X / Twitter downloader (port de cmds/dl/x.js de Luffy7 WhatsApp).
 * Cadena: FxTwitter API -> VxTwitter API -> yt-dlp (solo si esta instalado).
 */

const execFileAsync = promisify(execFile)
const MAX_MEDIA = 10
// UA sin 'Mozilla': api.vxtwitter.com (Cloudflare) da 403 a UAs tipo navegador
const UA = { 'User-Agent': 'Dwnld7bot/1.0 (x-downloader)' }

const HOSTS =
  '(?:www\\.|mobile\\.|m\\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr)\\.com'
export const STATUS_RE = new RegExp(
  `https?:\\/\\/${HOSTS}\\/(?:i\\/web\\/|i\\/|[A-Za-z0-9_]{1,20}\\/)?status(?:es)?\\/(\\d{1,25})`,
  'i'
)
const TCO_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/i

function withTimeout(ms) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

export function parseTweet(url) {
  const m = String(url || '').match(STATUS_RE)
  if (!m) return null
  const um = String(url).match(/\.com\/([A-Za-z0-9_]{1,20})\/status/i)
  const user = um && !['i', 'web'].includes(um[1].toLowerCase()) ? um[1] : 'i'
  return { id: m[1], user }
}

async function resolveTco(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: UA, signal: withTimeout(15000) })
    return res.url || url
  } catch {
    return url
  }
}

function pickBestMp4(formats = [], fallbackUrl) {
  const mp4 = formats
    .filter((f) => f?.url && (f.container === 'mp4' || /\.mp4(\?|$)/.test(f.url)))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
    .map((f) => f.url)
  if (fallbackUrl && !mp4.includes(fallbackUrl)) mp4.unshift(fallbackUrl)
  return mp4
}

// FxTwitter: https://api.fxtwitter.com/<user>/status/<id>
export async function fromFx(id, user) {
  const res = await fetch(`https://api.fxtwitter.com/${user || 'i'}/status/${id}`, {
    headers: UA,
    signal: withTimeout(20000)
  })
  const json = await res.json().catch(() => ({}))
  if (json?.code !== 200 || !json.tweet) {
    const err = new Error(json?.message || `FxTwitter HTTP ${res.status}`)
    err.code = json?.code || res.status
    throw err
  }
  const t = json.tweet
  const media = (t.media?.all || [])
    .map((m) => {
      if (m.type === 'photo') {
        const u =
          m.url?.includes('pbs.twimg.com') && !/[?&]name=/.test(m.url) ? `${m.url}?name=orig` : m.url
        return { type: 'image', urls: [u] }
      }
      return {
        type: m.type === 'gif' ? 'gif' : 'video',
        urls: pickBestMp4(m.formats || m.variants, m.url),
        duration: m.duration
      }
    })
    .filter((m) => m.urls?.[0])
  return {
    source: 'FxTwitter',
    author: t.author?.name || '',
    handle: t.author?.screen_name || '',
    text: t.text || '',
    link: t.url || `https://x.com/i/status/${id}`,
    media
  }
}

// VxTwitter: https://api.vxtwitter.com/<user>/status/<id>
export async function fromVx(id, user) {
  const res = await fetch(
    `https://api.vxtwitter.com/${user && user !== 'i' ? user : 'Twitter'}/status/${id}`,
    { headers: UA, signal: withTimeout(20000) }
  )
  const json = await res.json().catch(() => null)
  if (!json || !json.tweetID) throw new Error(`VxTwitter HTTP ${res.status}`)
  const media = (json.media_extended || [])
    .map((m) => {
      if (m.type === 'image') return { type: 'image', urls: [m.url] }
      return {
        type: m.type === 'gif' ? 'gif' : 'video',
        urls: [m.url],
        duration: (m.duration_millis || 0) / 1000
      }
    })
    .filter((m) => m.urls?.[0])
  return {
    source: 'VxTwitter',
    author: json.user_name || '',
    handle: json.user_screen_name || '',
    text: json.text || '',
    link: json.tweetURL || `https://x.com/i/status/${id}`,
    media
  }
}

/**
 * Resuelve un post de X: devuelve { info, id, user, link, lastErr }.
 * info = null si ninguna API respondio. No descarga nada.
 */
export async function fetchXPost(rawUrl) {
  let raw = String(rawUrl || '')
  if (!STATUS_RE.test(raw) && TCO_RE.test(raw)) raw = await resolveTco(raw.match(TCO_RE)[0])
  const parsed = parseTweet(raw)
  if (!parsed) return null
  const { id, user } = parsed
  const link = `https://x.com/${user}/status/${id}`
  let info = null
  let lastErr = ''
  for (const fn of [fromFx, fromVx]) {
    try {
      const got = await fn(id, user)
      if (!info || got.media.length) info = got
      if (got.media.length) break
    } catch (e) {
      lastErr = e?.message || String(e)
      console.error(`[x] ${fn.name}`, lastErr)
    }
  }
  return { info, id, user, link, lastErr }
}

// yt-dlp es opcional: viene en el Dockerfile, pero en Termux puede no estar.
let ytDlpOk = null
async function hasYtDlp() {
  if (ytDlpOk !== null) return ytDlpOk
  const bin = resolveYtDlpBin()
  if (!bin) return (ytDlpOk = false)
  try {
    await execFileAsync(bin, ['--version'], { timeout: 15000 })
    ytDlpOk = true
  } catch {
    ytDlpOk = false
  }
  return ytDlpOk
}

async function fromYtDlp(link, maxSend) {
  if (!(await hasYtDlp())) throw new Error('yt-dlp no está instalado')
  const base = `${Date.now()}-x-ytdlp`
  const tpl = tmpPath(base + '.%(ext)s')
  const maxM = Math.max(1, Math.floor(maxSend / 1024 / 1024))
  await execFileAsync(
    resolveYtDlpBin(),
    [
      '-f', `best[ext=mp4][filesize<${maxM}M]/best[ext=mp4]/best`,
      '--no-playlist', '--no-warnings',
      '--max-filesize', `${maxM * 4}M`,
      '-o', tpl,
      link
    ],
    { timeout: 300000, maxBuffer: 20 * 1024 * 1024 }
  )
  const dir = tpl.slice(0, tpl.lastIndexOf('/'))
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(base))
  if (!hit) throw new Error('yt-dlp no generó archivo')
  return `${dir}/${hit}`
}

async function headSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: UA, signal: withTimeout(15000) })
    const n = Number(res.headers.get('content-length'))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * Baja la mejor calidad que quepa en Telegram (maxSend).
 * Si ninguna cabe, lanza TOO_HEAVY con el enlace directo.
 */
async function fetchItem(item, i, maxSend) {
  const ext = item.type === 'image' ? 'jpg' : 'mp4'
  let smallest = null
  for (const url of item.urls) {
    const size = await headSize(url)
    if (size && size > maxSend) {
      if (!smallest || size < smallest.size) smallest = { url, size }
      continue
    }
    const out = tmpPath(`${Date.now()}-x-${i}.${ext}`)
    try {
      const got = await downloadToFile(url, out, { timeout: 600000, maxBytes: maxSend })
      return { path: out, size: got, url }
    } catch (e) {
      safeUnlink(out)
      const msg = errText(e)
      if (/supera/i.test(msg)) {
        if (!smallest) smallest = { url, size: maxSend + 1 }
        continue
      }
      if (url === item.urls[item.urls.length - 1] && !smallest) throw e
      console.error('[x] item', i, msg)
    }
  }
  const err = new Error(`TOO_HEAVY:${smallest ? mb(smallest.size) : '?'}`)
  err.url = item.urls[0]
  throw err
}

export function buildCaption(info, link) {
  let text = (info?.text || '').replace(/https?:\/\/t\.co\/\S+/g, '').trim()
  if (text.length > 700) text = text.slice(0, 700).trim() + '…'
  const who = info
    ? `${info.author || 'Desconocido'}${info.handle ? ` (@${info.handle})` : ''}`
    : ''
  return [`𝕏 ${who || 'X/Twitter'}`, text, info?.link || link].filter(Boolean).join('\n\n').slice(0, 1024)
}

async function sendSingle(ctx, item, got, caption) {
  const input = new InputFile(got.path, `x.${item.type === 'image' ? 'jpg' : 'mp4'}`)
  const opts = caption ? { caption } : {}
  try {
    if (item.type === 'image') return await ctx.replyWithPhoto(input, opts)
    if (item.type === 'gif') return await ctx.replyWithAnimation(input, opts)
    return await ctx.replyWithVideo(input, { ...opts, supports_streaming: true })
  } catch (e) {
    console.error('[x] send', e?.description || e?.message || e)
    return ctx.replyWithDocument(new InputFile(got.path, `x.${item.type === 'image' ? 'jpg' : 'mp4'}`), opts)
  }
}

/**
 * sendOrCompress y maxSend se inyectan desde index (igual que downloads.js).
 */
export function createXHandler(sendOrCompress, { maxSend = 49 * 1024 * 1024 } = {}) {
  return async function handleX(ctx) {
    const q = argText(ctx)
    if (!q) {
      return ctx.reply('Uso: /x <enlace de X/Twitter>\nEj: /x https://x.com/usuario/status/123')
    }
    if (!STATUS_RE.test(q) && !TCO_RE.test(q)) {
      return ctx.reply('Enlace no válido. Usa un link de x.com o twitter.com con /status/…')
    }
    const status = await ctx.reply('Procesando X/Twitter...')
    const edit = (text) =>
      ctx.api.editMessageText(ctx.chat.id, status.message_id, text).catch(() => {})
    const files = []
    try {
      const res = await fetchXPost(q)
      if (!res) return edit('Enlace no válido. Usa un link de x.com o twitter.com con /status/…')
      const { info, link, lastErr } = res

      if (!info || !info.media.length) {
        // Ultimo recurso: yt-dlp (solo video)
        try {
          if (await hasYtDlp()) await edit('Probando con yt-dlp...')
          const p = await fromYtDlp(link, maxSend)
          files.push(p)
          await sendOrCompress(ctx, p, {
            kind: 'video',
            fileName: 'x.mp4',
            caption: buildCaption(info, link),
            statusId: status.message_id,
            fallbackLink: link
          })
          return
        } catch (e) {
          console.error('[x] yt-dlp', errText(e))
        }
        if (info) return edit(`Ese post no tiene videos ni imágenes para descargar.\n${info.link}`)
        return edit(
          `No pude obtener el post. Puede ser privado, estar eliminado o tener restricción de edad.\n${link}` +
            (lastErr ? `\n(${lastErr})` : '')
        )
      }

      const caption = buildCaption(info, link)
      const items = info.media.slice(0, MAX_MEDIA)
      const ready = []
      const failed = []
      for (let i = 0; i < items.length; i++) {
        await edit(`Descargando ${i + 1}/${items.length}...`)
        try {
          const got = await fetchItem(items[i], i, maxSend)
          files.push(got.path)
          ready.push({ item: items[i], got })
        } catch (e) {
          const m = errText(e)
          console.error('[x] media', i, m)
          if (m.startsWith('TOO_HEAVY:')) {
            failed.push(
              `El archivo ${i + 1} pesa ~${m.split(':')[1]} MB y Telegram solo envía ~${mb(maxSend)} MB.\nEnlace directo:\n${e.url}`
            )
          } else {
            failed.push(`No pude bajar el archivo ${i + 1}.\n${items[i].urls[0]}`)
          }
        }
      }

      let sent = 0
      if (ready.length > 1) {
        // Album: fotos y videos juntos (los GIF van como video)
        try {
          await ctx.replyWithMediaGroup(
            ready.map(({ item, got }, i) => ({
              type: item.type === 'image' ? 'photo' : 'video',
              media: new InputFile(got.path),
              ...(i === 0 ? { caption } : {}),
              ...(item.type !== 'image' ? { supports_streaming: true } : {})
            }))
          )
          sent = ready.length
        } catch (e) {
          console.error('[x] album', e?.description || e?.message || e)
        }
      }
      if (!sent) {
        for (let i = 0; i < ready.length; i++) {
          try {
            await sendSingle(ctx, ready[i].item, ready[i].got, i === 0 ? caption : '')
            sent++
          } catch (e) {
            console.error('[x] send', i, e?.description || e?.message || e)
            failed.push(`No pude enviar el archivo ${i + 1}.\n${ready[i].got.url}`)
          }
        }
      }

      if (failed.length) {
        const txt = (sent ? '' : caption + '\n\n') + failed.join('\n\n')
        await ctx.reply(txt.slice(0, 4000))
      }
      await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
    } catch (e) {
      console.error('[x]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e))
        .catch(() => ctx.reply(errText(e)))
    } finally {
      for (const f of files) safeUnlink(f)
    }
  }
}
