import os from 'os'
import fetch from 'node-fetch'
import yts from 'yt-search'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { createWriteStream } from 'fs'
import { Readable } from 'stream'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const FALLBACK_KEY = 'LUFFY-FIX67'
export const MAX_DOWNLOAD = Number(process.env.MAX_DOWNLOAD_BYTES || 10 * 1024 * 1024 * 1024) // 10 GB (y nunca más que el espacio libre)
export const TMP_DIR = path.join(process.cwd(), 'tmp-dl')

export function getConfig() {
  return {
    apiUrl: (process.env.ALYACORE_API_URL || 'https://api.alyacore.xyz').replace(/\/$/, ''),
    apiKey: (process.env.ALYACORE_API_KEY || FALLBACK_KEY).trim() || FALLBACK_KEY
  }
}

export function errText(e) {
  if (e == null) return 'error desconocido'
  if (typeof e === 'string') return e
  return String(e.message || e.stderr || e.code || e)
}

export function mb(n) {
  return (Number(n) / 1024 / 1024).toFixed(1)
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      Accept: 'application/json'
    },
    timeout: 60000
  })
  const text = await res.text()
  let json = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { message: text?.slice(0, 200) || `HTTP ${res.status}` }
  }
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`
    const err = new Error(String(msg))
    err.status = res.status
    err.json = json
    throw err
  }
  return json
}

/** Extrae ID de YouTube limpio (ignora ?si= y texto pegado dos veces). */
export function extractYoutubeId(text) {
  const s = String(text || '')
  const m = s.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/|v\/)|[?&]v=)([a-zA-Z0-9_-]{11})/
  )
  return m ? m[1] : null
}

export function normalizeYoutubeUrls(text) {
  const id = extractYoutubeId(text)
  if (!id) {
    // primer http link si hay
    const link = String(text || '').match(/https?:\/\/[^\s]+/i)
    return link ? [link[0].replace(/[),.;]+$/, '')] : [String(text || '').trim()].filter(Boolean)
  }
  return [
    `https://youtu.be/${id}`,
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`
  ]
}

/** Fallback Termux: yt-dlp baja MP4 a disco. */
export function resolveYtDlpBin() {
  const candidates = [
    process.env.YT_DLP_PATH,
    'yt-dlp',
    path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'),
    path.join(process.env.PREFIX || '', 'bin', 'yt-dlp'),
    '/data/data/com.termux/files/usr/bin/yt-dlp'
  ].filter(Boolean)

  for (const c of candidates) {
    try {
      if (c === 'yt-dlp') return c
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return null
}

export const IS_TERMUX = /com\.termux/.test(process.env.PREFIX || '') || fs.existsSync('/data/data/com.termux')

// Mensaje claro en español para errores de yt-dlp con YouTube
export function ytReason(line) {
  const l = String(line || '')
  let why = ''
  if (/Sign in to confirm|not a bot/i.test(l)) why = 'YouTube bloquea al servidor (pide confirmar que no es un bot). Hace falta YT_COOKIES o YT_PROXY.'
  else if (/country/i.test(l)) why = 'bloqueado por país desde el servidor'
  else if (/Private video/i.test(l)) why = 'el video es privado'
  else if (/copyright/i.test(l)) why = 'quitado por derechos de autor'
  else if (/removed|terminated/i.test(l)) why = 'el video fue eliminado'
  else if (/age|inappropriate/i.test(l)) why = 'tiene restricción de edad (hace falta YT_COOKIES)'
  else if (/Video unavailable/i.test(l)) why = 'YouTube no lo muestra desde el servidor'
  return why ? `${why} (${l.replace(/^ERROR:\s*/, '').slice(0, 120)})` : l
}

let cookiesPath = null
export function ytCookiesFile() {
  if (cookiesPath) return cookiesPath
  let raw = String(process.env.YT_COOKIES || '').trim()
  if (!raw) return null
  if (!/\t/.test(raw) && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch {}
  }
  raw = raw.replace(/\\n/g, '\n')
  if (!raw.startsWith('# Netscape')) raw = '# Netscape HTTP Cookie File\n' + raw
  cookiesPath = path.join(os.tmpdir(), 'yt-cookies.txt')
  fs.writeFileSync(cookiesPath, raw + '\n', { mode: 0o600 })
  return cookiesPath
}

// yt-dlp con progreso (callback) y corte si no avanza en STALL_MS o pasa el tiempo máximo
function runYtdlp(cmd, args, { onProgress, stallMs, deadline }) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, ['--newline', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = '', last = Date.now(), started = false, killedWhy = ''
    const onData = (b) => {
      const t = b.toString()
      for (const line of t.split('\n')) {
        const m = line.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\w+))?(?:.*?at\s+(\S+))?(?:.*?ETA\s+(\S+))?/)
        if (m) { started = true; last = Date.now(); onProgress?.({ pct: Number(m[1]), size: m[2] || '', speed: m[3] || '', eta: m[4] || '' }) }
        else if (/\[Merger\]|\[ffmpeg\]/.test(line)) { last = Date.now(); onProgress?.({ merging: true }) }
      }
    }
    ch.stdout.on('data', onData)
    ch.stderr.on('data', (b) => { err += b.toString(); if (err.length > 20000) err = err.slice(-20000); onData(b) })
    const iv = setInterval(() => {
      const now = Date.now()
      if (now - last > stallMs) killedWhy = 'STALL'
      else if (now > deadline) killedWhy = 'DEADLINE'
      if (killedWhy) { clearInterval(iv); ch.kill('SIGKILL') }
    }, 5000)
    ch.on('error', (e) => { clearInterval(iv); reject(Object.assign(e, { started })) })
    ch.on('close', (code) => {
      clearInterval(iv)
      if (code === 0 && !killedWhy) return resolve()
      const e = new Error(killedWhy === 'STALL' ? 'La descarga se quedó sin avanzar varios minutos y la cancelé.' : killedWhy === 'DEADLINE' ? 'La descarga tardó demasiado y la cancelé.' : err || `yt-dlp salió con código ${code}`)
      e.stderr = killedWhy ? e.message : err
      e.started = started
      e.killed = killedWhy
      reject(e)
    })
  })
}

export async function downloadYoutubeWithYtDlp(videoUrlOrId, destPath, quality = 'hd', { onProgress } = {}) {
  const id = extractYoutubeId(videoUrlOrId) || String(videoUrlOrId).trim()
  const url =
    id.length === 11 && !id.includes('/')
      ? `https://www.youtube.com/watch?v=${id}`
      : normalizeYoutubeUrls(videoUrlOrId)[0]

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
  const outTpl = destPath.replace(/\.mp4$/i, '') + '.%(ext)s'
  const bin = resolveYtDlpBin()

  // Por defecto alta calidad (hasta 1080p). fit queda como opcion baja.
  const fmtHd = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/best'
  const fmtFit = 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/bv*[height<=1080]+ba/best'
  const fmt = quality === 'fit' ? fmtFit : fmtHd
  // Opcional en Render: YT_PROXY (http://user:pass@host:port) y YT_COOKIES (texto Netscape o base64)
  const extra = ['--js-runtimes', 'node']
  const cookies = ytCookiesFile()
  if (cookies) extra.push('--cookies', cookies)
  // YT_PROXY (opcional): primero directo; el proxy solo si directo falla
  const proxy = String(process.env.YT_PROXY || '').trim()
  const base = ['--merge-output-format', 'mp4', '--no-playlist', '--no-warnings', '-o', outTpl, url]
  const clients = String(process.env.YT_CLIENTS || 'default,tv,tv_simply,web_safari,mweb,android_vr').split(',').map((c) => c.trim()).filter(Boolean)
  const routes = proxy ? [[], ['--proxy', proxy]] : [[]]
  const exe = bin || 'yt-dlp'
  const attempts = []
  for (const r of routes) {
    for (const c of clients) {
      const ea = c === 'default' ? [] : ['--extractor-args', `youtube:player_client=${c}`]
      attempts.push([exe, [...extra, ...r, ...ea, '-f', fmt, ...base], r.length ? 'proxy' : 'directo'])
    }
  }
  const stallMs = (Number(process.env.YT_STALL_MIN) || 4) * 60_000
  const deadline = Date.now() + (Number(process.env.YT_MAX_MIN) || 60) * 60_000

  let lastErr = 'yt-dlp no encontrado'
  for (const [cmd, args, route] of attempts) {
    if (Date.now() > deadline) { lastErr = 'La descarga tardó demasiado y la cancelé.'; break }
    try {
      onProgress?.({ route })
      await runYtdlp(cmd, args, { onProgress: (p) => onProgress?.({ ...p, route }), stallMs, deadline })
      const base = destPath.replace(/\.mp4$/i, '')
      const candidates = [destPath, base + '.mp4', base + '.webm', base + '.mkv']
      let found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 0)
      if (!found) {
        const name = path.basename(base)
        const hit = fs.readdirSync(TMP_DIR).find((f) => f.startsWith(name) && /\.(mp4|webm|mkv)$/i.test(f))
        if (hit) found = path.join(TMP_DIR, hit)
      }
      if (!found) throw new Error('yt-dlp no genero archivo')
      if (found !== destPath) {
        try {
          fs.renameSync(found, destPath)
        } catch {
          fs.copyFileSync(found, destPath)
          safeUnlink(found)
        }
      }
      return fs.statSync(destPath).size
    } catch (e) {
      const msg = (e?.stderr && e.stderr.toString()) || e?.message || String(e)
      const errLine = msg.split('\n').find((l) => /ERROR:/.test(l)) || msg
      if (!(e?.code === 'ENOENT' && lastErr !== 'yt-dlp no encontrado')) lastErr = errLine.trim().slice(0, 240)
      console.error('[yt-dlp]', cmd, lastErr)
      if (/Private video|copyright|been removed|terminated|not available in your country/i.test(msg)) break
      if (e?.killed === 'DEADLINE') break
    }
  }
  const err = new Error(`yt-dlp fallo: ${ytReason(lastErr)}`)
  err.ytdlp = ytReason(lastErr)
  throw err
}


