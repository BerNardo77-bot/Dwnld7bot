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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = path.join(__dirname, '..', 'data', '.mtproto-session')
export const MTPROTO_MAX_SEND = 1950 * 1024 * 1024

let client = null
let ready = null
let disabled = false

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
          connectionRetries: 5, useWSS: false,
          baseLogger: new Logger(LogLevel.ERROR)
        })
      await Promise.race([
        c.start({ botAuthToken: botToken }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo de conexión agotado')), 60000))
      ]).catch(async (e) => { try { await c.destroy() } catch {} ; throw e })
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
export async function sendBigFile(chatId, filePath, { kind = 'document', caption = '', fileName, replyToMsgId, onProgress } = {}) {
  if (!client) throw new Error('MTProto no está listo')
  const peer = await resolvePeer(chatId, replyToMsgId)
  const name = fileName || path.basename(filePath)
  const attributes = [new Api.DocumentAttributeFilename({ fileName: name })]
  if (kind === 'video') {
    const m = probe(filePath)
    attributes.push(new Api.DocumentAttributeVideo({ duration: m.duration, w: m.w, h: m.h, supportsStreaming: true }))
  }
  return client.sendFile(peer, {
    file: filePath,
    caption: String(caption || '').slice(0, 1024),
    forceDocument: kind === 'document',
    supportsStreaming: kind === 'video',
    attributes: kind === 'audio' ? undefined : attributes,
    workers: 2, // poco consumo en celulares de pocos recursos
    progressCallback: onProgress ? (p) => { try { onProgress(Number(p)) } catch {} } : undefined
  })
}
