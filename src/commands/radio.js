// /radio <nombre, país o ciudad> → lista con botones; toca o responde N (info + menú) o "N 5" (5 min). /radio <link> [min]. "rec 10" regraba la última.
import fs from 'fs'
import { InputFile } from 'grammy'
import { searchStations, recordStation, stationLine, stationInfo, faviconCover, parseMinutes, isStreamUrl, stationFromUrl, countClick, DEFAULT_REC_SEC, MAX_REC_MIN } from '../radio-core.js'
import { makeThumb } from '../audio-tags.js'
import { errText, sendLimit } from '../api.js'
import { markList, lastList } from './music.js'

export const RADIO_COMMANDS = ['radio', 'radios', 'fm']
const TTL = 10 * 60 * 1000
const LIST_MAX = 50
const lists = new Map() // chat → { items, until }
const jobs = new Set()
const lastStation = new Map()
const DURS = [5, 10, 15, 30]
const HINT = `Responde "2 10" para grabar 10 min (máx. ${MAX_REC_MIN})`
const durKeyboard = () => ({ reply_markup: { inline_keyboard: [DURS.map(m => ({ text: `⏺ ${m} min`, callback_data: `radd:${m}` }))] } })
const short = (s = '', n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const argText = (ctx) => String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim()

/** Elegir estación: info + link En vivo y botones de duración (ya no graba solo). */
async function ofrecer(ctx, st) {
  lastStation.set(String(ctx.chat.id), { st, until: Date.now() + 30 * 60 * 1000 })
  countClick(st.uuid)
  const fav = await faviconCover(st.favicon).catch(() => null)
  const info = stationInfo(st)
  if (fav) await ctx.replyWithPhoto(new InputFile(fav, 'radio.jpg'), { caption: short(info, 1000) }).catch(() => ctx.reply(info, { link_preview_options: { is_disabled: true } }))
  else await ctx.reply(info, { link_preview_options: { is_disabled: true } }).catch(() => {})
  await ctx.reply(`⏺ ¿Grabar ${short(st.name, 60)} en MP3? Elige duración (o escribe "rec N", 1-${MAX_REC_MIN}):`, durKeyboard()).catch(() => {})
}

async function grabar(ctx, st, seconds) {
  const key = String(ctx.chat.id)
  if (jobs.has(key)) return ctx.reply('Ya estoy grabando una radio en este chat. Espera a que termine.')
  jobs.add(key)
  lastStation.set(key, { st, until: Date.now() + 30 * 60 * 1000 })
  let rec = null
  try {
        const fav = await faviconCover(st.favicon)
    const min = Math.round(seconds / 60)
    void fav
    await ctx.reply(`⏺ Grabando ${short(st.name, 60)} · ${seconds >= 60 ? min + ' min' : seconds + ' s'}…${seconds >= 300 ? ' te aviso al terminar.' : ''}`).catch(() => {})
    // Progreso (mensaje editado cada minuto) en grabaciones largas
    const t0 = Date.now()
    const prog = seconds >= 180 ? await ctx.reply(`⏺ ${short(st.name, 60)}: 0/${min} min…`).catch(() => null) : null
    const tick = prog ? setInterval(() => { ctx.api.editMessageText(ctx.chat.id, prog.message_id, `⏺ ${short(st.name, 60)}: ${Math.min(min, Math.floor((Date.now() - t0) / 60000))}/${min} min…`).catch(() => {}) }, 60000) : null
    try { rec = await recordStation(st, seconds, { maxBytes: sendLimit() - 512 * 1024 }) } finally { if (tick) clearInterval(tick); if (prog) ctx.api.deleteMessage(ctx.chat.id, prog.message_id).catch(() => {}) }
    console.log(`[radio] ${st.name} ${rec.seconds}s ${(rec.size / 1048576).toFixed(1)} MB ${rec.url}`)
    const thumb = rec.cover ? await makeThumb(rec.cover, 320).catch(() => null) : null
    await ctx.replyWithAudio(new InputFile(rec.file, rec.name), {
      title: short(`${st.name} (en vivo)`, 64), performer: short(st.country || 'Radio', 64), duration: rec.seconds,
      ...(thumb ? { thumbnail: new InputFile(thumb, 'cover.jpg') } : {}),
      caption: `📻 ${short(st.name, 200)} · ${Math.floor(rec.seconds / 60)}:${String(rec.seconds % 60).padStart(2, '0')}`
    })
    await ctx.reply(`⏺ ¿Grabar más de ${short(st.name, 60)}? Elige duración (o escribe "rec N", 1-${MAX_REC_MIN}):`, durKeyboard()).catch(() => {})
  } catch (e) {
    console.error('[radio]', errText(e))
    await ctx.reply(`${short(errText(e), 250)}\nPrueba otra estación.`).catch(() => {})
  } finally {
    if (rec?.dir) fs.rmSync(rec.dir, { recursive: true, force: true })
    jobs.delete(key)
  }
}

function keyboard(n) {
  const rows = []
  const max = Math.min(n, 20)
  for (let s = 0; s < max; s += 5) rows.push(Array.from({ length: Math.min(5, max - s) }, (_, j) => ({ text: String(s + j + 1), callback_data: `rad:${s + j + 1}` })))
  return rows.length ? { reply_markup: { inline_keyboard: rows } } : {}
}

export async function handleRadio(ctx) {
  const q = argText(ctx)
  if (!q) return ctx.reply(`📻 Uso:\n/radio <nombre, país o ciudad> → lista de estaciones\n/radio <link del stream> [minutos] → link y opciones (con minutos graba directo)\nToca un botón o responde el número (te doy el link y 5/10/15/30 min), o "número minutos" (ej. 2 10), máx. ${MAX_REC_MIN} min.\n"rec 5" vuelve a grabar la última estación 5 min.\nEjemplo: /radio Exa · /radio Mexico`)
  const url = (q.match(/https?:\/\/\S+/) || [])[0]
  if (url && isStreamUrl(url)) {
    const min = parseMinutes(q.replace(url, ''))
    return min ? grabar(ctx, stationFromUrl(url), min * 60) : ofrecer(ctx, stationFromUrl(url))
  }
  let list
  try { list = await searchStations(q, LIST_MAX) } catch (e) { return ctx.reply('Radio Browser no responde ahora. ' + short(errText(e), 120)) }
  if (!list.length) return ctx.reply(`No encontré radios para "${q}". Prueba con otro nombre, país o ciudad.`)
  lists.set(String(ctx.chat.id), { items: list, until: Date.now() + TTL })
  markList(ctx.chat.id, 'radio')
  // Logos de las primeras 10 como álbum de fotos
  const favs = await Promise.all(list.slice(0, 10).map(s => faviconCover(s.favicon).then(b => b && makeThumb(b, 320)).catch(() => null)))
  const media = favs.map((b, i) => b ? { type: 'photo', media: new InputFile(b, `r${i + 1}.jpg`), caption: short(stationLine(list[i], i), 1000) } : null).filter(Boolean)
  if (media.length >= 2) await ctx.replyWithMediaGroup(media).catch((e) => console.error('[radio] fotos', errText(e)))
  else if (media.length === 1) await ctx.replyWithPhoto(media[0].media, { caption: media[0].caption }).catch(() => {})
  const lines = list.map((s, i) => short(stationLine(s, i), 180))
  const head = `📻 Radios › ${q}\n\n`
  const foot = `\n\n✎ Toca un botón o responde el número (1-${list.length}) y te doy el link y opciones para grabar.\n${HINT} · vale 10 min`
  const parts = []; let cur = [], len = head.length
  for (const l of lines) { if (cur.length >= 60 || len + l.length > 3700) { parts.push(cur); cur = []; len = 0 } cur.push(l); len += l.length + 1 }
  parts.push(cur)
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    await ctx.reply((i ? '' : head) + parts[i].join('\n') + (last ? foot : ''), { link_preview_options: { is_disabled: true }, ...(last ? keyboard(list.length) : {}) }).catch((e) => console.error('[radio] lista', errText(e)))
  }
}