function defaultDlHeaders(url) {
  const u = String(url)
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    Accept: '*/*'
  }
  if (u.includes('xvideos') || u.includes('xvideos-cdn')) {
    headers.Referer = 'https://www.xvideos.com/'
    headers.Origin = 'https://www.xvideos.com'
  }
  if (u.includes('xnxx') || u.includes('xnxx-cdn') || u.includes('xnxcdn')) {
    headers.Referer = 'https://www.xnxx.com/'
    headers.Origin = 'https://www.xnxx.com'
  }
  return headers
}

function apiKeys() {
  const { apiKey } = getConfig()
  const keys = [apiKey]
  if (apiKey !== FALLBACK_KEY) keys.push(FALLBACK_KEY)
  return keys
}

/** Descarga a archivo en disco (no a RAM). Tope 2GB. */

/** Sigue redirects 301/302/307 manualmente (algunos CDN no los sigue node-fetch bien). */
async function fetchFollow(url, opts = {}, maxRedirects = 10) {
  // 1) Intento automatico
  try {
    const res = await fetch(url, { ...opts, redirect: 'follow' })
    if (res.ok || (res.status >= 200 && res.status < 400)) {
      // si igual quedo en 3xx raro, cae al manual
      if (res.status < 300) return { res, finalUrl: url }
    }
  } catch (e) {
    // sigue al manual
  }

  // 2) Manual 301/302/303/307/308
  let current = url
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, { ...opts, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`Redirect ${res.status} sin Location`)
      try {
        if (res.body && typeof res.body.cancel === 'function') res.body.cancel()
      } catch {}
      current = new URL(loc, current).href
      continue
    }
    if (!res.ok) throw new Error(`Descarga HTTP ${res.status}`)
    return { res, finalUrl: current }
  }
  throw new Error('Demasiados redirects (302)')
}

