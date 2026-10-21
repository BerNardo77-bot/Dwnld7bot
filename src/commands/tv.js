// /tv (alias /canal) — TV en vivo: link directo (m3u8/rtmp, como en VLC) o nombre del canal (listas iptv-org).
// Eliges canal y duración (5-60 min), se graba con ffmpeg y se manda el video (en partes si hace falta).
import fs from 'fs'
import { InputFile } from 'grammy'
import os from 'os'
import { searchChannels, probeStream, recordStream, isStreamUrl, isDirectStream, chanLine, logosFor, TV_DURS, TV_MAX_MIN } from '../tv-core.js'
import { freeDisk, MAX_TOTAL_BYTES } from '../video-split.js'

export const TV_COMMANDS = ['tv', 'canal', 'canaltv', 'television']
export { isDirectStream }
const lists = new Map() // chat → { items, until }
const pending = new Map() // chat → { url, headers, title, until }
const jobs = new Set()
const mb = (b) => (b / 1048576).toFixed(1)
const short = (s = '', n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const durKb = () => ({ inline_keyboard: [TV_DURS.map(m => ({ text: `⏺ ${m} min`, callback_data: `tvd:${m}` }))] })

export function createTvHandler(sendOrCompress, { partCap = () => 49 * 1024 * 1024 } = {}) {
  async function offer(ctx, ch) {
    const st = await ctx.reply(`📺 Revisando la señal de ${short(ch.title, 80)}…`).catch(() => null)
    const say = (t, extra) => st ? ctx.api.editMessageText(ctx.chat.id, st.message_id, t, extra).catch(() => ctx.reply(t, extra)) : ctx.reply(t, extra)
    const p = await probeStream(ch.url, ch.headers)
    if (!p.ok) return say(`❌ ${short(ch.title, 80)}: ${p.reason}`)
    pending.set(String(ctx.chat.id), { ...ch, until: Date.now() + 30 * 60 * 1000 })
    return say(`📺 ${short(ch.title, 120)} está al aire${p.height ? ` (${p.height}p)` : ''}${p.video ? '' : ' (solo audio)'}.\n¿Cuántos minutos grabo?`, { reply_markup: durKb() })
  }

  async function grabar(ctx, ch, min) {
    const key = String(ctx.chat.id)
    if (jobs.has(key)) return ctx.reply('Ya estoy grabando TV en este chat. Espera a que termine.')
    const dir = os.tmpdir()
    const part = partCap()
    const maxBytes = Math.min(MAX_TOTAL_BYTES, freeDisk(dir) - 300 * 1024 * 1024 - part)
    if (maxBytes < 20 * 1024 * 1024) return ctx.reply('No hay espacio libre en el servidor para grabar ahora. Intenta más tarde.')
    jobs.add(key)
    const st = await ctx.reply(`⏺ Grabando ${min} min de ${short(ch.title, 80)}… te aviso al terminar.`).catch(() => null)
    let last = 0, rec = null
    const onProgress = (s, b) => {
      if (!st || Date.now() - last < 30000) return
      last = Date.now()
      ctx.api.editMessageText(ctx.chat.id, st.message_id, `⏺ Grabando ${short(ch.title, 60)}: ${Math.min(min, Math.floor(s / 60))}/${min} min · ${mb(b)} MB`).catch(() => {})
    }
    try {
      rec = await recordStream(ch.url, min * 60, { headers: ch.headers, title: ch.title, maxBytes, onProgress })
      const got = `${Math.floor(rec.seconds / 60)}:${String(rec.seconds % 60).padStart(2, '0')}`
      if (st) await ctx.api.editMessageText(ctx.chat.id, st.message_id, `✅ Grabado ${got} (${mb(rec.size)} MB). Enviando…`).catch(() => {})
      const notes = [rec.seconds < min * 60 - 30 ? `⚠️ La señal se cortó: solo se grabaron ${got}.` : '', rec.cut ? '⚠️ Se detuvo por falta de espacio en el servidor.' : '', rec.reencoded ? 'ℹ️ Se recodificó (la señal no se podía copiar tal cual).' : ''].filter(Boolean)
      await sendOrCompress(ctx, rec.file, { kind: 'video', fileName: rec.name, caption: short(`📺 ${ch.title} · ${got}`, 1000), statusId: st?.message_id, fallbackLink: '' })
      if (notes.length) await ctx.reply(notes.join('\n')).catch(() => {})
    } catch (e) {
      if (st) ctx.api.deleteMessage(ctx.chat.id, st.message_id).catch(() => {})
      await ctx.reply('❌ No pude grabar: ' + short(e?.message || e, 300)).catch(() => {})
    } finally {
      if (rec?.dir) fs.rmSync(rec.dir, { recursive: true, force: true })
      jobs.delete(key)
    }
  }

  async function handle(ctx) {
    const q = String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim()
    if (!q) return ctx.reply('📺 Uso:\n/tv <nombre del canal> — busca en las listas públicas (iptv-org). Ej: /tv milenio · /tv canal 22 · /tv antena 3 es\n/tv <link> — link directo .m3u8, http o rtmp (como en VLC)\nLuego eliges canal y minutos (5, 10, 15, 30 o 60) y te mando el video.')
    const [first, ...rest] = q.split(/\s+/)
    if (isStreamUrl(first)) {
      const min = Number((rest.join(' ').match(/^(\d{1,3})/) || [])[1]) || 0
      const ch = { url: first, headers: {}, title: 'TV en vivo' }
      if (min) {
        const p = await probeStream(first)
        if (!p.ok) return ctx.reply('❌ ' + p.reason)
        return grabar(ctx, ch, Math.min(min, TV_MAX_MIN))
      }
      return offer(ctx, ch)
    }
    let st = await ctx.reply('🔎 Buscando canales…').catch(() => null)
    let items = []
    try { items = await searchChannels(q, { limit: 10 }) } catch (e) { console.error('[tv]', e?.message || e) }
    const say = (t, extra) => st ? ctx.api.editMessageText(ctx.chat.id, st.message_id, t, extra).catch(() => ctx.reply(t, extra)) : ctx.reply(t, extra)
    if (!items.length) return say(`No encontré canales con "${short(q, 60)}". Prueba otro nombre o agrega el país (ej: /tv antena 3 es), o pega el link directo .m3u8.`)
    lists.set(String(ctx.chat.id), { items, until: Date.now() + 30 * 60 * 1000 })
    // Logos como en ytsearch (álbum con número y nombre). Si falla, sigue solo con la lista de texto.
    try {
      const logos = await logosFor(items, 320)
      const media = items.map((it, i) => logos[i] ? { type: 'photo', media: new InputFile(logos[i], `canal${i + 1}.jpg`), caption: short(chanLine(it, i), 1000) } : null).filter(Boolean)
      if (media.length >= 2) await ctx.replyWithMediaGroup(media).catch(async (e) => { console.error('[tv] album', e?.message || e) })
      else if (media.length === 1) await ctx.replyWithPhoto(media[0].media, { caption: media[0].caption }).catch(() => {})
      if (media.length && st) { ctx.api.deleteMessage(ctx.chat.id, st.message_id).catch(() => {}); st = null } // la lista va debajo de las fotos
    } catch (e) { console.error('[tv] logos', e?.message || e) }
    const rows = []
    for (let i = 0; i < items.length; i += 5) rows.push(items.slice(i, i + 5).map((_, j) => ({ text: String(i + j + 1), callback_data: `tvp:${i + j}` })))
    return say(`📺 Canales encontrados:\n${items.map(chanLine).join('\n')}\n\nElige un número.`, { reply_markup: { inline_keyboard: rows } })
  }

  function register(bot) {
    bot.callbackQuery(/^tvp:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {})
      const l = lists.get(String(ctx.chat?.id))
      if (!l || Date.now() > l.until) return ctx.reply('La lista ya venció. Busca otra vez con /tv <canal>.').catch(() => {})
      const ch = l.items[Number(ctx.match[1])]
      if (ch) offer(ctx, ch).catch(() => {})
    })
    bot.callbackQuery(/^tvd:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {})
      const ch = pending.get(String(ctx.chat?.id))
      if (!ch || Date.now() > ch.until) return ctx.reply('Ya venció. Elige el canal otra vez con /tv.').catch(() => {})
      grabar(ctx, ch, Math.min(Number(ctx.match[1]), TV_MAX_MIN)).catch(() => {})
    })
  }
  return { handle, register }
}
