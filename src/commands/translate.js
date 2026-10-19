// /traducir /traduce /tr /translate
// • Respondiendo a una nota de voz, audio o video (o mandándolo con el comando de pie de foto):
//   lo pasa a texto, lo traduce y regresa texto + nota de voz de la traducción.
// • Respondiendo a una foto/captura/imagen como archivo/sticker (o con el comando de pie de foto): OCR y traducción.
// • Con texto (o respondiendo a un texto): traduce el texto.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { InputFile } from 'grammy'
import { translateText } from '../api.js'
import { downloadTelegramFileTo } from '../tgapi.js'
import { imageTranslate } from '../ocr-core.js'
import { vtPronounce, voiceTranslate, vtMessages, vtCleanup, vtHms, vtEstimate, vtErrorText, vtUsage, parseVoiceArgs, vtTranslate, vtLangName, vtLangList, VT_MAX_SEC } from '../voice-translate-core.js'

export const TRANSLATE_COMMANDS = ['traducir', 'traduce', 'tr', 'translate', 'traductor']
const jobs = new Map()

function mediaOf(m) {
  if (!m) return null
  // Imágenes: foto (la más grande), archivo de imagen, o sticker normal
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = m.photo[m.photo.length - 1]
    return { fileId: p.file_id, size: Number(p.file_size || 0), mime: 'image/jpeg', image: true }
  }
  if (/^image\//.test(m.document?.mime_type || '')) return { fileId: m.document.file_id, size: Number(m.document.file_size || 0), mime: m.document.mime_type, image: true }
  if (m.sticker && !m.sticker.is_animated && !m.sticker.is_video) return { fileId: m.sticker.file_id, size: Number(m.sticker.file_size || 0), mime: 'image/webp', image: true }
  const v = m.voice || m.audio || m.video_note || m.video || (/^(audio|video)\//.test(m.document?.mime_type || '') ? m.document : null)
  if (!v?.file_id) return null
  return { fileId: v.file_id, seconds: Number(v.duration || 0), size: Number(v.file_size || 0), mime: v.mime_type || (m.voice ? 'audio/ogg' : m.video_note ? 'video/mp4' : '') }
}

function argsOf(ctx) {
  const raw = String(ctx.message?.text || ctx.message?.caption || '')
  return raw.replace(/^\/\S+\s*/, '').trim()
}

async function textMode(ctx, raw) {
  const words = raw.split(/\s+/).filter(Boolean)
  const first = parseVoiceArgs(words[0] || '')
  let target = first.target
  let text = target ? words.slice(1).join(' ') : words.join(' ')
  const rt = ctx.message?.reply_to_message
  if (!text && (rt?.text || rt?.caption)) text = rt.text || rt.caption
  if (!text) return ctx.reply(vtUsage('/').replace(/\*/g, ''))
  const status = await ctx.reply('Traduciendo...')
  try {
    let r
    try {
      if (target) r = await vtTranslate(text, target)
      else {
        // Sin idioma: español → inglés, cualquier otro → español
        r = await vtTranslate(text, 'es')
        target = 'es'
        if (String(r.src || '').startsWith('es')) { r = await vtTranslate(text, 'en', 'es'); target = 'en' }
      }
    } catch (e) {
      const got = await translateText(text, target || 'es')
      if (got.error || !got.text) throw e
      r = { text: got.text }
    }
    const pron = await vtPronounce(r.text, target).catch(() => null)
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, (`🌐 ${vtLangName(target)}:\n${r.text}` + (pron ? `\n\n🗣️ Cómo se pronuncia:\n${pron}` : '')).slice(0, 4000))
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, vtErrorText(e)).catch(() => {})
  }
}

