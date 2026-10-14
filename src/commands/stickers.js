import fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { InputFile } from 'grammy'
import { tmpPath, safeUnlink } from '../api.js'
import { downloadTelegramFile } from '../tgapi.js'

const execFileAsync = promisify(execFile)
const STICKER_SIZE = 512

async function imageToWebpSticker(inputBuffer, outPath) {
  const inPath = tmpPath(`${Date.now()}-sticker-in`)
  fs.writeFileSync(inPath, inputBuffer)
  try {
    try {
      const sharp = (await import('sharp')).default
      const webp = await sharp(inputBuffer)
        .rotate()
        .resize(STICKER_SIZE, STICKER_SIZE, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 90 })
        .toBuffer()
      fs.writeFileSync(outPath, webp)
      return
    } catch (e) {
      console.error('[sticker] sharp no disponible, uso ffmpeg:', e?.message || e)
    }

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inPath,
        '-vf',
        'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
        '-c:v',
        'libwebp',
        '-quality',
        '90',
        '-loop',
        '0',
        '-an',
        outPath
      ],
      { timeout: 120000 }
    )
    if (!fs.existsSync(outPath) || !fs.statSync(outPath).size) {
      throw new Error('ffmpeg no genero el webp')
    }
  } finally {
    safeUnlink(inPath)
  }
}

async function getPhotoFileId(ctx) {
  const reply = ctx.message?.reply_to_message
  if (reply?.photo?.length) {
    return reply.photo[reply.photo.length - 1].file_id
  }
  if (ctx.message?.photo?.length) {
    return ctx.message.photo[ctx.message.photo.length - 1].file_id
  }
  const doc = ctx.message?.reply_to_message?.document || ctx.message?.document
  if (doc?.mime_type?.startsWith('image/')) return doc.file_id
  return null
}

export async function handleSticker(ctx) {
  const fileId = await getPhotoFileId(ctx)
  if (!fileId) {
    return ctx.reply(
      'Uso: responde a una foto con /sticker\nO envia una foto con caption /sticker'
    )
  }

  const status = await ctx.reply('Creando sticker...')
  const out = tmpPath(`${Date.now()}-sticker.webp`)
  try {
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path) throw new Error('No se pudo obtener la foto')

    const buf = await downloadTelegramFile(file, process.env.TELEGRAM_BOT_TOKEN, { timeoutMs: 120000 })
    await imageToWebpSticker(buf, out)
    await ctx.replyWithSticker(new InputFile(out, 'sticker.webp'))
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
  } catch (e) {
    console.error('[sticker]', e)
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, 'Error sticker: ' + (e.message || e))
      .catch(() => ctx.reply(String(e.message || e)))
  } finally {
    safeUnlink(out)
  }
}

export async function handlePhotoCaption(ctx, next) {
  const caption = (ctx.message?.caption || '').trim()
  const low = caption.toLowerCase()
  if (!low.startsWith('/sticker') && !low.startsWith('/s')) {
    return next()
  }
  const cmd = caption.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '')
  if (cmd !== '/sticker' && cmd !== '/s') return next()
  return handleSticker(ctx)
}
