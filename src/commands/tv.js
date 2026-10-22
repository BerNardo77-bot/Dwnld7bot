// /tv (alias /canal) — TV en vivo: link directo (m3u8/rtmp, como en VLC) o nombre del canal (listas iptv-org).
// Eliges canal y duración (5-60 min), se graba con ffmpeg y se manda el video (en partes si hace falta).
import fs from 'fs'
import { InputFile } from 'grammy'
import os from 'os'
import { searchLive, probeStream, recordStream, isStreamUrl, isDirectStream, chanLine, logosFor, TV_DURS, TV_MAX_MIN } from '../tv-core.js'
import { freeDisk, MAX_TOTAL_BYTES } from '../video-split.js'

export const TV_COMMANDS = ['tv', 'canal', 'canaltv', 'television']
export { isDirectStream }
const lists = new Map() // chat → { items, until }
const pending = new Map() // chat → { url, headers, title, until }
const jobs = new Map() // chat → { ac, userId, ch, stId }
const mb = (b) => (b / 1048576).toFixed(1)
const short = (s = '', n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const label = (m) => m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`
const durKb = () => ({ inline_keyboard: [TV_DURS.slice(0, 5), TV_DURS.slice(5)].map(row => row.map(m => ({ text: `⏺ ${label(m)}`, callback_data: `tvd:${m}` }))) })

export function createTvHandler(sendOrCompress, { partCap = () => 49 * 1024 * 1024 } = {}) {
  async function offer(ctx, ch) {
    const st = await ctx.reply(`📺 Revisando la señal de ${short(ch.title, 80)}…`).catch(() => null)
    const say = (t, extra) => st ? ctx.api.editMessageText(ctx.chat.id, st.message_id, t, extra).catch(() => ctx.reply(t, extra)) : ctx.reply(t, extra)
    const p = await probeStream(ch.url, ch.headers)
    if (!p.ok) return say(`❌ ${short(ch.title, 80)}: ${p.reason}`)
    pending.set(String(ctx.chat.id), { ...ch, until: Date.now() + 30 * 60 * 1000 })
    return say(`📺 ${short(ch.title, 120)} está al aire${p.height ? ` (${p.height}p)` : ''}${p.video ? '' : ' (solo audio)'}.\n¿Cuántos minutos grabo? (o escribe /tvmin 45 para otro número, máx. 300)`, { reply_markup: durKb() })
  }

  const cancelKb = { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'tvx' }]] }

  async function grabar(ctx, ch, min) {
    const key = String(ctx.chat.id)
    if (jobs.has(key)) return ctx.reply('Ya estoy grabando TV en este chat. Para cancelar: /tvcancel')
    const dir = os.tmpdir()
    const part = partCap()
    const maxBytes = Math.min(MAX_TOTAL_BYTES, freeDisk(dir) - 300 * 1024 * 1024 - part)
    if (maxBytes < 20 * 1024 * 1024) return ctx.reply('No hay espacio libre en el servidor para grabar ahora. Intenta más tarde.')
    const ac = new AbortController()
    const job = { ac, userId: ctx.from?.id, ch, stId: null }
    jobs.set(key, job)
    const st = await ctx.reply(`⏺ Grabando ${label(min)} de ${short(ch.title, 80)}… te aviso al terminar.\nPara cancelar: botón ❌ o /tvcancel`, { reply_markup: cancelKb }).catch(() => null)
    job.stId = st?.message_id || null
    let last = 0, rec = null
    const onProgress = (s, b) => {
      if (!st || ac.signal.aborted || Date.now() - last < 30000) return
      last = Date.now()
      ctx.api.editMessageText(ctx.chat.id, st.message_id, `⏺ Grabando ${short(ch.title, 60)}: ${Math.min(min, Math.floor(s / 60))}/${min} min · ${mb(b)} MB\nPara cancelar: botón ❌ o /tvcancel`, { reply_markup: cancelKb }).catch(() => {})
    }
    // Si se cancela mientras se envía, este ctx deja de mandar archivos (no salen más partes)
    const guarded = new Proxy(ctx, { get(t, prop) {
      const v = Reflect.get(t, prop)
      if (typeof prop === 'string' && /^replyWith(Video|Document|Audio|Photo|MediaGroup)$/.test(prop)) return (...a) => { if (ac.signal.aborted) throw Object.assign(new Error('cancelado'), { cancelled: true }); return v.apply(t, a) }
      return typeof v === 'function' ? v.bind(t) : v
    } })
    try {
      rec = await recordStream(ch.url, min * 60, { headers: ch.headers, alts: ch.alts || [], title: ch.title, maxBytes, onProgress, signal: ac.signal })
      if (ac.signal.aborted) throw Object.assign(new Error('cancelado'), { cancelled: true })
      const got = `${Math.floor(rec.seconds / 60)}:${String(rec.seconds % 60).padStart(2, '0')}`
      if (st) await ctx.api.editMessageText(ctx.chat.id, st.message_id, `✅ Grabado ${got} (${mb(rec.size)} MB). Enviando…`, { reply_markup: cancelKb }).catch(() => {})
      const notes = [rec.seconds < min * 60 - 30 ? `⚠️ La señal se cortó: solo se grabaron ${got}.` : '', rec.cut ? '⚠️ Se detuvo por falta de espacio en el servidor.' : '', rec.reencoded ? 'ℹ️ Se recodificó (la señal no se podía copiar tal cual).' : '', rec.pieces > 1 ? `ℹ️ La señal se reconectó ${rec.pieces - 1} vez/veces; uní todo en un solo video.` : ''].filter(Boolean)
      console.log(`[tv] enviando ${rec.name} (${(rec.size / 1048576).toFixed(1)} MB)…`)
      await sendOrCompress(guarded, rec.file, { kind: 'video', fileName: rec.name, caption: short(`📺 ${ch.title} · ${got}`, 1000), statusId: st?.message_id, fallbackLink: '' })
      if (!ac.signal.aborted && notes.length) await ctx.reply(notes.join('\n')).catch(() => {})
    } catch (e) {
      if (!(e?.cancelled || ac.signal.aborted)) {
        if (st) ctx.api.deleteMessage(ctx.chat.id, st.message_id).catch(() => {})
        await ctx.reply('❌ No pude grabar: ' + short(e?.message || e, 300)).catch(() => {})
      }
    } finally {
      if (rec?.dir) try { fs.rmSync(rec.dir, { recursive: true, force: true }) } catch {}
      if (jobs.get(key) === job) jobs.delete(key)
    }
  }

  // Cancela: solo quien la empezó o un admin del grupo. Vuelve a mostrar el menú de duración del mismo canal.
  async function cancel(ctx) {
    const key = String(ctx.chat?.id)
    const job = jobs.get(key)
    if (!job) return ctx.reply('No hay ninguna grabación de TV en curso en este chat.').catch(() => {})
    let allowed = !job.userId || ctx.from?.id === job.userId
    if (!allowed && ctx.chat?.type !== 'private') {
      try { const m = await ctx.getChatMember(ctx.from.id); allowed = ['creator', 'administrator'].includes(m.status) } catch {}
    }
    if (!allowed) return ctx.reply('Solo quien empezó la grabación (o un admin) puede cancelarla.').catch(() => {})
    job.ac.abort()
    jobs.delete(key)
    if (job.stId) ctx.api.editMessageText(ctx.chat.id, job.stId, '⏹ Grabación cancelada.').catch(() => {})
    pending.set(key, { ...job.ch, until: Date.now() + 30 * 60 * 1000 })
    return ctx.reply(`⏹ Grabación cancelada. No se mandó nada y se borraron los archivos.\n\n⏺ ¿Cuánto grabo de ${short(job.ch.title, 100)}? (o /tvmin 45 para otro número, máx. ${TV_MAX_MIN})`, { reply_markup: durKb() }).catch(() => {})
  }

  async function handle(ctx) {
    const q = String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim()
    if (!q) return ctx.reply('📺 Uso:\n/tv <nombre del canal> — busca en las listas públicas (iptv-org). Ej: /tv milenio · /tv canal 22 · /tv antena 3 es\n/tv <link> — link directo .m3u8, http o rtmp (como en VLC)\nLuego eliges canal y minutos (5 a 300 = 5 horas; /tvmin <min> para otro número) y te mando el video. Cancelar: /tvcancel\nCon link puedes poner los minutos: /tv <link> 120')
    const [first, ...rest] = q.split(/\s+/)
    if (isStreamUrl(first)) {
      const min = Number((rest.join(' ').match(/^(\d{1,3})/) || [])[1]) || 0
      const ch = { url: first, headers: {}, title: 'TV en vivo' }
      if (min) {
        const p = await probeStream(first)
        if (!p.ok) return ctx.reply('❌ ' + p.reason)
        grabar(ctx, ch, Math.min(min, TV_MAX_MIN)).catch(() => {}) // sin await: grammy procesa en orden y no debe quedarse bloqueado horas
        return
      }
      return offer(ctx, ch)
    }
    let st = await ctx.reply('🔎 Buscando canales al aire… (reviso cuáles funcionan, tarda unos segundos)').catch(() => null)
    let items = []
    let total = 0
    try { const r = await searchLive(q, { limit: 10, pool: 30 }); items = r.items; total = r.total } catch (e) { console.error('[tv]', e?.message || e) }
    const say = (t, extra) => st ? ctx.api.editMessageText(ctx.chat.id, st.message_id, t, extra).catch(() => ctx.reply(t, extra)) : ctx.reply(t, extra)
    if (!items.length && total) return say(`Encontré ${total} canal(es) con "${short(q, 60)}", pero ninguno está al aire ahora (o no responde desde el servidor). Prueba más tarde, otro nombre o el link directo .m3u8.`)
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
    return say(`📺 Canales al aire:\n${items.map(chanLine).join('\n')}\n\nElige un número.`, { reply_markup: { inline_keyboard: rows } })
  }

  async function handleMin(ctx) {
    const n = Number(String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim())
    const ch = pending.get(String(ctx.chat?.id))
    if (!ch || Date.now() > ch.until) return ctx.reply('Primero elige un canal con /tv <canal> o /tv <link>.')
    if (!Number.isFinite(n) || n < 1 || n > TV_MAX_MIN) return ctx.reply(`Escribe los minutos de 1 a ${TV_MAX_MIN}. Ej: /tvmin 45`)
    grabar(ctx, ch, Math.round(n)).catch(() => {})
  }

  function register(bot) {
    bot.command(['tvmin', 'tvminutos'], (ctx) => handleMin(ctx))
    bot.command(['tvcancel', 'tvcancelar', 'cancelartv'], (ctx) => cancel(ctx))
    bot.callbackQuery('tvx', async (ctx) => { await ctx.answerCallbackQuery().catch(() => {}); return cancel(ctx) })
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
