// Soporte para servidor Telegram Local Bot API (tdlib/telegram-bot-api).
// - Resuelve al arrancar si se usa TELEGRAM_API_ROOT o la API oficial.
// - Hace logOut en api.telegram.org una sola vez (requisito de Telegram para mover el bot).
// - Si el servidor local no responde, cae a la API oficial (tope 49 MB) sin crash-loop.
// - Descarga archivos de getFile tanto en modo normal como --local (rutas absolutas).
import fs from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import path from 'path'

export const OFFICIAL_API_ROOT = 'https://api.telegram.org'
const MARKER_FILE = path.join(process.cwd(), 'data', '.telegram-local-logout.json')

const state = {
  root: OFFICIAL_API_ROOT,
  local: false,
  requested: null,
  reason: 'TELEGRAM_API_ROOT vacio'
}

export function getApiState() {
  return { ...state }
}

export function getActiveApiRoot() {
  return state.root
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function envTrue(v) {
  return /^(1|true|yes|si|on)$/i.test(String(v || '').trim())
}

function tokenId(token) {
  return String(token || '').split(':')[0]
}

// Llama un metodo Bot API. Devuelve { ok, status, json } o { ok:false, network:true, error }.
async function callApi(root, token, method, timeoutMs = 8000) {
  try {
    const res = await fetch(`${root}/bot${token}/${method}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    })
    let json = null
    try {
      json = await res.json()
    } catch {
      return { ok: false, network: true, status: res.status, error: `respuesta no JSON (HTTP ${res.status})` }
    }
    return { ok: Boolean(json?.ok), status: res.status, json }
  } catch (e) {
    return { ok: false, network: true, error: e?.cause?.code || e?.name || e?.message || String(e) }
  }
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeMarker(token, root) {
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true })
    fs.writeFileSync(
      MARKER_FILE,
      JSON.stringify({ botId: tokenId(token), root, at: new Date().toISOString() }, null, 2)
    )
  } catch (e) {
    console.error('[localapi] no se pudo guardar marcador logOut:', e?.message || e)
  }
}

function logoutAlreadyDone(token) {
  if (envTrue(process.env.TELEGRAM_LOCAL_LOGOUT_DONE)) return true
  const m = readMarker()
  return Boolean(m && m.botId === tokenId(token))
}

// logOut en la API oficial. Idempotente: si ya estaba deslogueado, Telegram responde error y se ignora.
async function logoutFromOfficial(token, root) {
  console.warn(
    '[localapi] llamando logOut en api.telegram.org (requisito para usar servidor local). ' +
      'La API oficial queda bloqueada ~10 min para este bot.'
  )
  const r = await callApi(OFFICIAL_API_ROOT, token, 'logOut', 15000)
  if (r.ok) {
    console.log('[localapi] logOut oficial OK')
    writeMarker(token, root)
    return true
  }
  const desc = r.json?.description || r.error || 'desconocido'
  console.warn('[localapi] logOut oficial respondio:', r.status || '', desc, '(probablemente ya estaba deslogueado)')
  // 401/400 tras un logOut previo = ya estaba fuera de la nube. Se marca para no repetir.
  if (!r.network) writeMarker(token, root)
  return false
}

async function probeLocal(root, token, tries, gapMs) {
  let last = null
  for (let i = 1; i <= tries; i++) {
    last = await callApi(root, token, 'getMe', 8000)
    if (!last.network) return last
    console.warn(`[localapi] servidor local no responde (${i}/${tries}):`, last.error)
    if (i < tries) await sleep(gapMs)
  }
  return last
}

// Decide la raiz de la API. Nunca lanza: ante cualquier fallo usa la oficial.
export async function resolveApiRoot(token) {
  const raw = String(process.env.TELEGRAM_API_ROOT || '').trim().replace(/\/+$/, '')
  state.requested = raw || null
  if (!raw || raw === OFFICIAL_API_ROOT) {
    state.root = OFFICIAL_API_ROOT
    state.local = false
    state.reason = raw ? 'TELEGRAM_API_ROOT = oficial' : 'TELEGRAM_API_ROOT vacio'
    return getApiState()
  }

  const tries = Math.max(1, Number(process.env.TELEGRAM_API_PROBE_TRIES) || 4)
  const gapMs = Math.max(500, Number(process.env.TELEGRAM_API_PROBE_GAP_MS) || 5000)
  console.log('[localapi] probando servidor local:', raw)

  let r = await probeLocal(raw, token, tries, gapMs)

  if (!r.network && r.status === 401) {
    // Unauthorized en el local: o el token es invalido o falta el logOut de la nube.
    console.warn('[localapi] servidor local respondio 401 Unauthorized; intentando logOut oficial y reintento')
    await logoutFromOfficial(token, raw)
    await sleep(2000)
    r = await probeLocal(raw, token, 2, gapMs)
  }

  if (r.ok) {
    if (!logoutAlreadyDone(token)) await logoutFromOfficial(token, raw)
    state.root = raw
    state.local = true
    state.reason = 'servidor local OK'
    console.log('[localapi] usando servidor local:', raw, '@' + (r.json?.result?.username || '?'))
    return getApiState()
  }

  state.root = OFFICIAL_API_ROOT
  state.local = false
  state.reason = r.network
    ? `servidor local inalcanzable (${r.error})`
    : `servidor local error ${r.status}: ${r.json?.description || ''}`
  console.error('[localapi] FALLBACK a api.telegram.org con tope 49 MB ->', state.reason)
  console.error('[localapi] Revisa el servicio telegram-bot-api y reinicia el bot cuando este arriba.')
  return getApiState()
}

// Descarga el archivo de un getFile a Buffer. Soporta:
// - file_path relativo (API oficial o local sin --local): {root}/file/bot{token}/{path}
// - file_path absoluto (--local): el archivo vive en el disco del servidor Bot API, que normalmente es
//   otro contenedor. Se intenta, en orden:
//   1) leerlo del disco (si bot y servidor comparten disco, p. ej. Termux en el mismo teléfono)
//   2) TELEGRAM_API_FILES_URL (si existe)
//   3) el servidor de archivos del propio servidor local en la red privada (puerto 8090 de
//      local-bot-api/start.sh), deducido de TELEGRAM_API_ROOT, sin variables nuevas
//   4) el endpoint /file/ del servidor local
//   No se usa api.telegram.org en modo local: pedirle getFile a la nube volvería a "loguear" el bot
//   allá y el servidor local podría dejar de recibir mensajes.
function filesCandidates(fp, token) {
  const prefix = String(process.env.TELEGRAM_API_FILES_PREFIX || '/var/lib/telegram-bot-api').replace(/\/+$/, '')
  const rel = fp.startsWith(prefix + '/') ? fp.slice(prefix.length + 1) : fp.replace(/^\/+/, '')
  const relEnc = rel.split('/').map(encodeURIComponent).join('/')
  const bases = []
  const add = (b) => { b = String(b || '').trim().replace(/\/+$/, ''); if (b && !bases.includes(b)) bases.push(b) }
  add(process.env.TELEGRAM_API_FILES_URL)
  const filesPort = String(process.env.TELEGRAM_FILES_PORT || '8090')
  for (const raw of [state.requested, state.root]) {
    try {
      const u = new URL(String(raw || ''))
      const h = u.hostname
      if (/\.railway\.internal$/i.test(h) || /^(localhost|127\.|10\.|192\.168\.|\[?::1\]?$|\[?fd)/i.test(h)) add(`http://${u.host.replace(/:\d+$/, '')}:${filesPort}`)
    } catch {}
  }
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) add(`http://telegram-bot-api.railway.internal:${filesPort}`)
  const urls = bases.map((b) => `${b}/${relEnc}`)
  const root = getActiveApiRoot()
  if (root !== OFFICIAL_API_ROOT) {
    urls.push(`${root}/file/bot${token}/${relEnc}`)
    urls.push(`${root}/file/bot${token}${fp.split('/').map(encodeURIComponent).join('/')}`)
  }
  return urls
}