export async function downloadToFile(url, destPath, {
  timeout = 1_800_000,
  headers = {},
  maxBytes = MAX_DOWNLOAD
} = {}) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
  const { res } = await fetchFollow(url, {
    headers: { ...defaultDlHeaders(url), ...headers },
    timeout
  })
  if (!res.ok) throw new Error(`Descarga HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len && len > maxBytes) {
    throw new Error(`Archivo ~${mb(len)} MB supera el tope de descarga (${mb(maxBytes)} MB)`)
  }
  let free = Infinity
  try { const st = fs.statfsSync(TMP_DIR); free = Number(st.bavail) * Number(st.bsize) } catch {}
  if (len && len > free - 200 * 1024 * 1024) {
    throw new Error(`No hay espacio: pesa ~${mb(len)} MB y quedan ${mb(free)} MB libres`)
  }
  const body = res.body
  if (!body) throw new Error('Sin body en la descarga')

  // Preferir siempre stream Node (.pipe). node-fetch da PassThrough;
  // en Termux a veces tiene getReader y Readable.fromWeb explota.
  let nodeStream
  if (typeof body.pipe === 'function') {
    nodeStream = body
  } else if (typeof body.getReader === 'function') {
    nodeStream = Readable.fromWeb(body)
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    nodeStream = Readable.from(body)
  } else {
    throw new Error('Body de descarga no reconocido')
  }

  let written = 0
  const out = createWriteStream(destPath)
  nodeStream.on('data', (chunk) => {
    written += chunk.length
    if (written > maxBytes) {
      nodeStream.destroy(new Error(`Descarga cortada: supera ${mb(maxBytes)} MB`))
    }
  })
  await pipeline(nodeStream, out)
  const st = fs.statSync(destPath)
  if (!st.size) throw new Error('Archivo vacío')
  return st.size
}

async function probeDurationSec(inputPath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath],
      { timeout: 30000 }
    )
    const n = Number(String(stdout).trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** Comprime MP4 para Telegram cloud (~50MB) con bitrate segun duracion. */
export async function compressForTelegram(inputPath, maxSendBytes) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
  const outFile = path.join(TMP_DIR, `${Date.now()}-tg-out.mp4`)
  const target = Math.floor(maxSendBytes * 0.92)
  const duration = await probeDurationSec(inputPath)
  const audioKbps = 48
  let videoKbps = 280
  if (duration > 1) {
    const totalKbps = Math.floor((target * 8) / duration / 1000)
    videoKbps = Math.max(70, totalKbps - audioKbps)
  }

  const ladders = [
    { h: 360, v: videoKbps, a: 48 },
    { h: 240, v: Math.max(60, Math.floor(videoKbps * 0.75)), a: 40 },
    { h: 180, v: Math.max(50, Math.floor(videoKbps * 0.55)), a: 32 },
    { h: 144, v: Math.max(40, Math.floor(videoKbps * 0.4)), a: 24 }
  ]

  let bestPath = null
  let bestSize = Infinity

  for (const step of ladders) {
    const args = [
      '-y', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${step.v}k`, '-maxrate', `${step.v}k`, '-bufsize', `${step.v * 2}k`,
      '-vf', `scale='min(${step.h},iw)':-2`,
      '-c:a', 'aac', '-b:a', `${step.a}k`, '-ac', '1',
      '-movflags', '+faststart', '-threads', '0',
      outFile
    ]
    try {
      console.error(`[ffmpeg] ${step.h}p @ ${step.v}k (dur ${Number(duration).toFixed(1)}s)`)
      await execFileAsync('ffmpeg', args, { timeout: 1_200_000 })
      if (!fs.existsSync(outFile)) continue
      const size = fs.statSync(outFile).size
      if (!size) continue
      if (size < bestSize) {
        bestSize = size
        if (bestPath) safeUnlink(bestPath)
        const keep = path.join(TMP_DIR, `${Date.now()}-best.mp4`)
        fs.copyFileSync(outFile, keep)
        bestPath = keep
      }
      if (size <= maxSendBytes) {
        safeUnlink(outFile)
        return bestPath
      }
    } catch (e) {
      console.error('[ffmpeg]', e?.message || e)
    }
  }
  safeUnlink(outFile)
  return bestPath
}

