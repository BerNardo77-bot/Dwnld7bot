// Subidas grandes (hasta ~2 GB) SIN servidor extra: MTProto directo con gramjs,
// usando el mismo token del bot + TELEGRAM_API_ID / TELEGRAM_API_HASH del .env.
// Si faltan esas variables o algo falla, el bot sigue con el límite normal de 49 MB.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { Logger, LogLevel } from 'telegram/extensions/Logger.js'
import { ConnectionTCPObfuscated } from 'telegram/network/index.js'

// gramjs imprime muchísimo cuando no hay red. Lo callamos y dejamos una línea corta como mucho 1 vez por minuto.
let lastNote = 0
let disabled = false
function netNote(msg = '[mtproto] sin red, reintentando...') {
  if (disabled) return // ya desactivado (sigue con 49 MB): no ensuciar el log
  const now = Date.now()
  if (now - lastNote < 60000) return
  lastNote = now
  console.log(msg)
}
class QuietLogger extends Logger {
  constructor() { super(LogLevel.ERROR) }
  canSend() { return false } // gramjs no imprime nada por su cuenta (ni trazas con console.error)
  _log(level, message) {
    if (level !== LogLevel.ERROR && level !== LogLevel.WARN) return
    const m = String(message || '')
    if (/connect|network|ENETUNREACH|ECONN|ETIMEDOUT|EHOSTUNREACH|closed|Not connected|reconnect/i.test(m)) netNote()
    else netNote('[mtproto] aviso: ' + m.slice(0, 120))
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = path.join(__dirname, '..', 'data', '.mtproto-session')
export const MTPROTO_MAX_SEND = 1950 * 1024 * 1024

let client = null
let ready = null

export function mtprotoConfigured() {
  const id = Number(process.env.TELEGRAM_API_ID)
  return !disabled && Number.isInteger(id) && id > 0 && !!String(process.env.TELEGRAM_API_HASH || '').trim() &&
    String(process.env.MTPROTO_UPLOAD || 'true').toLowerCase() !== 'false'
}

export function mtprotoReady() { return !!client && !disabled }

// Conecta una sola vez y guarda la sesión (así no vuelve a iniciar sesión en cada arranque).
export async function initMtproto(botToken) {
  if (!mtprotoConfigured()) return false
  if (ready) return ready
  ready = (async () => {
    try {
      let saved = ''
      try { saved = fs.readFileSync(SESSION_FILE, 'utf8').trim() } catch {}
      const c = new TelegramClient(new StringSession(saved), Number(process.env.TELEGRAM_API_ID),
        String(process.env.TELEGRAM_API_HASH).trim(), {
          // TCP (no WebSocket) por el puerto 443: en Node gramjs usa sockets TCP siempre; useWSS:true
          // solo cambia el puerto 80 → 443 (muchas compañías bloquean el 80). Obfuscated evita bloqueos por DPI.
          connection: ConnectionTCPObfuscated, useWSS: true,
          connectionRetries: 5, retryDelay: 5000, autoReconnect: true, reconnectRetries: Infinity,
          requestRetries: 5, timeout: 20,
          baseLogger: new QuietLogger()
        })
      c._errorHandler = async () => { netNote() }
      await Promise.race([
        c.start({ botAuthToken: botToken }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo de conexión agotado')), 60000))
      ]).catch(async (e) => { disabled = true; try { await c.disconnect() } catch {} ; try { await c.destroy() } catch {} ; throw e })
      try {
        fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
        fs.writeFileSync(SESSION_FILE, c.session.save(), { mode: 0o600 })
      } catch {}
      client = c
      console.log('[mtproto] listo: archivos hasta ~1950 MB')
      return true
    } catch (e) {
      console.error('[mtproto] no se pudo conectar, sigo con 49 MB:', String(e?.message || e).slice(0, 200))
      disabled = true
      return false
    }
  })()
  return ready
}

// Antes de cada subida grande: asegura conexión (máx. ~60 s); si no, el bot usa partes de 49 MB.
async function ensureConnected(maxMs = 60000) {
  if (!client) throw new Error('MTProto no está listo')
  if (client.connected) return
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    try {
      await Promise.race([client.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))])
      if (client.connected) return
    } catch { netNote() }
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error('sin conexión MTProto')
}

// Bot API → peer MTProto. En privados y grupos normales, el mensaje del usuario trae su access_hash.
async function resolvePeer(chatId, msgId) {
  const id = Number(chatId)
  try { return await client.getInputEntity(id) } catch {}
  if (id > 0 && msgId) {
    try {
      await client.invoke(new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: Number(msgId) })] }))
      return await client.getInputEntity(id)
    } catch {}
  }
  if (id < 0 && !String(id).startsWith('-100')) return new Api.InputPeerChat({ chatId: BigInt(-id) })
  if (String(id).startsWith('-100')) {
    const channelId = BigInt(String(id).slice(4))
    try {
      const r = await client.invoke(new Api.channels.GetChannels({ id: [new Api.InputChannel({ channelId, accessHash: BigInt(0) })] }))
      const ch = r.chats?.[0]
      if (ch) return new Api.InputPeerChannel({ channelId: ch.id, accessHash: ch.accessHash })
    } catch {}
  }
  throw new Error('no encontré el chat para MTProto')
}