function pick(ctx, n, min = 0) {
  const k = String(ctx.chat.id)
  const l = lists.get(k)
  if (!l || Date.now() > l.until) return false
  if (n < 1 || n > l.items.length) { ctx.reply(`Elige un número del 1 al ${l.items.length}.`).catch(() => {}); return true }
  ;(min ? grabar(ctx, l.items[n - 1], Math.min(min, MAX_REC_MIN) * 60) : ofrecer(ctx, l.items[n - 1])).catch(() => {})
  return true
}

export function registerRadio(bot) {
  bot.callbackQuery(/^radd:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    const ls = lastStation.get(String(ctx.chat?.id))
    if (!ls || Date.now() > ls.until) return ctx.reply('Ya venció (30 min). Elige la estación otra vez con /radio.').catch(() => {})
    grabar(ctx, ls.st, Math.max(1, Math.min(Number(ctx.match[1]), MAX_REC_MIN)) * 60).catch(() => {})
  })
  bot.callbackQuery(/^rad:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!pick(ctx, Number(ctx.match[1]))) await ctx.reply('Esa lista ya venció (10 min). Búscala otra vez con /radio.').catch(() => {})
  })
  bot.hears(/^\s*rec\s+(\d{1,3})\s*(m|min|minutos?)?\s*$/i, async (ctx, next) => {
    const ls = lastStation.get(String(ctx.chat?.id))
    if (!ls || Date.now() > ls.until) return next()
    grabar(ctx, ls.st, Math.max(1, Math.min(Number(ctx.match[1]), MAX_REC_MIN)) * 60).catch(() => {})
  })
  bot.hears(/^\s*(\d{1,4})(?:\s+(\d{1,3})\s*(?:m|min|minutos?)?)?\s*$/i, async (ctx, next) => {
    const k = String(ctx.chat?.id)
    if (lastList.get(k) !== 'radio' || !lists.has(k)) return next()
    if (!pick(ctx, Number(ctx.match[1]), Number(ctx.match[2]) || 0)) return next()
  })
}