export async function downloadBuffer(url, timeout = 180000) {
  const { res } = await fetchFollow(url, {
    headers: defaultDlHeaders(url),
    timeout
  })
  if (!res.ok) throw new Error(`Descarga HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function resolveYoutube(text) {
  const id = extractYoutubeId(text)
  const query = id ? `https://youtu.be/${id}` : String(text).trim()
  const search = await yts(query)
  if (!search.videos?.length) return null
  const video = id
    ? (search.videos.find((v) => v.videoId === id) || search.videos[0])
    : search.videos[0]
  return video
}

export async function getAudioLink(videoUrl, title) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  const urls = [videoUrl]
  const idMatch = String(videoUrl).match(/(?:youtu\.be\/|v=|shorts\/)([a-zA-Z0-9_-]{11})/)
  if (idMatch) {
    urls.push(`https://youtu.be/${idMatch[1]}`, `https://www.youtube.com/watch?v=${idMatch[1]}`)
  }
  let last = 'Sin resultado'
  for (const key of keys) {
    for (const u of urls) {
      for (const ep of ['ytmp3v2', 'ytmp3']) {
        try {
          const res = await fetchJson(`${apiUrl}/dl/${ep}?url=${encodeURIComponent(u)}&key=${key}`)
          const dl = res?.data?.dl || res?.result?.dl || res?.dl
          if (res?.status && dl) return { dl, title: res.data?.title || title }
          last = res?.message || last
        } catch (e) {
          last = e.message || last
        }
      }
    }
  }
  return { error: last }
}

export async function getVideoLink(videoUrl, title) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  const urls = normalizeYoutubeUrls(videoUrl)
  let last = 'Sin resultado'
  const endpoints = []
  for (const u of urls) {
    for (const quality of ['1080', '720', 'auto', '480', '360', '240']) {
      endpoints.push((key) =>
        `${apiUrl}/dl/youtubeplayv2?query=${encodeURIComponent(u)}&type=mp4&quality=${quality}&key=${key}`
      )
    }
    endpoints.push((key) => `${apiUrl}/dl/ytmp4?url=${encodeURIComponent(u)}&key=${key}`)
    endpoints.push((key) => `${apiUrl}/dl/ytmp4v2?url=${encodeURIComponent(u)}&key=${key}`)
  }
  for (const key of keys) {
    for (const make of endpoints) {
      try {
        const res = await fetchJson(make(key))
        const dl = res?.data?.dl || res?.result?.dl || res?.dl
        if (res?.status && dl) {
          return { dl, title: res.data?.title || res.result?.title || title, size: res.data?.size }
        }
        last = res?.message || last
      } catch (e) {
        last = e.message || last
      }
    }
  }
  return { error: last, urlsTried: urls }
}