function probe(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: 20000 })
    const j = JSON.parse(r.stdout || '{}')
    const st = j.streams?.[0] || {}
    return { duration: Math.round(Number(j.format?.duration) || 0), w: Number(st.width) || 0, h: Number(st.height) || 0 }
  } catch { return { duration: 0, w: 0, h: 0 } }
}

// Manda un archivo grande. kind: 'video' | 'audio' | 'document'
// Subida con vigilante: si no avanza en 120 s (p. ej. "sender already has some hanging states" tras un corte
// de red), se corta, se reconecta y se reintenta 1 vez; si vuelve a trabarse, falla y el bot manda en partes de 49 MB.
const STALL_MS = 120000
export async function sendBigFile(chatId, filePath, opts = {}) {
  for (let i = 0; i < 2; i++) {
    try { return await sendBigOnce(chatId, filePath, opts) } catch (e) {
      console.error(`[mtproto] subida ${i + 1}/2 falló:`, e?.message || e)
      if (i === 1 || !e?.stalled) throw e
      try { await Promise.race([client.disconnect(), new Promise(r => setTimeout(r, 10000))]) } catch {}
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}
async function sendBigOnce(chatId, filePath, { kind = 'document', caption = '', fileName, replyToMsgId, onProgress } = {}) {
  await ensureConnected()
  const peer = await resolvePeer(chatId, replyToMsgId)
  const name = fileName || path.basename(filePath)
  const attributes = [new Api.DocumentAttributeFilename({ fileName: name })]
  if (kind === 'video') {
    const m = probe(filePath)
    attributes.push(new Api.DocumentAttributeVideo({ duration: m.duration, w: m.w, h: m.h, supportsStreaming: true }))
  }
  let lastP = -1, lastT = Date.now(), timer
  const stall = new Promise((_, rej) => {
    timer = setInterval(() => {
      if (Date.now() - lastT > STALL_MS) { const e = new Error(`la subida no avanzó en ${STALL_MS / 1000} s`); e.stalled = true; rej(e) }
    }, 5000)
  })
  console.log(`[mtproto] subiendo ${path.basename(filePath)}…`)
  const up = client.sendFile(peer, {
    file: filePath,
    caption: String(caption || '').slice(0, 1024),
    forceDocument: kind === 'document',
    supportsStreaming: kind === 'video',
    attributes: kind === 'audio' ? undefined : attributes,
    workers: 2, // poco consumo en celulares de pocos recursos
    progressCallback: (p) => { p = Number(p); if (p > lastP) { lastP = p; lastT = Date.now() } if (onProgress) try { onProgress(p) } catch {} }
  })
  up.catch(() => {})
  try { const r = await Promise.race([up, stall]); console.log('[mtproto] subida lista'); return r } finally { clearInterval(timer) }
}
