// Lista de 10 videos de YouTube (álbum con miniaturas + botones 1-10 / número, 5 min).
// @canal → sus videos más nuevos; "@canal palabras" → busca dentro del canal; texto → búsqueda normal (solo videos).
import { execFile } from 'child_process'
import { promisify } from 'util'
import yts from 'yt-search'
import { resolveYtDlpBin, errText, ytCookiesFile } from '../api.js'

const run = promisify(execFile)
const MAX = 10
const PICK_MS = 5 * 60 * 1000
const picks = new Map()

const fmtDur = (s) => { s = Math.round(Number(s) || 0); if (!s) return ''; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(x).padStart(2, '0') }
const fmtViews = (n) => { n = Number(n) || 0; if (!n) return ''; return (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' mil' : String(n)) + ' vistas' }

export function parseYtQuery(q) {
  const m = String(q).trim().match(/^@([\w.\-]+)\s*(.*)$/)
  return m ? { handle: m[1], words: m[2].trim() } : { handle: '', words: String(q).trim() }
}

async function canal(handle, words) {
  const bin = resolveYtDlpBin() || 'yt-dlp'
  const url = words
    ? `https://www.youtube.com/@${handle}/search?query=${encodeURIComponent(words)}`
    : `https://www.youtube.com/@${handle}/videos`
  const extra = []
  const ck = ytCookiesFile()
  if (ck) extra.push('--cookies', ck)
  const { stdout } = await run(bin, [...extra, '--flat-playlist', '-J', '--playlist-end', String(MAX), '--no-warnings', url], { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 })
  const j = JSON.parse(stdout)
  const chan = j.channel || j.uploader || j.title || '@' + handle
  return (j.entries || [])
    .filter((e) => e && e.id && e.id.length === 11)
    .slice(0, MAX)
    .map((e) => ({ id: e.id, title: e.title || 'Video', seconds: e.duration, channel: e.channel || chan, views: e.view_count }))
}

async function busqueda(words) {
  const r = await yts(words)
  return (r.videos || []).slice(0, MAX).map((v) => ({ id: v.videoId, title: v.title, seconds: v.seconds, channel: v.author?.name || '', views: v.views }))
}

export function createYtPicker({ onPick }) {
  async function listar(ctx, q, { quality = 'hd' } = {}) {
    const { handle, words } = parseYtQuery(q)
    const status = await ctx.reply(handle ? `Buscando en @${handle}...` : 'Buscando videos...')
    let items = []
    try {
      items = handle ? await canal(handle, words) : await busqueda(words)
    } catch (e) {
      const m = errText(e)
      console.error('[ytpick]', m)
      const why = /does not exist|404|not found/i.test(m) ? `No encontré el canal @${handle}.` : `No pude leer los videos (${m.split('\n').find((l) => /ERROR/.test(l)) || m.slice(0, 120)}).`
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, why).catch(() => ctx.reply(why))
    }
    if (!items.length) {
      const t = handle ? `No encontré videos en @${handle}${words ? ` para “${words}”` : ''}.` : `No encontré videos para “${words}”.`
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, t).catch(() => ctx.reply(t))
    }
    picks.set(String(ctx.chat.id), { items, quality, until: Date.now() + PICK_MS })
    const head = handle ? (words ? `@${handle} — ${items.length} videos para “${words}”` : `@${handle} — ${items.length} videos más nuevos`) : `${items.length} videos para “${words}”`
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, '▶️ ' + head).catch(() => {})
    const caps = items.map((v, i) => `${i + 1}. ${v.title}`.slice(0, 300) + `\n${[fmtDur(v.seconds), v.channel, fmtViews(v.views)].filter(Boolean).join(' · ')}`)
    try {
      await ctx.replyWithMediaGroup(items.map((v, i) => ({ type: 'photo', media: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, caption: caps[i] })))
    } catch (e) {
      console.error('[ytpick] álbum', errText(e))
      await ctx.reply(caps.join('\n\n')).catch(() => {})
    }
    const rows = [0, 5].filter((s) => s < items.length).map((s) => items.slice(s, s + 5).map((_, j) => ({ text: String(s + j + 1), callback_data: `ytv:${s + j + 1}` })))
    await ctx.reply(`✎ Toca un botón o responde con el número (1-${items.length}) para descargar · vale 5 min`, { reply_markup: { inline_keyboard: rows } }).catch(() => {})
  }

  async function elegir(ctx, n) {
    const k = String(ctx.chat?.id)
    const hit = picks.get(k)
    if (!hit || hit.until < Date.now()) { picks.delete(k); return false }
    if (!Number.isInteger(n) || n < 1 || n > hit.items.length) { await ctx.reply(`Elige un número del 1 al ${hit.items.length}.`); return true }
    picks.delete(k)
    await onPick(ctx, `https://youtu.be/${hit.items[n - 1].id}`, hit.quality)
    return true
  }

  function register(bot) {
    bot.callbackQuery(/^ytv:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {})
      try { if (!(await elegir(ctx, Number(ctx.match[1])))) await ctx.reply('Esa lista ya venció (5 min). Busca otra vez con /ytvideo.') } catch (e) { await ctx.reply(`Error: ${errText(e)}`).catch(() => {}) }
    })
    bot.hears(/^\s*(\d{1,2})\s*$/, async (ctx, next) => {
      if (!picks.has(String(ctx.chat?.id))) return next()
      try { if (!(await elegir(ctx, Number(ctx.match[1])))) return next() } catch (e) { await ctx.reply(`Error: ${errText(e)}`).catch(() => {}) }
    })
  }
  return { listar, register }
}
