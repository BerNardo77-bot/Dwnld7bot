// Música (port de Luffy7 WhatsApp): /apple, páginas de música desde /google, listas numeradas largas
// y audio = MP3 real verificado (192k CBR, ID3v2.3, portada) enviado con sendAudio (nombre + portada + reproducible).
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import yts from 'yt-search'
import { InputFile } from 'grammy'
import { musicKind, resolveTrack, resolveAlbum, searchQuery, searchItunes, pageMusicQuery, strongAlbum, betterTitle } from '../music-page.js'
import { youtubeCover, prepareAudio, fetchCover, makeThumb, probeAudio, haveFfmpeg } from '../audio-tags.js'
import { resolveYoutube, getAudioLink, downloadToFile, tmpPath, safeUnlink, errText, resolveYtDlpBin, ytCookiesFile, extractYoutubeId, sendLimit } from '../api.js'

const run = promisify(execFile)
const PICK_MS = 5 * 60 * 1000
const lists = new Map() // chat → { kind:'album'|'google', items, until }
// Lista más reciente por chat (la comparten los otros pickers: ytv, nsfw, podcast)
export const lastList = globalThis.__lastList || (globalThis.__lastList = new Map())
export const markList = (chatId, kind) => lastList.set(String(chatId), kind)

const normTxt = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const cleanName = (x) => String(x).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
const short = (s = '', n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

async function ytdlpAudio(url) {
  const bin = resolveYtDlpBin() || 'yt-dlp'
  const base = tmpPath(`${Date.now()}-ya`)
  const extra = []
  const ck = ytCookiesFile()
  if (ck) extra.push('--cookies', ck)
  try {
    await run(bin, [...extra, '-f', 'bestaudio[ext=m4a]/bestaudio/best', '--no-playlist', '-q', '--no-warnings', '-o', base + '.%(ext)s', url], { timeout: 600000, maxBuffer: 10 * 1024 * 1024 })
    const dir = path.dirname(base), pre = path.basename(base)
    const f = fs.readdirSync(dir).find(x => x.startsWith(pre + '.'))
    if (!f) return null
    const b = fs.readFileSync(path.join(dir, f))
    safeUnlink(path.join(dir, f))
    return b
  } catch (e) {
    console.error('[music] yt-dlp', errText(e).slice(0, 200))
    return null
  }
}

/**
 * Baja el audio (API → si falla o viene roto, yt-dlp), lo convierte a MP3 verificado con portada/etiquetas
 * y lo manda con sendAudio (título, intérprete, miniatura, nombre "Artista - Título.mp3").
 */
export async function playAudio(ctx, { query = '', url = '', meta = null, quiet = false } = {}) {
  const status = quiet ? null : await ctx.reply('🎵 Buscando audio...').catch(() => null)
  const say = (t) => quiet ? (console.error('[music] (todas)', String(t).slice(0, 150)), false) : status ? ctx.api.editMessageText(ctx.chat.id, status.message_id, t).catch(() => {}) : ctx.reply(t).catch(() => {})
  const out = tmpPath(`${Date.now()}-api-audio`)
  try {
    const video = await resolveYoutube(url || query)
    if (!video) return say('No encontré el audio en YouTube.')
    await say(`🎵 ${meta?.title ? `${meta.artist ? meta.artist + ' - ' : ''}${meta.title}` : video.title}\nBajando audio...`)
    let buf = null, apiErr = ''
    try {
      const got = await getAudioLink(video.url, video.title)
      if (got?.dl) { await downloadToFile(got.dl, out); buf = fs.readFileSync(out) } else apiErr = got?.error || 'sin enlace'
    } catch (e) { apiErr = errText(e) }
    apiErr = String(apiErr).replace(/key=[^&\s]+/gi, 'key=***')
    let src = buf?.length >= 50 * 1024 ? await probeAudio(buf) : null
    const ff = await haveFfmpeg()
    if (!buf?.length || buf.length < 50 * 1024 || (src && !(src.duration > 5)) || (!src && ff)) {
      console.error('[music] audio de la API inválido', apiErr, buf?.length || 0)
      const alt = await ytdlpAudio(video.url)
      const ap = alt ? await probeAudio(alt) : null
      if (alt && (ap ? ap.duration > 5 : !ff)) { buf = alt; src = ap }
      else return say(`No pude bajar el audio.${apiErr ? `\n${apiErr.slice(0, 200)}` : ''}`)
    }
    if (src) console.log(`[music] fuente: ${src.codec} ${Math.round(src.duration)}s ${Math.round(src.bitrate / 1000)}kbps ${(buf.length / 1048576).toFixed(1)} MB`)
    const title = meta?.title ? betterTitle(meta.title, video.title, meta.artist) : video.title
    if (meta?.title && title !== meta.title) console.log(`[titulo] "${meta.title}" → "${title}"`)
    const artist = meta?.artist || video.author?.name || ''
    const coverBuf = (await youtubeCover(video.videoId || extractYoutubeId(video.url))) || (meta?.cover && await fetchCover(meta.cover)) || await fetchCover(video.thumbnail || video.image || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`)
    const prep = await prepareAudio(buf, { title, artist, album: meta?.album || '', cover: coverBuf })
    const fin = await probeAudio(prep.buffer)
    console.log(`[music] enviando: ${prep.ext} codec=${fin?.codec || '?'} ${fin ? Math.round(fin.duration) + 's' : ''} ${(prep.buffer.length / 1048576).toFixed(1)} MB ${prep.tagged ? 'con portada' : 'sin portada'}`)
    if (prep.buffer.length > sendLimit()) return say(`El audio pesa ${(prep.buffer.length / 1048576).toFixed(1)} MB y supera el límite de envío.\n${video.url}`)
    const name = (cleanName(artist ? `${artist} - ${title}` : title).slice(0, 100) || 'audio') + '.' + prep.ext
    const thumb = coverBuf ? await makeThumb(coverBuf, 320).catch(() => null) : null
    await ctx.replyWithAudio(new InputFile(prep.buffer, name), {
      title: short(title, 64), performer: short(artist, 64),
      ...(fin?.duration ? { duration: Math.round(fin.duration) } : {}),
      ...(thumb ? { thumbnail: new InputFile(thumb, 'cover.jpg') } : {}),
      caption: meta?.album ? `💿 ${meta.album}` : undefined
    })
    if (status) await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
    return true
  } catch (e) {
    console.error('[music]', e)
    await say('Error: ' + errText(e))
    return false
  } finally {
    safeUnlink(out)
  }
}

// Manda texto largo partido (≤60 líneas y <4000 caracteres por mensaje); botones en el último
async function sendLong(ctx, head, lines, foot, extra = {}) {
  const parts = []
  let cur = [], len = head.length
  for (const l of lines) {
    if (cur.length >= 60 || len + l.length + 1 > 3800) { parts.push(cur); cur = []; len = 0 }
    cur.push(l); len += l.length + 1
  }
  parts.push(cur)
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    await ctx.reply((i === 0 ? head : '') + parts[i].join('\n') + (last ? foot : ''), last ? extra : {}).catch((e) => console.error('[music] lista', errText(e)))
  }
}
const buttons = (n, prefix, withAll = false) => {
  const rows = []
  const max = Math.min(n, 20)
  for (let s = 0; s < max; s += 5) rows.push(Array.from({ length: Math.min(5, max - s) }, (_, j) => ({ text: String(s + j + 1), callback_data: `${prefix}:${s + j + 1}` })))
  if (withAll) rows.push([{ text: '⬇️ Todas', callback_data: `${prefix}:all` }])
  return rows.length ? { reply_markup: { inline_keyboard: rows } } : {}
}

async function showAlbum(ctx, al, image) {
  const items = al.tracks.map(t => ({ ...t, album: al.album || '', image: t.image || al.image || image || '' }))
  lists.set(String(ctx.chat.id), { kind: 'album', items, until: Date.now() + PICK_MS })
  markList(ctx.chat.id, 'music')
  const cover = al.image || image
  if (cover) await ctx.replyWithPhoto(cover, { caption: `💿 ${al.album || 'Álbum'}${al.artist ? `\n👤 ${al.artist}` : ''}\n${items.length} canciones` }).catch(() => {})
  const lines = items.map((t, i) => `${i + 1}. ${t.title}${t.artist && t.artist !== al.artist ? ` — ${t.artist}` : ''}`)
  const head = cover ? '' : `💿 ${al.album || 'Álbum'}${al.artist ? `\n👤 ${al.artist}` : ''}\n\n`
  await sendLong(ctx, head, lines, `\n\n✎ Toca un botón o responde con el número (1-${items.length}) y te mando el audio, o responde todas (botón ⬇️ Todas) para bajar el álbum completo · vale 5 min${al.fromYt ? '\n(lista sacada de YouTube)' : ''}`, buttons(items.length, 'mus', true))
}

/** Página de música (canción → audio; álbum → lista). true si era de música. */
export async function musicFromUrl(ctx, url) {
  const mk = musicKind(url)
  if (!mk || (mk.kind !== 'track' && mk.kind !== 'album')) return false
  if (mk.kind === 'track') {
    if (mk.svc === 'ytmusic') { await playAudio(ctx, { url: `https://youtu.be/${mk.id}` }); return true }
    const t = await resolveTrack(url, mk)
    const q = t ? searchQuery(t) : ''
    if (!q) { await ctx.reply(`No pude saber qué canción es.\n${url}`); return true }
    await playAudio(ctx, { query: q, meta: { title: t.title, artist: t.artist, album: t.album || '', cover: t.image || '' } })
    return true
  }
  const al = await resolveAlbum(url, mk)
  if (!al?.tracks?.length) { await ctx.reply(`No pude leer las canciones de ese álbum.\n${url}`); return true }
  await showAlbum(ctx, al)
  return true
}

/** Búsqueda en Apple Music (iTunes + álbumes recientes del artista). strict: solo si de verdad parece música. */
export async function searchMusic(ctx, q, { strict = false } = {}) {
  let items = (await searchItunes(q)).slice(0, 12)
  if (!items.length && q.split(' ').length > 3) items = (await searchItunes(q.split(' ').slice(0, 4).join(' '))).slice(0, 12)
  const strong = strongAlbum(items, q)
  if (strong) return musicFromUrl(ctx, strong.albumUrl)
  const nq = ' ' + normTxt(q) + ' '
  const hasArtist = (t) => !!normTxt(t.artist) && nq.includes(' ' + normTxt(t.artist).split(' & ')[0] + ' ')
  items = [...items.filter(hasArtist), ...items.filter(t => !hasArtist(t))]
  if (strict) items = items.filter(hasArtist)
  if (!items.length) {
    if (strict) return false
    await ctx.reply(`No encontré nada en Apple Music para: ${q}`)
    return true
  }
  lists.set(String(ctx.chat.id), { kind: 'album', items, until: Date.now() + PICK_MS })
  markList(ctx.chat.id, 'music')
  if (items[0]?.image) await ctx.replyWithPhoto(items[0].image, { caption: `🍎 Apple Music: ${short(q, 150)}` }).catch(() => {})
  const lines = items.map((t, i) => `${i + 1}. ${t.type === 'album' ? '💿' : '🎵'} ${t.title} — ${t.artist}`)
  await sendLong(ctx, items[0]?.image ? '' : `🍎 Apple Music: ${short(q, 150)}\n\n`, lines, `\n\n✎ Toca un botón o responde con el número (vale 5 min): 🎵 audio, 💿 canciones del álbum; todas (⬇️) baja todas las 🎵.`, buttons(items.length, 'mus', items.some(t => !t.albumUrl)))
  return true
}

export async function handleApple(ctx) {
  const q = String(ctx.match ?? '').trim() || String(ctx.message?.text || '').replace(/^\S+\s*/, '').trim()
  if (!q) return ctx.reply('Uso: /apple <link de Apple Music o nombre>\nEjemplo: /apple https://music.apple.com/…/album/…\nEjemplo: /apple Dei V Flavorz Pack\n\nTambién: /applemusic · /am')
  try {
    const url = (q.match(/https?:\/\/\S+/) || [])[0]
    if (url) {
      if (await musicFromUrl(ctx, url)) return
      if (musicKind(url)) return ctx.reply(`Ese link no es una canción ni un álbum.\n${url}`)
      const pq = await pageMusicQuery(url)
      if (!pq) return ctx.reply(`No pude saber qué música es esa página.\n${url}`)
      return searchMusic(ctx, pq)
    }
    return searchMusic(ctx, q)
  } catch (e) {
    console.error('[apple]', e)
    return ctx.reply('Error: ' + errText(e))
  }
}

// ── Resultados de /google con botones: música → flujo de música; YouTube → video; otra página → música o YouTube ──
let playVideo = null
export function setVideoHandler(fn) { playVideo = fn }
export function rememberGoogle(ctx, results) {
  if (!results?.length) return {}
  lists.set(String(ctx.chat.id), { kind: 'google', items: results.map(r => ({ title: r.title, url: r.url })), until: Date.now() + PICK_MS })
  markList(ctx.chat.id, 'music')
  return buttons(results.length, 'gpk')
}
async function pickGoogle(ctx, it) {
  if (await musicFromUrl(ctx, it.url)) return
  if (extractYoutubeId(it.url) && playVideo) return playVideo(ctx, `https://youtu.be/${extractYoutubeId(it.url)}`)
  const pq = (await pageMusicQuery(it.url).catch(() => '')) || it.title
  if (pq && await searchMusic(ctx, pq, { strict: true })) return
  const v = (await yts(String(pq || it.title)).catch(() => null))?.videos?.[0]
  if (v?.url && playVideo) {
    await ctx.reply(`No es de YouTube; busqué el título y bajo este video:\n${v.title}\n${v.url}`, { link_preview_options: { is_disabled: true } }).catch(() => {})
    return playVideo(ctx, v.url)
  }
  return ctx.reply(`Ese resultado no es música ni video.\n${it.url}`)
}

async function pick(ctx, n, kind = null) {
  const k = String(ctx.chat?.id)
  const hit = lists.get(k)
  if (!hit || hit.until < Date.now()) { lists.delete(k); return false }
  if (kind && hit.kind !== kind) return false
  if (!Number.isInteger(n) || n < 1 || n > hit.items.length) { await ctx.reply(`Elige un número del 1 al ${hit.items.length}.`); return true }
  const t = hit.items[n - 1]
  if (hit.kind === 'google') { lists.delete(k); await pickGoogle(ctx, t); return true }
  if (t.albumUrl) { await musicFromUrl(ctx, t.albumUrl); return true }
  await playAudio(ctx, t.url ? { url: t.url } : { query: searchQuery(t), meta: { title: t.title, artist: t.artist, album: t.album || '', cover: t.image || '' } })
  return true
}

const MAX_ALL = 100
const albumJobs = new Set()
async function downloadAll(ctx) {
  const k = String(ctx.chat?.id)
  if (albumJobs.has(k)) { await ctx.reply('Ya estoy bajando un álbum en este chat. Espera a que termine.'); return true }
  const hit = lists.get(k)
  if (!hit || hit.until < Date.now() || hit.kind !== 'album') { lists.delete(k); return false }
  let songs = hit.items.filter(t => !t.albumUrl)
  if (!songs.length) { await ctx.reply('Esa lista solo tiene álbumes. Elige uno por número.'); return true }
  const total0 = songs.length
  if (songs.length > MAX_ALL) songs = songs.slice(0, MAX_ALL)
  albumJobs.add(k)
  lists.delete(k)
  const failed = []
  try {
    const st = await ctx.reply(`⬇️ Álbum completo: ${songs.length} canciones${total0 > MAX_ALL ? ` (de ${total0}; máximo ${MAX_ALL})` : ''}. Bajando 1/${songs.length}...`).catch(() => null)
    for (let i = 0; i < songs.length; i++) {
      const t = songs[i]
      if (st && i > 0) await ctx.api.editMessageText(ctx.chat.id, st.message_id, `⬇️ Álbum completo: bajando ${i + 1}/${songs.length}...`).catch(() => {})
      let ok = false
      try { ok = await playAudio(ctx, { quiet: true, ...(t.url ? { url: t.url } : { query: searchQuery(t), meta: { title: t.title, artist: t.artist, album: t.album || '', cover: t.image || '' } }) }) } catch (e) { console.error('[music] todas', errText(e)) }
      if (!ok) failed.push(`${i + 1}. ${t.title}`)
      await new Promise(r => setTimeout(r, 1500))
    }
    const done = `✅ Álbum listo: ${songs.length - failed.length}/${songs.length} canciones enviadas.${failed.length ? `\nNo se pudieron bajar:\n${failed.join('\n')}` : ''}`
    if (st) await ctx.api.editMessageText(ctx.chat.id, st.message_id, done.slice(0, 4000)).catch(() => ctx.reply(done.slice(0, 4000)))
    else await ctx.reply(done.slice(0, 4000))
  } finally {
    albumJobs.delete(k)
  }
  return true
}

export function registerMusic(bot) {
  bot.callbackQuery(/^mus:all$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    try { if (!(await downloadAll(ctx))) await ctx.reply('Esa lista ya venció (5 min). Búscala otra vez.') } catch (e) { await ctx.reply('Error: ' + errText(e)).catch(() => {}) }
  })
  bot.hears(/^\s*(todas|todo|all|0)\s*[.!]?\s*$/i, async (ctx, next) => {
    const k = String(ctx.chat?.id)
    if (!albumJobs.has(k) && (lastList.get(k) !== 'music' || !lists.has(k))) return next()
    try { if (!(await downloadAll(ctx))) return next() } catch (e) { await ctx.reply('Error: ' + errText(e)).catch(() => {}) }
  })
  for (const [re, kind] of [[/^mus:(\d+)$/, 'album'], [/^gpk:(\d+)$/, 'google']]) {
    bot.callbackQuery(re, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {})
      try { if (!(await pick(ctx, Number(ctx.match[1]), kind))) await ctx.reply('Esa lista ya venció (5 min). Búscala otra vez.') } catch (e) { await ctx.reply('Error: ' + errText(e)).catch(() => {}) }
    })
  }
  // Número suelto: solo si la lista más reciente del chat es de música/google
  bot.hears(/^\s*(\d{1,4})\s*$/, async (ctx, next) => {
    const k = String(ctx.chat?.id)
    if (lastList.get(k) !== 'music' || !lists.has(k)) return next()
    try { if (!(await pick(ctx, Number(ctx.match[1])))) return next() } catch (e) { await ctx.reply('Error: ' + errText(e)).catch(() => {}) }
  })
}

export const APPLE_COMMANDS = ['apple', 'applemusic', 'am']
