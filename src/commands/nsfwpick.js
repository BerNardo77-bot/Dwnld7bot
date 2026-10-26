// /xnxx y /xvideos como en AndrewWife: texto → busca directo en www.xnxx.com / www.xvideos.com (sin API key),
// lista de hasta 10 con miniaturas + botones 1-10 (vale 5 min); enlace → descarga directa.
// Descarga con yt-dlp (URL con www.), mejor calidad que quepa en el tope de envío (1950 MB con servidor local).
import fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveYtDlpBin, errText, isNsfwEnabled, tmpPath, safeUnlink, mb, argText } from '../api.js'
import { setReplay } from '../dl-control.js'

const run = promisify(execFile)
const MAX = 10
const PICK_MS = 5 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const picks = new Map()

const decode = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim()

export function normalizeSiteUrl(u) {
  let s = String(u || '').trim()
  if (/^\/\//.test(s)) s = 'https:' + s
  if (/^(?:[\w-]+\.)?(?:xnxx|xvideos)\d*\.com\//i.test(s)) s = 'https://' + s
  return s.replace(/^http:\/\//i, 'https://')
    .replace(/^https:\/\/(?:m\.|mobile\.)?(xnxx\d*|xvideos\d*)\.com\//i, 'https://www.$1.com/')
    .replace(/\/(?:THUMBNUM|[A-Z][A-Z_]{5,}[A-Z])(?=\/|$)/g, '')
}

export function parseSiteResults(html, site) {
  const host = site === 'xnxx' ? 'https://www.xnxx.com' : 'https://www.xvideos.com'
  const out = []
  const seen = new Set()
  for (const block of String(html || '').split('<div id="video_').slice(1)) {
    const a = block.match(/<a href="(\/video[.-][^"]+)" title="([^"]*)"/)
    if (!a) continue
    const url = normalizeSiteUrl(host + a[1])
    const id = (url.match(/video[.-]([a-z0-9]+)/i) || [])[1] || url
    if (seen.has(id)) continue
    seen.add(id)
    const thumb = ((block.match(/data-src="(https:[^"]+)"/) || [])[1] || '').replace(/THUMBNUM/g, '1')
    const duration = site === 'xvideos'
      ? ((block.match(/<span class="duration">([^<]+)<\/span>/) || [])[1] || '').trim()
      : ((block.match(/<\/span><\/span>\s*([0-9][^<\n]*?(?:min|sec|h))\s*\n/) || [])[1] || '').trim()
    out.push({ title: decode(a[2]) || 'Sin título', duration, url, thumb })
  }
  return out
}

function searchUrl(site, q, page = 0) {
  const e = encodeURIComponent(String(q).trim())
  return site === 'xnxx'
    ? `https://www.xnxx.com/search/${e.replace(/%20/g, '+')}${page ? '/' + page : ''}`
    : `https://www.xvideos.com/?k=${e}${page ? '&p=' + page : ''}`
}

export async function siteSearch(site, q) {
  let all = []
  let lastErr = ''
  for (const page of [0, 1]) {
    try {
      const r = await fetch(searchUrl(site, q, page), { headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' }, signal: AbortSignal.timeout(25000) })
      if (!r.ok) { lastErr = `HTTP ${r.status}`; break }
      const items = parseSiteResults(await r.text(), site)
      for (const it of items) if (!all.some((x) => x.url === it.url)) all.push(it)
      if (all.length >= MAX || !items.length) break
    } catch (e) { lastErr = errText(e); break }
  }
  if (!all.length && lastErr) throw new Error(lastErr)
  return all.slice(0, MAX)
}

// Mejor calidad que quepa en `limit` (estima el peso antes de bajar). Si ninguna cabe, baja la más chica.
async function ytdlpBest(url, limit) {
  const bin = resolveYtDlpBin() || 'yt-dlp'
  let chosen = null
  let info = null
  for (const h of [1080, 720, 480, 360, 240]) {
    const fmt = `b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]`
    try {
      const { stdout } = await run(bin, ['-J', '--no-warnings', '-f', fmt, url], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 })
      info = JSON.parse(stdout)
    } catch (e) {
      const m = errText(e)
      if (/Unsupported|404|not found|removed|private/i.test(m)) throw new Error((m.split('\n').find((l) => /ERROR/.test(l)) || m).slice(0, 200))
      continue
    }
    const parts = info.requested_formats?.length ? info.requested_formats : [info]
    const est = parts.reduce((t, f) => t + Number(f.filesize || f.filesize_approx || 0), 0)
    chosen = { fmt, h, est }
    if (!est || est <= limit) break
  }
  if (!chosen) throw new Error('yt-dlp no pudo leer el video')
  const out = tmpPath(`${Date.now()}-nsfw.mp4`)
  await run(bin, ['--no-warnings', '-f', chosen.fmt, '--merge-output-format', 'mp4', '-o', out, url], { timeout: 45 * 60_000, maxBuffer: 10 * 1024 * 1024 })
  if (!fs.existsSync(out)) throw new Error('yt-dlp no generó el archivo')
  return { file: out, title: info?.title || '', height: info?.height || chosen.h }
}

export function createNsfwPicker({ sendOrCompress, maxSend }) {
  async function descargar(ctx, site, url, title = '') {
    url = normalizeSiteUrl(url)
    const status = await ctx.reply(`Bajando de ${site} en la mejor calidad (tope ${mb(maxSend)} MB)...`)
    let got
    try {
      got = await ytdlpBest(url, maxSend)
    } catch (e) {
      const m = errText(e).slice(0, 300)
      console.error(`[${site}] yt-dlp`, m)
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, `No se pudo bajar el video.\n${m}\n${url}`).catch(() => ctx.reply(m))
    }
    try {
      const size = fs.statSync(got.file).size
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, `Descargado ${got.height ? got.height + 'p · ' : ''}${mb(size)} MB. Enviando...`).catch(() => {})
      await sendOrCompress(ctx, got.file, { kind: 'video', fileName: `${site}.mp4`, caption: `${(title || got.title || site).slice(0, 900)}\n${url}`, statusId: status.message_id, fallbackLink: url })
    } finally {
      safeUnlink(got.file)
    }
  }

  async function listar(ctx, site, q) {
    const status = await ctx.reply(`Buscando en ${site}...`)
    let items = []
    try { items = await siteSearch(site, q) } catch (e) {
      const m = `No pude buscar en ${site}: ${errText(e).slice(0, 150)}`
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, m).catch(() => ctx.reply(m))
    }
    if (!items.length) return ctx.api.editMessageText(ctx.chat.id, status.message_id, `No encontré videos para “${q}”.`).catch(() => {})
    picks.set(String(ctx.chat.id), { site, items, until: Date.now() + PICK_MS })
    ;(globalThis.__lastList || (globalThis.__lastList = new Map())).set(String(ctx.chat?.id), 'other')
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `🔞 ${items.length} resultados en ${site} para “${q}”`).catch(() => {})
    const caps = items.map((v, i) => `${i + 1}. ${v.title}`.slice(0, 300) + (v.duration ? `\n${v.duration}` : '') + `\n${v.url}`)
    const withThumb = items.every((v) => v.thumb)
    try {
      if (!withThumb) throw new Error('sin miniaturas')
      await ctx.replyWithMediaGroup(items.map((v, i) => ({ type: 'photo', media: v.thumb, caption: caps[i] })))
    } catch (e) {
      console.error(`[${site}] álbum`, errText(e))
      await ctx.reply(caps.join('\n\n'), { link_preview_options: { is_disabled: true } }).catch(() => {})
    }
    const rows = [0, 5].filter((s) => s < items.length).map((s) => items.slice(s, s + 5).map((_, j) => ({ text: String(s + j + 1), callback_data: `nsx:${s + j + 1}` })))
    await ctx.reply(`✎ Toca un botón o responde con el número (1-${items.length}) para descargar · vale 5 min`, { reply_markup: { inline_keyboard: rows } }).catch(() => {})
  }

  async function elegir(ctx, n) {
    const k = String(ctx.chat?.id)
    const hit = picks.get(k)
    if (!hit || hit.until < Date.now()) { picks.delete(k); return false }
    if (!Number.isInteger(n) || n < 1 || n > hit.items.length) { await ctx.reply(`Elige un número del 1 al ${hit.items.length}.`); return true }
    picks.delete(k)
    const it = hit.items[n - 1]
    setReplay(`/${hit.site} ${it.url}`) // repetir tras un reinicio
    await descargar(ctx, hit.site, it.url, it.title)
    return true
  }

  function handler(site) {
    return async (ctx) => {
      if (!isNsfwEnabled()) return ctx.reply('NSFW está desactivado (NSFW_ENABLED=false).')
      const q = argText(ctx)
      if (!q) return ctx.reply(`Uso: /${site} <búsqueda o enlace>\nEj: /${site} Sophie Dee`)
      const link = (q.match(/(?:https?:\/\/)?(?:[\w-]+\.)?(?:xnxx|xvideos)\d*\.com\/\S+/i) || [])[0]
      try {
        if (link) return await descargar(ctx, /xnxx/i.test(link) ? 'xnxx' : 'xvideos', link)
        return await listar(ctx, site, q)
      } catch (e) { await ctx.reply(`Error: ${errText(e).slice(0, 200)}`).catch(() => {}) }
    }
  }

  function register(bot) {
    bot.callbackQuery(/^nsx:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {})
      try { if (!(await elegir(ctx, Number(ctx.match[1])))) await ctx.reply('Esa lista ya venció (5 min). Busca otra vez.') } catch (e) { await ctx.reply(`Error: ${errText(e)}`).catch(() => {}) }
    })
    bot.hears(/^\s*(\d{1,2})\s*$/, async (ctx, next) => {
      if (!picks.has(String(ctx.chat?.id))) return next()
      try { if (!(await elegir(ctx, Number(ctx.match[1])))) return next() } catch (e) { await ctx.reply(`Error: ${errText(e)}`).catch(() => {}) }
    })
  }
  return { handler, register, listar, descargar }
}
