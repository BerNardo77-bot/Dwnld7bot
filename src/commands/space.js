// /space <link de x.com/i/spaces/…> → MP3 de la grabación (en partes si pasa el límite de envío)
import fs from 'fs'
import { InputFile } from 'grammy'
import { spaceUrl, spaceInfo, downloadSpace, hms, SEARCH_MSG } from '../space-core.js'
import { makeThumb } from '../audio-tags.js'
import { errText, sendLimit } from '../api.js'

export const SPACE_COMMANDS = ['space', 'spaces', 'xspace']
const jobs = new Set()
const short = (s = '', n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

export async function handleSpace(ctx) {
  const q = String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim()
  if (!q) return ctx.reply('🎙 Uso: /space <link del Space de X>\nEjemplo: /space https://x.com/i/spaces/1nxeLMRVZVLJX\nTe mando la grabación en MP3.')
  const url = spaceUrl(q)
  if (!url) return ctx.reply(SEARCH_MSG('/').replace(/\*/g, ''))
  const key = String(ctx.chat.id)
  if (jobs.has(key)) return ctx.reply('Ya estoy bajando un Space en este chat. Espera a que termine.')
  jobs.add(key)
  const status = await ctx.reply('🎙 Revisando el Space…').catch(() => null)
  const say = (t) => status ? ctx.api.editMessageText(ctx.chat.id, status.message_id, t, { link_preview_options: { is_disabled: true } }).catch(() => {}) : ctx.reply(t).catch(() => {})
  let res = null
  try {
    const info = await spaceInfo(url)
    if (info.status === 'live') return say(`🔴 Ese Space está en vivo ahora. Solo se puede escuchar en la app de X:\n${url}\nCuando termine, si el anfitrión lo grabó, mándamelo otra vez.`)
    if (info.status === 'upcoming') return say(`🗓 Ese Space todavía no empieza. Cuando termine (si lo graban) mándamelo otra vez:\n${url}`)
    if (info.status !== 'recorded') return say(`${info.reason || 'Ese Space no tiene grabación disponible.'}\n${url}`)
    const head = `🎙 ${short(info.title, 150)}${info.host ? `\n👤 ${info.host}${info.hostId ? ` (@${info.hostId})` : ''}` : ''}`
    await say(`${head}\n⬇️ Bajando la grabación… si dura horas puede tardar varios minutos.`)
    let lastT = 0
    res = await downloadSpace(info, {
      maxBytes: Math.max(10 * 1024 * 1024, sendLimit() - 1024 * 1024),
      onProgress: (t) => { if (Date.now() - lastT > 15000 || /MP3/.test(t)) { lastT = Date.now(); say(`${head}\n${t}`) } }
    })
    console.log(`[space] ${info.title} ${Math.round(res.duration)}s ${res.parts.length} parte(s)`)
    await say(`${head}\n✅ ${hms(res.duration)}${res.parts.length > 1 ? ` · te lo mando en ${res.parts.length} partes` : ''}. Enviando…`)
    const thumb = res.cover ? await makeThumb(res.cover, 320).catch(() => null) : null
    for (const [i, p] of res.parts.entries()) {
      await ctx.replyWithAudio(new InputFile(p.file, p.name), {
        title: short(res.parts.length > 1 ? `${info.title} (${i + 1}/${res.parts.length})` : info.title, 64),
        performer: short(info.host || info.hostId || 'X Space', 64), duration: p.seconds,
        ...(thumb ? { thumbnail: new InputFile(thumb, 'cover.jpg') } : {}),
        caption: `🎙 ${short(info.title, 200)} · ${hms(p.seconds)}`
      })
      await new Promise(r => setTimeout(r, 1500))
    }
  } catch (e) {
    console.error('[space]', errText(e))
    await say('No pude bajar el Space: ' + short(errText(e), 250))
  } finally {
    if (res?.dir) fs.rmSync(res.dir, { recursive: true, force: true })
    jobs.delete(key)
  }
}
