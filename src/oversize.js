// Archivos que pasan el tope de envío: botones "Enlace directo" / "En partes" (y "Comprimir" para video).
// En partes: video → ffmpeg segment por tiempo (-c copy, cada parte se reproduce sola);
// otros → corte binario .001/.002 (se unen con ZArchiver o `copy /b` en PC).
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { InputFile } from 'grammy'
import { tmpPath, safeUnlink, mb, sendLimit, errText, compressForTelegram } from './api.js'

const run = promisify(execFile)
const TTL_MS = 20 * 60 * 1000
const offers = new Map()
let seq = 0

export function freeBytes(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize) } catch { return Infinity }
}
// Tope de descarga: espacio libre menos margen, máximo 10 GB (MAX_DOWNLOAD_BYTES lo puede fijar)
export function downloadCap(dir = path.dirname(tmpPath('x'))) {
  const env = Number(process.env.MAX_DOWNLOAD_BYTES)
  const hard = env > 0 ? env : 10 * 1024 ** 3
  return Math.max(0, Math.min(hard, freeBytes(dir) - 200 * 1024 * 1024))
}

const isVideo = (f, kind) => kind === 'video' || /\.(mp4|mkv|webm|mov|m4v)$/i.test(f || '')

async function probeDuration(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 60000 })
    return Number(stdout.trim()) || 0
  } catch { return 0 }
}

// Video en partes reproducibles (< limit). Devuelve rutas.
export async function splitVideo(file, limit) {
  const size = fs.statSync(file).size
  const dur = await probeDuration(file)
  if (!dur) throw new Error('no pude leer la duración del video')
  const ext = path.extname(file) || '.mp4'
  const base = file.replace(/\.[^.]+$/, '') + '-part'
  let factor = 0.85
  for (let attempt = 0; attempt < 4; attempt++) {
    const segTime = Math.max(5, Math.floor(dur * (limit * factor) / size))
    for (const f of fs.readdirSync(path.dirname(file))) if (f.startsWith(path.basename(base))) safeUnlink(path.join(path.dirname(file), f))
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', '-f', 'segment', '-segment_time', String(segTime), '-reset_timestamps', '1', `${base}%03d${ext}`], { timeout: 60 * 60 * 1000 })
    const parts = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(path.basename(base))).sort().map((f) => path.join(path.dirname(file), f))
    if (parts.length && parts.every((p) => fs.statSync(p).size <= limit)) return parts
    factor *= 0.7 // los cortes van en keyframes: si una parte se pasó, cortar más chico
  }
  throw new Error('no pude cortar el video en partes que quepan')
}

// Corte binario estilo 7z: name.001, name.002…
export async function splitBinary(file, limit, name) {
  const chunk = Math.floor(limit * 0.98)
  const size = fs.statSync(file).size
  const n = Math.ceil(size / chunk)
  const parts = []
  const fd = fs.openSync(file, 'r')
  try {
    for (let i = 0; i < n; i++) {
      const out = tmpPath(`${Date.now()}-${name}.${String(i + 1).padStart(3, '0')}`)
      await new Promise((res, rej) => {
        fs.createReadStream(null, { fd, start: i * chunk, end: Math.min(size, (i + 1) * chunk) - 1, autoClose: false })
          .pipe(fs.createWriteStream(out)).on('finish', res).on('error', rej)
      })
      parts.push(out)
    }
  } finally { fs.closeSync(fd) }
  return parts
}

function cleanup(id) {
  const o = offers.get(id)
  if (!o) return
  offers.delete(id)
  clearTimeout(o.timer)
  safeUnlink(o.file)
}

/**
 * Ofrece opciones para un archivo más grande que el tope.
 * file: ruta ya descargada (se mueve para que el llamador no la borre) o null.
 * fetchFile: async (maxBytes) => ruta, para bajarlo cuando elijan "En partes".
 */
export async function offerOversize(ctx, { file = null, fetchFile = null, size = 0, kind = 'document', fileName = 'archivo', caption = '', link = '', linkNote = '', statusId = null }) {
  const id = String(++seq)
  let own = null
  if (file && fs.existsSync(file)) {
    own = tmpPath(`ovs-${id}-${path.basename(file)}`)
    try { fs.renameSync(file, own) } catch { own = file }
    size = size || fs.statSync(own).size
  }
  const limit = sendLimit()
  const o = { file: own, fetchFile, size, kind, fileName, caption, link, linkNote, chatId: ctx.chat.id }
  o.timer = setTimeout(() => cleanup(id), TTL_MS)
  offers.set(id, o)
  const btns = []
  if (link) btns.push({ text: '🔗 Enlace directo', callback_data: `ovs:l:${id}` })
  if (own || fetchFile) btns.push({ text: '🧩 En partes', callback_data: `ovs:p:${id}` })
  if (own && isVideo(own, kind)) btns.push({ text: '🗜️ Comprimir', callback_data: `ovs:c:${id}` })
  const text = `${caption ? caption.slice(0, 300) + '\n\n' : ''}Pesa ${size ? mb(size) + ' MB' : 'más'} y el tope de envío es ${mb(limit)} MB.\nElige cómo lo quieres (vale 20 min):`
  const extra = btns.length ? { reply_markup: { inline_keyboard: [btns] } } : {}
  if (statusId) await ctx.api.editMessageText(ctx.chat.id, statusId, text, extra).catch(() => ctx.reply(text, extra))
  else await ctx.reply(text, extra)
  if (!btns.length) cleanup(id)
  return false
}