async function fetchBuf(url, timeoutMs, maxBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (maxBytes && buf.length > maxBytes) throw new Error('Archivo demasiado grande')
  // Una respuesta JSON de la Bot API ({"ok":false,…} o getMe) no es el archivo
  if (/json/i.test(res.headers.get('content-type') || '') || /^\s*\{"ok":/.test(buf.subarray(0, 16).toString())) throw new Error('respuesta JSON, no archivo')
  return buf
}

const safeUrl = (u) => String(u).replace(/\d{5,}(:|%3A)[\w-]{10,}/gi, '<token>')

export async function downloadTelegramFile(file, token, { timeoutMs = 120000, maxBytes = 0 } = {}) {
  const fp = String(file?.file_path || '')
  if (!fp) throw new Error('Telegram no devolvio file_path')

  if (!fp.startsWith('/')) {
    try {
      return await fetchBuf(`${getActiveApiRoot()}/file/bot${token}/${fp}`, timeoutMs, maxBytes)
    } catch (e) {
      if (/demasiado grande/.test(e.message)) throw e
      throw new Error(`Descarga de Telegram fallo (${e.message})`)
    }
  }

  try {
    fs.accessSync(fp, fs.constants.R_OK)
    return fs.readFileSync(fp)
  } catch {}
  const errs = []
  for (const url of filesCandidates(fp, token)) {
    try {
      const buf = await fetchBuf(url, Math.min(timeoutMs, 60000), maxBytes)
      if (buf.length) return buf
      errs.push(`${safeUrl(url)} vacio`)
    } catch (e) {
      if (/demasiado grande/.test(e.message)) throw e
      errs.push(`${safeUrl(url)} ${e?.cause?.code || e.message}`)
    }
  }
  console.error('[getfile] no se pudo bajar el archivo del servidor local:', errs.join(' | '))
  throw new Error('No pude bajar el archivo desde el servidor de Telegram del bot. Intenta otra vez en unos minutos.')
}

// Igual que downloadTelegramFile pero guarda directo en un archivo, sin cargarlo todo en memoria
// (para audios largos). Devuelve el tamaño en bytes.
async function fetchTo(url, dest, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (/json/i.test(res.headers.get('content-type') || '')) throw new Error('respuesta JSON, no archivo')
  if (!res.body) throw new Error('sin contenido')
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
  const size = fs.statSync(dest).size
  const head = Buffer.alloc(16)
  const fd = fs.openSync(dest, 'r')
  try { fs.readSync(fd, head, 0, 16, 0) } finally { fs.closeSync(fd) }
  if (/^\s*\{"ok":/.test(head.toString())) throw new Error('respuesta JSON, no archivo')
  return size
}

export async function downloadTelegramFileTo(file, token, dest, { timeoutMs = 30 * 60000 } = {}) {
  const fp = String(file?.file_path || '')
  if (!fp) throw new Error('Telegram no devolvio file_path')
  if (!fp.startsWith('/')) {
    try {
      return await fetchTo(`${getActiveApiRoot()}/file/bot${token}/${fp}`, dest, timeoutMs)
    } catch (e) {
      fs.rmSync(dest, { force: true })
      throw new Error(`Descarga de Telegram fallo (${safeUrl(e.message)})`)
    }
  }
  try {
    fs.accessSync(fp, fs.constants.R_OK)
    await fs.promises.copyFile(fp, dest)
    return fs.statSync(dest).size
  } catch {}
  const errs = []
  for (const url of filesCandidates(fp, token)) {
    try {
      const size = await fetchTo(url, dest, timeoutMs)
      if (size) return size
      errs.push(`${safeUrl(url)} vacio`)
    } catch (e) {
      errs.push(`${safeUrl(url)} ${e?.cause?.code || e.message}`)
    }
    fs.rmSync(dest, { force: true })
  }
  console.error('[getfile] no se pudo bajar el archivo del servidor local:', errs.join(' | '))
  throw new Error('No pude bajar el archivo desde el servidor de Telegram del bot. Intenta otra vez en unos minutos.')
}