export async function handleTranslate(ctx) {
  const raw = argsOf(ctx)
  const media = mediaOf(ctx.message) || mediaOf(ctx.message?.reply_to_message)
  if (!media) return textMode(ctx, raw)

  const opt = parseVoiceArgs(raw)
  if (opt.unknown) return ctx.reply(`No conozco el idioma "${opt.unknown}".\nUsa uno de estos: ${vtLangList()}\nEjemplo: /traducir en`)

  const key = String(ctx.chat.id)
  if ((jobs.get(key) || 0) >= 2) return ctx.reply('Ya estoy traduciendo en este chat. Espera a que termine.')
  jobs.set(key, (jobs.get(key) || 0) + 1)
  const replyTo = { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } }
  const long = !media.image && media.seconds > 120
  const intro = media.image ? '🖼️ Leyendo el texto de la imagen…'
    : long ? `🎙️ Escuchando el audio (${vtHms(media.seconds)})… Tardo más o menos ${vtEstimate(media.seconds)} min; aquí te voy marcando el avance.`
      + (media.seconds > VT_MAX_SEC + 60 ? `\n⚠️ Solo traduzco las primeras ${Math.round(VT_MAX_SEC / 3600)} horas.` : '')
      : '🎙️ Escuchando el audio…'
  const status = await ctx.reply(intro, replyTo)
  // Editar el mismo mensaje con el avance (máx. cada 15 s para no chocar con los límites de Telegram)
  let lastEdit = 0, lastText = ''
  const edit = (t, force = true) => {
    if (t === lastText) return
    if (!force && Date.now() - lastEdit < 15000) return
    lastEdit = Date.now(); lastText = t
    const shown = long && /%/.test(t) ? `${intro.split('\n')[0]}\n\n${t}` : t
    return ctx.api.editMessageText(ctx.chat.id, status.message_id, shown).catch(() => {})
  }
  const onStatus = (t) => edit(t, !/\d+%/.test(t))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtin-'))
  let res = null
  try {
    let file
    try { file = await ctx.api.getFile(media.fileId) } catch (e) {
      if (/too big/i.test(String(e?.description || e?.message))) throw new Error(media.image ? '🖼️ Esa imagen es muy pesada para bajarla de Telegram (máx. 20 MB). Mándala como foto (no como archivo).' : '🎙️ Ese archivo pesa más de 20 MB y Telegram no me deja bajarlo. Mándalo como nota de voz o en un formato más ligero (una nota de voz de 20 MB dura más o menos 1 a 2 horas), o pártelo en pedazos.')
      throw e
    }
    const ext = path.extname(String(file.file_path || '')).slice(0, 6) || (media.image ? '.jpg' : '.ogg')
    const input = path.join(dir, (media.image ? 'imagen' : 'audio') + ext)
    const size = await downloadTelegramFileTo(file, process.env.TELEGRAM_BOT_TOKEN, input, { timeoutMs: 30 * 60000 })
    if (!size) throw new Error(media.image ? 'No pude descargar la imagen. Mándala otra vez.' : 'No pude descargar el audio. Mándalo otra vez.')
    res = media.image
      ? await imageTranslate(input, { target: opt.target, source: opt.source, onStatus })
      : await voiceTranslate(input, { target: opt.target, source: opt.source, onStatus })
    fs.rmSync(input, { force: true })
    const out = vtMessages(res, { bold: (s) => s, maxLen: 3900 })
    for (const text of out.messages) await ctx.reply(text, replyTo)
    if (out.file) await ctx.replyWithDocument(new InputFile(Buffer.from(out.file.content, 'utf8'), out.file.name), { ...replyTo, caption: '📄 Texto completo' })
    if (res.ogg) await ctx.replyWithVoice(new InputFile(res.ogg, 'traduccion.ogg'), { ...replyTo, caption: `🔊 ${vtLangName(res.target)}` })
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
    console.log(`[traducir] ${media.image ? 'imagen' : 'voz'} ${res.source}→${res.target}`)
  } catch (e) {
    console.error('[traducir]', e?.message || e)
    const et = vtErrorText(e)
    await edit(/^(🎙️|🖼️)/.test(et) ? et : et + '\n\nTip: si el idioma salió mal, dile cuál es, por ejemplo: /traducir es>en o /traducir pt>es')
  } finally {
    vtCleanup(res?.dir)
    vtCleanup(dir)
    const n = (jobs.get(key) || 1) - 1
    if (n <= 0) jobs.delete(key); else jobs.set(key, n)
  }
}