async function sendParts(ctx, o, id) {
  clearTimeout(o.timer)
  offers.delete(id)
  const limit = sendLimit()
  const st = await ctx.reply('Preparando partes...')
  const say = (t) => ctx.api.editMessageText(ctx.chat.id, st.message_id, t).catch(() => {})
  let parts = []
  try {
    if (!o.file) {
      const need = (o.size || 0) * 2.1
      const cap = Math.max(0, freeBytes(path.dirname(tmpPath('x'))) - 200 * 1024 * 1024)
      if (need && need > cap) return say(`No hay espacio: hace falta ~${mb(need)} MB libres y hay ${mb(cap)} MB. Libera espacio o usa el enlace.`)
      await say(`Descargando completo${o.size ? ` (~${mb(o.size)} MB)` : ''}...`)
      o.file = await o.fetchFile(downloadCap())
      o.size = fs.statSync(o.file).size
    } else if (o.size * 1.1 > freeBytes(path.dirname(o.file))) {
      return say(`No hay espacio para cortar (${mb(o.size)} MB). Libera espacio o usa el enlace.`)
    }
    await say('Cortando en partes...')
    const video = isVideo(o.file, o.kind)
    let binary = !video
    if (video) {
      try { parts = await splitVideo(o.file, limit) } catch (e) { console.error('[ovs] video split', errText(e)); binary = true }
    }
    if (binary) parts = await splitBinary(o.file, limit, o.fileName.replace(/[^\w.\- ]+/g, '_'))
    for (let i = 0; i < parts.length; i++) {
      await say(`Enviando parte ${i + 1}/${parts.length}...`)
      const cap = `Parte ${i + 1}/${parts.length}${i === 0 && o.caption ? ' · ' + o.caption.slice(0, 200) : ''}`
      const name = binary ? path.basename(parts[i]).replace(/^\d+-/, '') : o.fileName.replace(/(\.[^.]+)?$/, `_parte${i + 1}$1`)
      const input = new InputFile(parts[i], name)
      if (!binary) { try { await ctx.replyWithVideo(input, { caption: cap, supports_streaming: true }) } catch { await ctx.replyWithDocument(new InputFile(parts[i], name), { caption: cap }) } }
      else await ctx.replyWithDocument(input, { caption: cap })
      safeUnlink(parts[i])
    }
    if (binary) await ctx.reply('Para unir las partes: en Android abre la .001 con ZArchiver (las demás en la misma carpeta). En PC (cmd):\ncopy /b archivo.001+archivo.002+… archivo_final').catch(() => {})
    await ctx.api.deleteMessage(ctx.chat.id, st.message_id).catch(() => {})
  } catch (e) {
    await say(`No pude mandarlo en partes: ${errText(e).slice(0, 200)}`)
  } finally {
    for (const p of parts) safeUnlink(p)
    safeUnlink(o.file)
  }
}

export function registerOversize(bot) {
  bot.callbackQuery(/^ovs:([lpc]):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    const [, act, id] = ctx.match
    const o = offers.get(id)
    if (!o) return ctx.reply('Esa opción ya venció. Pídelo otra vez.')
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    if (act === 'l') {
      await ctx.reply(`🔗 Enlace directo:\n${o.link}${o.linkNote ? `\n${o.linkNote}` : ''}`)
      return cleanup(id)
    }
    if (act === 'c') {
      offers.delete(id); clearTimeout(o.timer)
      const st = await ctx.reply('Comprimiendo...')
      let out = null
      try {
        out = await compressForTelegram(o.file, sendLimit())
        if (!out || fs.statSync(out).size > sendLimit()) throw new Error('aun comprimido no cabe; usa "En partes"')
        await ctx.replyWithVideo(new InputFile(out, o.fileName), { caption: o.caption?.slice(0, 1000) })
        await ctx.api.deleteMessage(ctx.chat.id, st.message_id).catch(() => {})
      } catch (e) { await ctx.api.editMessageText(ctx.chat.id, st.message_id, `No se pudo: ${errText(e).slice(0, 200)}`).catch(() => {}) }
      finally { safeUnlink(out); safeUnlink(o.file) }
      return
    }
    return sendParts(ctx, o, id)
  })
}
