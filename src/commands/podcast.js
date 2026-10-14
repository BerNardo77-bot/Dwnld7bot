// /podcast /pod /antennapod: búsqueda (iTunes MX), feed RSS, enlace de AntennaPod o enlace directo.
// Portado de Luffy7 (WhatsApp) cmds/dl/podcast.js v1.1.58. Siempre directo (sin proxy).
import fs from 'fs'
import { InputFile } from 'grammy'
import { downloadToFile, tmpPath, safeUnlink, mb, errText } from '../api.js'

const MAX_EP = 10
const PICK_MS = 5 * 60 * 1000
const UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 AntennaPod-compatible'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim()
const tag = (xml, name) => decode((String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')) || [])[1] || '')
const attr = (xml, name, a) => ((String(xml).match(new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]+)"`, 'i')) || [])[1] || '').replace(/&amp;/g, '&')

function durText(d) {
  const s = String(d || '').trim()
  if (!s) return ''
  if (/^\d+$/.test(s)) { const n = Number(s); const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = n % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}` }
  return s
}
function fecha(d) {
  const t = Date.parse(d)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}

// Enlaces de AntennaPod: antennapod.org/deeplink/subscribe?url=<feed>[&eUrl=<episodio>] (también eurl/episode)
export function parseAntennaPod(link) {
  try {
    const u = new URL(link)
    if (!/antennapod\.org$/i.test(u.hostname)) return null
    const g = (k) => { for (const [kk, v] of u.searchParams) if (kk.toLowerCase() === k) return v; return '' }
    return { feed: g('url') || g('feed'), episode: g('eurl') || g('episode') || g('eurlx'), title: g('title') }
  } catch { return null }
}

export function parseFeed(xml) {
  const show = tag(String(xml).split(/<item[\s>]/i)[0], 'title') || 'Podcast'
  const art = attr(xml, 'itunes:image', 'href') || tag((String(xml).match(/<image>[\s\S]*?<\/image>/i) || [''])[0], 'url')
  const items = []
  for (const it of String(xml).split(/<item[\s>]/i).slice(1)) {
    const url = attr(it, 'enclosure', 'url')
    if (!url) continue
    items.push({
      title: tag(it, 'title') || 'Episodio',
      url,
      type: attr(it, 'enclosure', 'type') || '',
      length: Number(attr(it, 'enclosure', 'length')) || 0,
      date: tag(it, 'pubDate'),
      duration: durText(tag(it, 'itunes:duration')),
      thumb: attr(it, 'itunes:image', 'href') || art,
      desc: (tag(it, 'itunes:summary') || tag(it, 'description')).replace(/<[^>]+>/g, ' ').slice(0, 1500),
      show
    })
  }
  items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
  return { show, art, items }
}

async function getText(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000),
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' } })
  if (res.status >= 400) throw new Error(`el servidor respondió ${res.status}`)
  return { text: await res.text(), type: res.headers.get('content-type') || '' }
}

async function itunesJson(params) {
  const r = await fetch(`https://itunes.apple.com/search?country=MX&${params}`, { signal: AbortSignal.timeout(20000) })
  if (r.status >= 400) throw new Error(`iTunes respondió ${r.status}`)
  return JSON.parse(await r.text())
}
async function itunesSearch(q) {
  const j = await itunesJson(`media=podcast&limit=5&term=${encodeURIComponent(q)}`)
  return (j.results || []).filter((r) => r.feedUrl)
}
// Episodios por nombre en todo iTunes (entity=podcastEpisode)
export async function itunesEpisodes(q, limit = 25) {
  const j = await itunesJson(`media=podcast&entity=podcastEpisode&limit=${limit}&term=${encodeURIComponent(q)}`)
  return (j.results || []).filter((r) => r.episodeUrl).map((r) => ({
    title: String(r.trackName || 'Episodio'),
    url: r.episodeUrl,
    type: r.episodeContentType && r.episodeFileExtension ? `${r.episodeContentType}/${r.episodeFileExtension === 'mp3' ? 'mpeg' : r.episodeFileExtension}` : '',
    length: 0,
    date: r.releaseDate || '',
    duration: r.trackTimeMillis ? durText(String(Math.round(r.trackTimeMillis / 1000))) : '',
    thumb: r.artworkUrl600 || r.artworkUrl160 || '',
    show: String(r.collectionName || '')
  }))
}

// Sin acentos ni mayúsculas; palabras de 2+ letras (o números)
export const normTxt = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim()
const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'en', 'con', 'del', 'a', 'un', 'una', 'the', 'podcast'])
export const qWords = (q) => normTxt(q).replace(/#/g, '').split(' ').filter((w) => w && (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
const fracIn = (text, words) => { const t = ' ' + normTxt(text).replace(/#/g, ' ') + ' '; return words.length ? words.filter((w) => t.includes(' ' + w + ' ') || t.includes(w)).length / words.length : 0 }

// Episodios cuyo título (o título + programa) trae las palabras; todos los del feed, mejores primero
// Orden por niveles (todos los episodios del feed): 1) frase exacta en el título,
// 2) todas las palabras en título(+programa), 3) parte de las palabras en el título,
// 4) palabras en la descripción. Mejores primero; los más nuevos desempatan.
export function rankEpisodes(items, q, max = MAX_EP, minTier = 1) {
  const words = qWords(q)
  if (!words.length) return []
  const phrase = normTxt(q).replace(/#/g, ' ').replace(/\s+/g, ' ').trim()
  const scored = []
  items.forEach((it, i) => {
    const t = normTxt(it.title).replace(/#/g, ' ').replace(/\s+/g, ' ')
    const sT = fracIn(it.title, words)
    const sTS = fracIn(`${it.title} ${it.show}`, words)
    const sD = fracIn(`${it.title} ${it.show} ${it.desc || ''}`, words)
    let tier = 0
    if (phrase && t.includes(phrase)) tier = 5
    else if (sTS >= 1) tier = 4
    else if (sT >= 0.5) tier = 3
    else if (sD >= 1) tier = 2
    else if (sD >= 0.6 && sT > 0) tier = 1
    if (tier && tier >= minTier) scored.push({ it, i, tier, s: sT + sD })
  })
  scored.sort((a, b) => b.tier - a.tier || b.s - a.s || a.i - b.i)
  return scored.slice(0, max).map((x) => x.it)
}
export const matchEpisodes = rankEpisodes

const epKey = (it) => String(it.url || '').split('?')[0] || normTxt(it.title)
export function dedupeEps(list) {
  const seen = new Set()
  return list.filter((it) => { const k = epKey(it); const k2 = normTxt(`${it.show} ${it.title}`); if (seen.has(k) || seen.has(k2)) return false; seen.add(k); seen.add(k2); return true })
}

// Hasta 10, en este orden: 1) coincidencias en títulos del programa, 2) sus episodios más
// nuevos, 3) otras coincidencias (descripción, y episodios de iTunes de otros programas). Sin duplicados.
export function fillEpisodes({ feed, q, itunesEps = [] }) {
  const items = feed?.items || []
  const titulo = rankEpisodes(items, q, MAX_EP, 3)
  const otros = rankEpisodes(items, q, MAX_EP, 1)
  return dedupeEps([...titulo, ...items.slice(0, MAX_EP), ...otros, ...itunesEps]).slice(0, MAX_EP)
}
async function buscarEpisodios({ feed, q, itunesQs }) {
  const items = feed?.items || []
  // iTunes solo si el feed no llena los 10
  const itunesEps = []
  if (dedupeEps([...rankEpisodes(items, q), ...items.slice(0, MAX_EP)]).length < MAX_EP || !rankEpisodes(items, q).length) {
    for (const iq of itunesQs) {
      try {
        const eps = await itunesEpisodes(iq, 50)
        itunesEps.push(...rankEpisodes(eps, iq, 50), ...eps.slice(0, MAX_EP))
      } catch (e) { console.error('[podcast] episodios', e?.message || e) }
      if (itunesEps.length >= MAX_EP) break
    }
  }
  // Sin ninguna coincidencia en el feed, no rellenar con sus nuevos (la búsqueda no era de este programa)
  if (feed && !rankEpisodes(items, q).length) return dedupeEps([...rankEpisodes(itunesEps, q, 50), ...itunesEps]).slice(0, MAX_EP)
  return fillEpisodes({ feed, q, itunesEps })
}

export const showScore = (name, q) => fracIn(name, qWords(q))

async function leerFeed(feedUrl) {
  const { text } = await getText(feedUrl)
  if (!/<rss|<feed|<channel/i.test(text)) throw new Error('el enlace no es un feed RSS de podcast')
  return parseFeed(text)
}

const isMediaUrl = (u) => /\.(mp3|m4a|aac|ogg|opus|wav|mp4|m4v|mov|webm)(\?|$)/i.test(u)

// Selección pendiente por chat: { items, from, until }
const picks = new Map()
const pickKey = (ctx) => String(ctx.chat?.id)

async function bajarThumb(url) {
  if (!url) return null
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA } })
    if (!r.ok || !/image/.test(r.headers.get('content-type') || '')) return null
    const buf = Buffer.from(await r.arrayBuffer())
    return buf.length > 0 && buf.length < 5 * 1024 * 1024 ? buf : null
  } catch { return null }
}

function caption(it, i) {
  const meta = [fecha(it.date), it.duration, it.length ? mb(it.length) + ' MB' : ''].filter(Boolean).join(' · ')
  return `${i + 1}. ${it.title.slice(0, 300)}${it.show ? `\n🎙️ ${it.show.slice(0, 80)}` : ''}${meta ? `\n${meta}` : ''}`.slice(0, 1024)
}

// Álbum de fotos con pie por resultado (1 mensaje); si falla, foto por foto; si no, texto.
async function enviarLista(ctx, titulo, items, art) {
  items = items.slice(0, MAX_EP)
  if (!items.length) return
  picks.set(pickKey(ctx), { items, until: Date.now() + PICK_MS })
  await ctx.reply(`🎙️ ${titulo}`).catch(() => {})
  const cache = new Map()
  const media = []
  for (let i = 0; i < items.length; i++) {
    const src = items[i].thumb || art
    if (src && !cache.has(src)) cache.set(src, await bajarThumb(src))
    const buf = src ? cache.get(src) : null
    media.push({ buf, cap: caption(items[i], i) })
  }
  let ok = false
  if (media.every((m) => m.buf)) {
    try {
      await ctx.replyWithMediaGroup(media.map((m, i) => ({ type: 'photo', media: new InputFile(m.buf, `p${i}.jpg`), caption: m.cap })))
      ok = true
    } catch (e) { console.error('[podcast] álbum', errText(e)) }
  }
  if (!ok) {
    for (const m of media) {
      try {
        if (m.buf) await ctx.replyWithPhoto(new InputFile(m.buf, 'p.jpg'), { caption: m.cap })
        else await ctx.reply(m.cap)
      } catch (e) { await ctx.reply(m.cap).catch(() => {}) }
      await sleep(400)
    }
  }
  const rows = []
  for (let i = 0; i < items.length; i += 5) rows.push(items.slice(i, i + 5).map((_, j) => ({ text: String(i + j + 1), callback_data: `pod:${i + j + 1}` })))
  await ctx.reply(`✎ Toca un botón o responde con el número (1-${items.length}) para descargar · vale 5 min`, { reply_markup: { inline_keyboard: rows } }).catch(() => {})
}

async function listarEpisodios(ctx, feedUrl, filtro = '') {
  let feed
  try { feed = await leerFeed(feedUrl) } catch (e) {
    return ctx.reply(`No pude leer el feed del podcast: ${e?.message || e}.\n${feedUrl}`)
  }
  if (!feed.items.length) return ctx.reply(`"${feed.show}" no tiene episodios para descargar en su feed.`)
  if (filtro) {
    const hits = await buscarEpisodios({ feed, q: filtro, itunesQs: [`${filtro} ${feed.show}`, filtro] })
    if (!hits.length) return false
    return enviarLista(ctx, `${feed.show} — ${hits.length} episodio${hits.length === 1 ? '' : 's'} para “${filtro}” (busqué en sus ${feed.items.length} episodios${hits.some((h) => h.show !== feed.show) ? ' y en otros podcasts' : ''})`, hits, feed.art)
  }
  return enviarLista(ctx, `${feed.show} — ${Math.min(MAX_EP, feed.items.length)} episodios más nuevos`, feed.items, feed.art)
}

async function porEpisodio(ctx, q) {
  const hits = await buscarEpisodios({ feed: null, q, itunesQs: [q] })
  if (!hits.length) return false
  await enviarLista(ctx, `${hits.length} episodios para “${q}”`, hits)
  return true
}

export function createPodcastHandlers({ maxSend }) {
  const linkMsg = (item, why) => `${why}\nEscúchalo o descárgalo aquí:\n${item.url}`

  async function descargar(ctx, item) {
    if (item.length && item.length > maxSend) {
      return ctx.reply(linkMsg(item, `Ese episodio pesa ~${mb(item.length)} MB y Telegram solo me deja mandar hasta ${mb(maxSend)} MB.`))
    }
    const status = await ctx.reply(`⏳ Bajando: ${item.title.slice(0, 150)}${item.length ? ` (~${mb(item.length)} MB)` : ''}…`).catch(() => null)
    const ext = (item.url.match(/\.(mp3|m4a|aac|ogg|opus|wav|mp4|m4v|mov|webm)(\?|$)/i) || [])[1]?.toLowerCase() || (/video/.test(item.type) ? 'mp4' : 'mp3')
    const file = tmpPath(`pod_${Date.now()}.${ext}`)
    try {
      try {
        await downloadToFile(item.url, file, { timeout: 1_800_000, maxBytes: maxSend, headers: { 'User-Agent': UA } })
      } catch (e) {
        const m = errText(e)
        if (/supera|tope/i.test(m)) return ctx.reply(linkMsg(item, `Ese episodio pesa más de ${mb(maxSend)} MB, el máximo que Telegram me deja mandar.`))
        return ctx.reply(linkMsg(item, `No pude bajar el episodio (${m.slice(0, 150)}).`))
      }
      const size = fs.statSync(file).size
      if (size > maxSend) return ctx.reply(linkMsg(item, `Ese episodio pesa ${mb(size)} MB y Telegram solo me deja mandar hasta ${mb(maxSend)} MB.`))
      const name = `${item.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 90) || 'episodio'}.${ext}`
      const cap = `🎙️ ${item.show ? item.show + ' — ' : ''}${item.title}`.slice(0, 1000) + `\n${mb(size)} MB`
      const isVideo = /video/.test(item.type) || /^(mp4|m4v|mov|webm)$/.test(ext)
      const thumbBuf = await bajarThumb(item.thumb)
      const thumbnail = thumbBuf && thumbBuf.length < 200 * 1024 ? new InputFile(thumbBuf, 'thumb.jpg') : undefined
      try {
        if (isVideo) await ctx.replyWithVideo(new InputFile(file, name), { caption: cap, supports_streaming: true, thumbnail })
        else await ctx.replyWithAudio(new InputFile(file, name), { caption: cap, title: item.title.slice(0, 64), performer: (item.show || 'Podcast').slice(0, 64), thumbnail })
      } catch (e) {
        console.error('[podcast] envío', errText(e))
        try {
          await ctx.replyWithDocument(new InputFile(file, name), { caption: cap })
        } catch (e2) {
          await ctx.reply(linkMsg(item, `Lo bajé (${mb(size)} MB) pero Telegram no lo aceptó.`)).catch(() => {})
        }
      }
      if (status) ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
    } finally {
      safeUnlink(file)
    }
  }

  async function elegir(ctx, n) {
    const hit = picks.get(pickKey(ctx))
    if (!hit || hit.until < Date.now()) { picks.delete(pickKey(ctx)); return false }
    if (!Number.isInteger(n) || n < 1 || n > hit.items.length) { await ctx.reply(`Elige un número del 1 al ${hit.items.length}.`); return true }
    picks.delete(pickKey(ctx))
    await descargar(ctx, hit.items[n - 1])
    return true
  }

  async function handlePodcast(ctx) {
    try {
      const q = String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim()
      if (!q) {
        return ctx.reply(
          '🎙️ Podcasts\n' +
          '• /pod <programa> — sus 10 episodios más nuevos\n   Ej: /pod Cracks Oso Trava\n' +
          '• /pod <programa> | <episodio> — busca en TODOS sus episodios\n   Ej: /pod Cracks Oso Trava | Carlos Slim\n' +
          '• /pod <palabras del episodio> — lo busca por nombre en todos los podcasts\n' +
          '• /pod <enlace RSS o de AntennaPod> — lista los episodios\n' +
          '• /pod <enlace .mp3/.mp4> — lo descarga directo\n' +
          `Luego toca el botón o responde con el número (1-10). Hasta ${mb(maxSend)} MB, calidad original.`
        )
      }
      const link = (q.match(/https?:\/\/\S+/) || [])[0]
      if (link) {
        const ap = parseAntennaPod(link)
        if (ap) {
          if (ap.episode) return descargar(ctx, { title: ap.title || 'Episodio', url: ap.episode, type: '', length: 0, show: '' })
          if (ap.feed) return listarEpisodios(ctx, ap.feed)
          return ctx.reply('Ese enlace de AntennaPod no trae la dirección del feed.')
        }
        if (isMediaUrl(link)) return descargar(ctx, { title: decodeURIComponent(link.split('/').pop().split('?')[0]).replace(/\.\w+$/, '') || 'Episodio', url: link, type: '', length: 0, show: '' })
        return listarEpisodios(ctx, link)
      }
      await ctx.replyWithChatAction('typing').catch(() => {})
      const [showQ, epQ] = q.includes('|') ? q.split('|').map((x) => x.trim()) : [q, '']
      let res = []
      try { res = await itunesSearch(showQ) } catch (e) { console.error('[podcast] itunes', errText(e)) }
      if (epQ) {
        if (res[0]) {
          const r = await listarEpisodios(ctx, res[0].feedUrl, epQ)
          if (r !== false) return
        }
        if (await porEpisodio(ctx, `${epQ} ${showQ}`)) return
        if (await porEpisodio(ctx, epQ)) return
        return ctx.reply(`No encontré el episodio "${epQ}"${res[0] ? ` en "${res[0].collectionName}"` : ''}. Prueba con otras palabras del título.`)
      }
      const top = res[0]
      if (top && showScore(`${top.collectionName} ${top.artistName}`, q) >= 0.75) {
        if (res.length > 1) await ctx.reply(`🔎 Encontré "${top.collectionName}" (${top.artistName}).\nOtros: ${res.slice(1, 4).map((r) => r.collectionName).join(' · ')}\n✎ ¿Buscas un episodio? /pod ${top.collectionName.slice(0, 30)} | <palabras del episodio>`).catch(() => {})
        return listarEpisodios(ctx, top.feedUrl)
      }
      if (top) {
        try {
          const feed = await leerFeed(top.feedUrl)
          const hits = await buscarEpisodios({ feed, q, itunesQs: [q] })
          if (hits.length) return enviarLista(ctx, `${hits.length} episodios para “${q}” (primero de ${feed.show})`, hits, feed.art)
        } catch (e) { console.error('[podcast] feed', errText(e)) }
      }
      if (await porEpisodio(ctx, q)) return
      if (top) return listarEpisodios(ctx, top.feedUrl)
      return ctx.reply(`No encontré podcasts ni episodios para "${q}". Prueba con otro nombre o manda el enlace RSS.`)
    } catch (e) {
      console.error('[podcast]', e)
      await ctx.reply(`Error en /podcast: ${errText(e)}`).catch(() => {})
    }
  }

  // Registra comandos, botones y respuesta con número (llamar antes de otros hears de texto)
  function register(bot) {
    bot.command(['podcast', 'pod', 'antennapod'], handlePodcast)
    bot.callbackQuery(/^pod:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {})
      try {
        if (!(await elegir(ctx, Number(ctx.match[1])))) await ctx.reply('Esa lista ya venció (5 min). Busca otra vez con /pod.')
      } catch (e) { await ctx.reply(`Error: ${errText(e)}`).catch(() => {}) }
    })
    bot.hears(/^\s*(\d{1,2})\s*$/, async (ctx, next) => {
      if (!picks.has(pickKey(ctx))) return next()
      try { if (!(await elegir(ctx, Number(ctx.match[1])))) return next() } catch (e) { await ctx.reply(`Error: ${errText(e)}`).catch(() => {}) }
    })
  }
  return { handlePodcast, register }
}
export const PODCAST_COMMANDS = ['podcast', 'pod', 'antennapod']