function pickXvideosCandidates(resultado, prefer = 'high') {
  const videos = resultado?.videos || resultado?.result?.videos || {}
  const list = []
  const seen = new Set()
  const push = (quality, url) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    list.push({ quality, url })
  }

  // Alta calidad primero (1080/high), luego 720, luego low
  const p1080 = videos['1080p'] || videos['1080'] || videos.p1080
  const high = videos.high || videos.HD || videos.hd
  const p720 = videos['720p'] || videos['720'] || videos.p720
  const low = videos.low || videos.SD || videos.sd || videos['360p'] || videos['240p']

  if (prefer === 'high' || prefer === 'hd') {
    push('1080p', p1080)
    push('high', high)
    push('720p', p720)
    push('low', low)
  } else if (prefer === '720') {
    push('720p', p720)
    push('high', high)
    push('low', low)
  } else {
    push('low', low)
    push('720p', p720)
    push('high', high)
    push('1080p', p1080)
  }

  const legacy = resultado?.result?.url || resultado?.url || resultado?.dl
  push('legacy', legacy)
  return list
}

/** Si el video es mas alto que maxH, lo baja a maxH (720p). */
export async function ensureMaxHeight(inputPath, maxH = 720) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=height',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputPath
      ],
      { timeout: 30000 }
    )
    const h = Number(String(stdout).trim())
    if (!Number.isFinite(h) || h <= maxH) return inputPath

    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
    const out = path.join(TMP_DIR, `${Date.now()}-${maxH}p.mp4`)
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-i', inputPath,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-vf', `scale='min(${maxH},iw)':-2`,
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', '-threads', '0',
        out
      ],
      { timeout: 1_200_000 }
    )
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      try {
        fs.renameSync(out, inputPath)
      } catch {
        fs.copyFileSync(out, inputPath)
        safeUnlink(out)
      }
    }
    return inputPath
  } catch (e) {
    console.error('[ensureMaxHeight]', e?.message || e)
    return inputPath
  }
}

export async function getXvideosDownload(videoUrl) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/nsfw/dl/xvideos?url=${encodeURIComponent(videoUrl)}&key=${key}`
      )
      const candidates = pickXvideosCandidates(res?.resultado, 'high')
      if (res?.status && candidates.length) return { candidates, message: res.message }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

export async function searchXvideos(query) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/nsfw/search/xvideos?query=${encodeURIComponent(query)}&key=${key}`
      )
      if (res?.status && res?.resultados?.length) return { results: res.resultados }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

/** TikTok video o audio (mp3=true). */
export async function getTiktok(url, { mp3 = false } = {}) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  const ep = mp3 ? 'tiktokmp3' : 'tiktok'
  let last = 'Sin resultado'
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/dl/${ep}?url=${encodeURIComponent(url)}&key=${key}`
      )
      const data = res?.data
      const dl = data?.dl
      if (res?.status && dl) {
        return {
          dl,
          title: data.title || 'TikTok',
          author: data.author?.nickname || data.author?.unique_id || '',
          thumbnail: data.thumbnail,
          type: data.type || (mp3 ? 'audio' : 'video'),
          duration: data.duration || data.music_info?.duration
        }
      }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

/** Instagram: data.download[] con {type, url} */
export async function getInstagram(url) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/dl/instagram?url=${encodeURIComponent(url)}&key=${key}`
      )
      const downloads = res?.data?.download
      if (res?.status && Array.isArray(downloads) && downloads.length) {
        return { downloads }
      }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

/**
 * Facebook v2: la API suele devolver el binario del video (no JSON).
 * Devolvemos la URL lista para downloadToFile.
 */
