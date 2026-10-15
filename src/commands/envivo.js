// /envivo <link o @canal> → link directo (VLC) + botones para grabar 5/10/15/30 min en MP3
import fs from 'fs'
import { InputFile } from 'grammy'
import { liveTarget, liveInfo, recordLive, vlcSteps, ipNote, MAX_LIVE_MIN } from '../live-core.js'
import { makeThumb } from '../audio-tags.js'
import { errText, sendLimit } from '../api.js'

export const ENVIVO_COMMANDS = ['envivo', 'live', 'ytlive']
const lastLive = new Map()
const jobs = new Set()
const short = (s = '', n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

async function grabar(ctx, url, min) {
  const key = String(ctx.chat.id)
  if (jobs.has(key)) return ctx.reply('Ya estoy grabando un en vivo en este chat. Espera a que termine.')
  jobs.add(key)
  let rec = null
  const st = await ctx.reply(`⏺ Grabando ${min} min del en vivo… te aviso al terminar.`).catch(() => null)
  const t0 = Date.now()
  const tick = st && min >= 3 ? setInterval(() => ctx.api.editMessageText(ctx.chat.id, st.message_id, `⏺ Grabando en vivo: ${Math.min(min, Math.floor((Date.now() - t0) / 60000))}/${min} min…`).catch(() => {}), 60000) : null
  try {
    rec = await recordLive(url, min * 60, { maxBytes: sendLimit() - 512 * 1024 })
    const thumb = rec.cover ? await makeThumb(rec.cover, 320).catch(() => null) : null
    await ctx.replyWithAudio(new InputFile(rec.file, rec.name), {
      title: short(rec.info.title, 64), performer: short(rec.info.channel || 'YouTube', 64), duration: rec.seconds,
      ...(thumb ? { thumbnail: new InputFile(thumb, 'cover.jpg') } : {}), caption: `🔴 ${short(rec.info.title, 200)}`
    })
  } catch (e) {
    await ctx.reply('No pude grabar: ' + short(errText(e), 200)).catch(() => {})
  } finally {
    if (tick) clearInterval(tick)
    if (st) ctx.api.deleteMessage(ctx.chat.id, st.message_id).catch(() => {})
    if (rec?.dir) fs.rmSync(rec.dir, { recursive: true, force: true })
    jobs.delete(key)
  }
}

export async function handleEnvivo(ctx) {
  const q = String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim()
  const url = liveTarget(q)
  if (!url) return ctx.reply(`📡 Uso: /envivo <link de YouTube o @canal>\nEjemplos: /envivo @MILENIO · /envivo @LofiGirl\nTe doy el link para verlo en VLC. Agrega minutos para grabar el audio: /envivo @MILENIO 10 (máx. ${MAX_LIVE_MIN}).`)
  const min = Number((q.match(/\s(\d{1,3})\s*(m|min|minutos?)?\s*$/i) || [])[1]) || 0
  const st = await ctx.reply('📡 Buscando el en vivo…').catch(() => null)
  const say = (t) => st ? ctx.api.editMessageText(ctx.chat.id, st.message_id, t).catch(() => ctx.reply(t)) : ctx.reply(t)
  const info = await liveInfo(url)
  if (info.status === 'upcoming') return say(`🗓 Ese en vivo todavía no empieza${info.title ? `: ${info.title}` : ''}. Vuelve a intentarlo cuando comience.`)
  if (info.status === 'ended') return say(`⏹ Ese en vivo ya terminó${info.title ? `: ${info.title}` : ''}. Si quieres el video, usa /play o /ytvideo con el link.`)
  if (info.status === 'notlive') return say(`Ese ${info.title ? 'video' : 'canal'} ${info.title ? `no es un en vivo: ${info.title}` : 'no está transmitiendo en vivo ahora (o el canal no existe).'}`)
  if (info.status !== 'live') return say('No pude revisar el en vivo. ' + (info.reason || ''))
  if (st) ctx.api.deleteMessage(ctx.chat.id, st.message_id).catch(() => {})
  if (min) return grabar(ctx, url, Math.min(min, MAX_LIVE_MIN))
  lastLive.set(String(ctx.chat.id), { url, until: Date.now() + 30 * 60 * 1000 })
  const cap = `🔴 EN VIVO\n📺 ${short(info.title, 300)}${info.channel ? `\n👤 ${info.channel}` : ''}\n\n${vlcSteps()}\n${ipNote(info)}\n\nAbajo te mando los links (cópialos completos).`
  if (info.thumb) await ctx.replyWithPhoto(info.thumb, { caption: short(cap, 1020) }).catch(() => ctx.reply(cap))
  else await ctx.reply(cap)
  const np = { link_preview_options: { is_disabled: true } }
  if (info.master) await ctx.reply(`🎬 Video + audio (VLC):\n${info.master}`, np).catch(() => {})
  if (info.audio) await ctx.reply(`🎧 Solo audio:\n${info.audio}`, np).catch(() => {})
  await ctx.reply('⏺ ¿Grabar el audio en MP3?', { reply_markup: { inline_keyboard: [[5, 10, 15, 30].map(m => ({ text: `⏺ ${m} min`, callback_data: `liv:${m}` }))] } })
}

export function registerEnvivo(bot) {
  bot.callbackQuery(/^liv:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    const l = lastLive.get(String(ctx.chat?.id))
    if (!l || Date.now() > l.until) return ctx.reply('Ya venció (30 min). Pide el en vivo otra vez con /envivo.').catch(() => {})
    grabar(ctx, l.url, Math.min(Number(ctx.match[1]), MAX_LIVE_MIN)).catch(() => {})
  })
}
