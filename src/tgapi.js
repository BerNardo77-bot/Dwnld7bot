// Soporte para servidor Telegram Local Bot API (tdlib/telegram-bot-api).
// - Resuelve al arrancar si se usa TELEGRAM_API_ROOT o la API oficial.
// - Hace logOut en api.telegram.org una sola vez (requisito de Telegram para mover el bot).
// - Si el servidor local no responde, cae a la API oficial (tope 49 MB) sin crash-loop.
// - Descarga archivos de getFile tanto en modo normal como --local (rutas absolutas).
import fs from 'fs'
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
// - file_path absoluto (--local): lee del disco si existe; si no, TELEGRAM_API_FILES_URL.
export async function downloadTelegramFile(file, token, { timeoutMs = 120000, maxBytes = 0 } = {}) {
  const fp = String(file?.file_path || '')
  if (!fp) throw new Error('Telegram no devolvio file_path')

  let url
  if (fp.startsWith('/')) {
    try {
      fs.accessSync(fp, fs.constants.R_OK)
      return fs.readFileSync(fp)
    } catch {}
    const filesUrl = String(process.env.TELEGRAM_API_FILES_URL || '').trim().replace(/\/+$/, '')
    if (!filesUrl) {
      throw new Error(
        'El servidor Bot API local (--local) devolvio una ruta de disco que este bot no puede leer. ' +
          'Configura TELEGRAM_API_FILES_URL o quita TELEGRAM_LOCAL=1 del servidor.'
      )
    }
    const prefix = String(process.env.TELEGRAM_API_FILES_PREFIX || '/var/lib/telegram-bot-api').replace(/\/+$/, '')
    const rel = fp.startsWith(prefix + '/') ? fp.slice(prefix.length + 1) : fp.replace(/^\/+/, '')
    url = `${filesUrl}/${rel.split('/').map(encodeURIComponent).join('/')}`
  } else {
    url = `${getActiveApiRoot()}/file/bot${token}/${fp}`
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`Descarga de Telegram fallo (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (maxBytes && buf.length > maxBytes) throw new Error('Archivo demasiado grande')
  return buf
}