export async function getFacebookDownloadUrl(pageUrl) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  for (const key of keys) {
    const endpoint = `${apiUrl}/dl/facebookv2?url=${encodeURIComponent(pageUrl)}&key=${key}`
    try {
      // Probar HEAD/GET corto: si content-type es video, usar endpoint directo
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
        timeout: 30000
      })
      if (!res.ok) {
        last = `HTTP ${res.status}`
        continue
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      if (ct.includes('application/json') || ct.includes('text/')) {
        const text = await res.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          last = 'Respuesta no JSON'
          continue
        }
        const dl =
          json?.data?.dl ||
          json?.data?.url ||
          json?.result?.dl ||
          json?.result?.url ||
          json?.dl ||
          json?.url
        if (json?.status && dl) return { dl, title: json.data?.title || 'facebook' }
        last = json?.message || last
      } else {
        // Binario: cancelar body y devolver la URL del endpoint
        try {
          res.body?.destroy?.()
        } catch {}
        return { dl: endpoint, title: 'facebook', binaryEndpoint: true }
      }
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

export async function getSpotify(query) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  const isUrl = /open\.spotify\.com\/track\//i.test(query)
  let meta = null
  let url = String(query || '').trim()

  // 1) Resolver metadata (search o URL)
  for (const key of keys) {
    try {
      if (!isUrl) {
        const search = await fetchJson(
          `${apiUrl}/search/spotify?query=${encodeURIComponent(query)}&key=${key}`
        )
        if (!search?.status || !search?.data?.length) {
          last = search?.message || 'Sin resultados Spotify'
          continue
        }
        meta = search.data[0]
        url = meta.url
        break
      } else {
        url = query.split(/\s+/)[0]
        break
      }
    } catch (e) {
      last = e.message || last
    }
  }

  if (!isUrl && !meta) return { error: last }

  // 2) Intentar descarga Spotify
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/dl/spotify?url=${encodeURIComponent(url)}&key=${key}`
      )
      if (res?.status && res?.data?.dl) {
        return {
          dl: res.data.dl,
          title: res.data.title || meta?.title || meta?.name || 'spotify',
          artist: res.data.artist || meta?.artist || '',
          album: res.data.album || meta?.album || '',
          cover: res.data.image || res.data.cover || meta?.image || meta?.cover,
          url,
          source: 'spotify'
        }
      }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }

  // 3) Fallback YouTube (Alyacore /dl/spotify suele estar caído)
  if (isUrl && !meta) {
    try {
      const page = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          Accept: 'text/html'
        },
        timeout: 30000
      })
      if (page.ok) {
        const html = await page.text()
        const title = (html.match(/property="og:title" content="([^"]+)"/i) || [])[1]
        const image = (html.match(/property="og:image" content="([^"]+)"/i) || [])[1]
        const desc = (html.match(/property="og:description" content="([^"]+)"/i) || [])[1] || ''
        const parts = desc.split(/[·•|]/).map((s) => s.trim()).filter(Boolean)
        if (title) {
          meta = {
            title,
            artist: parts[1] || '',
            album: parts[2] || '',
            image,
            url
          }
        }
      }
    } catch (e) {
      last = e.message || last
    }
  }

  const ytQuery = [meta?.title || meta?.name, meta?.artist]
    .filter(Boolean)
    .join(' ')
    .trim() || String(query || '').trim()

  // Prefer youtubeplayv2 by query (mismo path que /play)
  for (const key of keys) {
    for (const ep of ['youtubeplayv2', 'youtubeplay']) {
      try {
        const res = await fetchJson(
          `${apiUrl}/dl/${ep}?query=${encodeURIComponent(ytQuery)}&type=mp3&quality=320&key=${key}`
        )
        const dl = res?.data?.dl || res?.result?.dl || res?.dl
        if (res?.status && dl) {
          return {
            dl,
            title: meta?.title || meta?.name || res.data?.title || ytQuery,
            artist: meta?.artist || '',
            album: meta?.album || '',
            cover: meta?.image || meta?.cover || res.data?.thumbnail,
            url,
            source: 'youtube'
          }
        }
        last = res?.message || last
      } catch (e) {
        last = e.message || last
      }
    }
  }

  try {
    const video = await resolveYoutube(ytQuery)
    if (video?.url) {
      const audio = await getAudioLink(video.url, video.title || ytQuery)
      if (audio?.dl) {
        return {
          dl: audio.dl,
          title: meta?.title || meta?.name || audio.title || video.title || ytQuery,
          artist: meta?.artist || '',
          album: meta?.album || '',
          cover: meta?.image || meta?.cover || video.thumbnail,
          url,
          source: 'youtube'
        }
      }
      last = audio?.error || last
    }
  } catch (e) {
    last = e.message || last
  }

  return { error: last }
}

export async function getMediafire(pageUrl) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/dl/mediafire?url=${encodeURIComponent(pageUrl)}&key=${key}`
      )
      if (res?.status && res?.result?.download) {
        return {
          download: res.result.download,
          filename: res.result.filename || 'mediafire.bin',
          filetype: res.result.filetype,
          filesize: res.result.filesize,
          uploaded: res.result.uploaded
        }
      }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function isTransientNetworkError(err) {
  const code = err?.code || err?.errno || ''
  const msg = String(err?.message || err || '')
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    /ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg)
  )
}

/** NSFW_ENABLED env opcional (default true). */
export function isNsfwEnabled() {
  const v = process.env.NSFW_ENABLED
  if (v == null || String(v).trim() === '') return true
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())
}

/**
 * Alyacore NSFW interaction GIF/video.
 * GET /nsfw/interaction?inter=&key= — retry 3x on ECONNRESET (como WhatsApp).
 */
export async function getNsfwInteraction(inter) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  const MAX_RETRIES = 3
  let lastErr = null

  for (const key of keys) {
    const url = `${apiUrl}/nsfw/interaction?inter=${encodeURIComponent(inter)}&key=${encodeURIComponent(key)}`
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
            Accept: 'application/json'
          },
          timeout: 45000
        })
        if (!response.ok) {
          lastErr = new Error(`HTTP ${response.status}`)
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            await sleep(800 * attempt)
            continue
          }
          // probar siguiente key
          break
        }
        const json = await response.json().catch(() => ({}))
        if (json?.status && json?.result) {
          return { url: json.result, status: true, message: json.message }
        }
        lastErr = new Error(json?.message || 'sin resultado')
      } catch (e) {
        lastErr = e
        if (isTransientNetworkError(e) && attempt < MAX_RETRIES) {
          console.error(`[nsfw/inter] reintento ${attempt}/${MAX_RETRIES}`, e.code || e.message)
          await sleep(900 * attempt)
          continue
        }
        // error no transitorio: probar siguiente key
        break
      }
    }
  }
  return { error: lastErr?.message || String(lastErr || 'API NSFW no respondio') }
}

/** GET /nsfw/search/xnxx?query=&key= */
export async function getXnxxSearch(query) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/nsfw/search/xnxx?query=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`
      )
      if (res?.status && res?.resultados?.length) return { results: res.resultados }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

/**
 * GET /nsfw/dl/xnxx?url=&key=
 * Prefer resultado.result.download.high, fallback low.
 */
export async function getXnxxDownload(videoUrl) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  let last = 'Sin resultado'
  for (const key of keys) {
    try {
      const res = await fetchJson(
        `${apiUrl}/nsfw/dl/xnxx?url=${encodeURIComponent(videoUrl)}&key=${encodeURIComponent(key)}`
      )
      const dl = res?.resultado?.result?.download || res?.resultado?.download || res?.result?.download
      const candidates = []
      if (dl?.high) candidates.push({ quality: 'high', url: dl.high })
      if (dl?.low) candidates.push({ quality: 'low', url: dl.low })
      // otros posibles campos
      if (!candidates.length && typeof dl === 'string') {
        candidates.push({ quality: 'default', url: dl })
      }
      if (res?.status && candidates.length) {
        return { candidates, title: res?.resultado?.result?.title || res?.resultado?.title, message: res.message }
      }
      last = res?.message || last
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

/** Danbooru/Gelbooru Alyacore: la API suele devolver imagen binaria. */
export async function getBooruImageUrl(kind, keyword) {
  const { apiUrl } = getConfig()
  const keys = apiKeys()
  const ep = kind === 'gelbooru' ? 'gelbooru' : kind === 'safebooru' ? 'safebooru' : 'danbooru'
  let last = 'Sin resultado'
  for (const key of keys) {
    const endpoint = `${apiUrl}/nsfw/${ep}?keyword=${encodeURIComponent(keyword)}&key=${key}`
    try {
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
        timeout: 60000
      })
      if (!res.ok) {
        last = `HTTP ${res.status}`
        continue
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      if (ct.includes('application/json')) {
        const json = await res.json()
        const img =
          json?.data?.url ||
          json?.data?.image ||
          json?.result?.url ||
          json?.url ||
          json?.image
        if (img) return { url: img }
        last = json?.message || last
      } else if (ct.startsWith('image/') || ct.includes('octet-stream')) {
        try {
          res.body?.destroy?.()
        } catch {}
        return { url: endpoint, binaryEndpoint: true }
      } else {
        // asumir imagen
        try {
          res.body?.destroy?.()
        } catch {}
        return { url: endpoint, binaryEndpoint: true }
      }
    } catch (e) {
      last = e.message || last
    }
  }
  return { error: last }
}

export async function getRule34Image(tag) {
  const clean = String(tag).replace(/\s+/g, '_')
  const apiKey = process.env.RULE34_API_KEY || ''
  const userId = process.env.RULE34_USER_ID || ''
  let url =
    `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(clean)}`
  if (apiKey) url += `&api_key=${encodeURIComponent(apiKey)}`
  if (userId) url += `&user_id=${encodeURIComponent(userId)}`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeout: 60000
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  let json = []
  try {
    json = JSON.parse(text)
  } catch {
    json = []
  }
  const data = Array.isArray(json) ? json : json?.post || json?.data || []
  const images = data
    .map((i) => i?.file_url || i?.sample_url || i?.preview_url)
    .filter((u) => typeof u === 'string' && /\.(jpe?g|png|gif)$/i.test(u))
  if (!images.length) return { error: `Sin resultados para ${clean}` }
  const pick = images[Math.floor(Math.random() * images.length)]
  return { url: pick }
}

const LANG_NAMES = {
  es: 'es', espanol: 'es', spanish: 'es', castellano: 'es',
  en: 'en', ingles: 'en', english: 'en',
  pt: 'pt', portugues: 'pt',
  fr: 'fr', frances: 'fr',
  it: 'it', italiano: 'it',
  de: 'de', aleman: 'de',
  ja: 'ja', japones: 'ja',
  ko: 'ko', coreano: 'ko',
  zh: 'zh', chino: 'zh',
  ru: 'ru', ruso: 'ru',
  ar: 'ar', arabe: 'ar'
}

export function normalizeLang(code) {
  const k = String(code || 'es').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return LANG_NAMES[k] || (/^[a-z]{2}$/.test(k) ? k : 'es')
}

function splitChunks(text, size = 350) {
  const parts = []
  let rest = String(text || '').trim()
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < 80) cut = rest.lastIndexOf(' ', size)
    if (cut < 80) cut = size
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

async function lingvaChunk(text, lang) {
  const url = 'https://lingva.ml/api/v1/auto/' + lang + '/' + encodeURIComponent(text)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Dwnld7bot/1.0', Accept: 'application/json' }
  })
  const json = await res.json()
  if (!json?.translation) throw new Error('sin traduccion')
  return String(json.translation)
}

async function memoryChunk(text, lang) {
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) +
    '&langpair=autodetect|' +
    lang
  const res = await fetch(url, { headers: { 'User-Agent': 'Dwnld7bot/1.0' } })
  const json = await res.json()
  const out = json?.responseData?.translatedText
  if (!out) throw new Error('sin traduccion')
  return String(out)
}

export async function translateText(text, language = 'es') {
  const lang = normalizeLang(language)
  const chunks = splitChunks(text, 350)
  if (!chunks.length) return { error: 'Falta el texto' }
  try {
    const out = []
    for (const part of chunks) out.push(await lingvaChunk(part, lang))
    return { text: out.join('\n') }
  } catch (e1) {
    try {
      const out = []
      for (const part of splitChunks(text, 400)) out.push(await memoryChunk(part, lang))
      return { text: out.join('\n') }
    } catch (e2) {
      return { error: 'No se pudo traducir. Intenta de nuevo.' }
    }
  }
}

export function isDirectMediaUrl(text) {
  const u = String(text || '').trim()
  if (!/^https?:\/\//i.test(u)) return false
  if (/\.(mp4|m4v|webm|mkv|mp3|m4a|ogg)(\?|#|$)/i.test(u)) return true
  if (u.includes('xvideos-cdn.com') || u.includes('xhcdn.com')) return true
  if (u.includes('xnxx') || u.includes('xnxcdn')) return true
  return false
}

export function tmpPath(name) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
  return path.join(TMP_DIR, name)
}

export function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p)
  } catch {}
}

export function argText(ctx) {
  const raw =
    (ctx.match || '').toString().trim() ||
    (ctx.message?.text || ctx.message?.caption || '')
      .split(/\s+/)
      .slice(1)
      .join(' ')
      .trim()
  if (!raw) return ''
  // si pegaron el comando dos veces, quedarse con el primer link/ID
  const id = extractYoutubeId(raw)
  if (id) return `https://youtu.be/${id}`
  const link = raw.match(/https?:\/\/[^\s]+/i)
  if (link) return link[0].replace(/[),.;]+$/, '')
  // cortar si aparece otro /comando en el medio
  const cut = raw.split(/\s+\//)[0].trim()
  return cut || raw
}

// Tope de envío a Telegram (lo fija index.js: ~1950 MB con Bot API local, 49 MB en la nube)
let SEND_LIMIT = 49 * 1024 * 1024
export function setSendLimit(n) { if (Number(n) > 0) SEND_LIMIT = Number(n) }
export function sendLimit() { return SEND_LIMIT }
