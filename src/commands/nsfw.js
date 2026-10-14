import fs from 'fs'
import { InputFile } from 'grammy'
// xnxx.com / xvideos.com sin www → www (sin www el sitio da 404)
const wwwSite = (u) => String(u || '').replace(/^(?:https?:)?\/\/(?:m\.|mobile\.)?(xnxx\d*|xvideos\d*)\.com\//i, 'https://www.$1.com/')
import {
  argText,
  getBooruImageUrl,
  getRule34Image,
  getNsfwInteraction,
  getXnxxSearch,
  getXnxxDownload,
  downloadToFile,
  tmpPath,
  safeUnlink,
  mb,
  MAX_DOWNLOAD,
  isNsfwEnabled
} from '../api.js'

const captions = {
  anal: (from, to) => (from === to ? 'se la metió en el ano.' : 'se la metió en el ano a'),
  cum: (from, to) => (from === to ? 'se vino dentro de... Omitiremos eso.' : 'se vino dentro de'),
  undress: (from, to) => (from === to ? 'se está quitando la ropa' : 'le está quitando la ropa a'),
  fuck: (from, to) => (from === to ? 'se entrega al deseo' : 'se está cogiendo a'),
  spank: (from, to) => (from === to ? 'está dando una nalgada' : 'le está dando una nalgada a'),
  lickpussy: (from, to) => (from === to ? 'está lamiendo un coño' : 'le está lamiendo el coño a'),
  fap: (from, to) => (from === to ? 'se está masturbando' : 'se está masturbando pensando en'),
  grope: (from, to) => (from === to ? 'se lo está manoseando' : 'se lo está manoseando a'),
  sixnine: (from, to) => (from === to ? 'está haciendo un 69' : 'está haciendo un 69 con'),
  suckboobs: (from, to) => (from === to ? 'está chupando unas ricas tetas' : 'le está chupando las tetas a'),
  grabboobs: (from, to) => (from === to ? 'está agarrando unas tetas' : 'le está agarrando las tetas a'),
  blowjob: (from, to) => (from === to ? 'está dando una rica mamada' : 'le dio una mamada a'),
  boobjob: (from, to) => (from === to ? 'esta haciendo una rusa' : 'le está haciendo una rusa a'),
  footjob: (from, to) =>
    from === to ? 'está haciendo una paja con los pies' : 'le está haciendo una paja con los pies a',
  yuri: (from, to) => (from === to ? 'está haciendo tijeras!' : 'hizo tijeras con'),
  cummouth: (from, to) =>
    from === to ? 'está llenando la boca de alguien con cariño' : 'está llenando la boca de',
  cumshot: (from, to) =>
    from === to ? 'se la metió a alguien y ahora viene el regalo' : 'le dio un regalo sorpresa a',
  handjob: (from, to) =>
    from === to ? 'le da una paja a alguien con cariño' : 'le está haciendo una paja a',
  lickass: (from, to) => (from === to ? 'saborea un culo sin detenerse' : 'le está lamiendo el culo a'),
  lickdick: (from, to) =>
    from === to ? 'chupa con ganas un pene' : 'se la mete todo en la boca para'
}

const symbols = [
  '(⁠◠⁠‿⁠◕⁠)',
  '˃͈◡˂͈',
  '૮(˶ᵔᵕᵔ˶)ა',
  '(づ｡◕‿‿◕｡)づ',
  '(✿◡‿◡)',
  '(꒪⌓꒪)',
  '(✿✪‿✪｡)',
  '(*≧ω≦)',
  '(✧ω◕)',
  '˃ 𖥦 ˂',
  '(⌒‿⌒)',
  '(¬‿¬)',
  '(✧ω✧)',
  '✿(◕ ‿◕)✿',
  'ʕ•́ᴥ•̀ʔっ',
  '(ㅇㅅㅇ❀)',
  '(∩︵∩)',
  '(✪ω✪)',
  '(✯◕‿◕✯)',
  '(•̀ᴗ•́)و ̑̑'
]

/** baseCommand -> aliases (incluye el propio comando). Igual que WhatsApp inter.js */
export const commandAliases = {
  anal: ['anal', 'violar'],
  cum: ['cum', 'eyacular'],
  undress: ['undress', 'encuerar'],
  fuck: ['fuck', 'coger'],
  spank: ['spank', 'nalgada'],
  lickpussy: ['lickpussy', 'lameruncono'],
  fap: ['fap', 'paja'],
  grope: ['grope'],
  sixnine: ['sixnine'],
  suckboobs: ['suckboobs', 'chupartetas'],
  grabboobs: ['grabboobs'],
  blowjob: ['blowjob', 'mamar', 'bj'],
  boobjob: ['boobjob', 'rusa'],
  yuri: ['yuri', 'tijeras'],
  footjob: ['footjob'],
  cummouth: ['cummouth'],
  cumshot: ['cumshot'],
  handjob: ['handjob'],
  lickass: ['lickass', 'lamercullo'],
  lickdick: ['lickdick', 'lamerpolla']
}

export const NSFW_INTERACTION_COMMANDS = [
  ...new Set(Object.values(commandAliases).flat())
]

function getRandomSymbol() {
  return symbols[Math.floor(Math.random() * symbols.length)]
}

export function resolveInteractionCommand(cmd) {
  const c = String(cmd || '')
    .toLowerCase()
    .replace(/^\//, '')
    .split('@')[0]
  for (const [base, aliases] of Object.entries(commandAliases)) {
    if (aliases.includes(c)) return base
  }
  return c
}

function displayName(user) {
  if (!user) return 'alguien'
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  if (name) return name
  if (user.username) return user.username
  return 'alguien'
}

function buildInteractionCaption(ctx, baseCommand) {
  const from = ctx.from
  const fromName = displayName(from)
  const reply = ctx.message?.reply_to_message
  const target = reply?.from || from
  const toName = displayName(target)
  const captionText = captions[baseCommand](fromName, toName)
  if (target.id !== from.id) {
    return `${fromName} ${captionText} ${toName} ${getRandomSymbol()}.`
  }
  return `${fromName} ${captionText} ${getRandomSymbol()}.`
}

async function nsfwDisabledReply(ctx) {
  return ctx.reply('🔞 NSFW desactivado (NSFW_ENABLED=false).')
}

async function sendBooru(ctx, kind) {
  if (!isNsfwEnabled()) return nsfwDisabledReply(ctx)
  const tag = argText(ctx)
  if (!tag) return ctx.reply(`Uso: /${kind} <tag>`)
  const status = await ctx.reply(`Buscando ${kind}: ${tag}...`)
  const out = tmpPath(`${Date.now()}-${kind}.jpg`)
  try {
    const got = await getBooruImageUrl(kind, tag)
    if (got.error || !got.url) {
      return ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        'Sin resultado.\n' + (got.error || '')
      )
    }
    await downloadToFile(got.url, out, { timeout: 120000 })
    await ctx.replyWithPhoto(new InputFile(out), { caption: `${kind}: ${tag}` })
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
  } catch (e) {
    console.error(`[${kind}]`, e)
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
      .catch(() => ctx.reply(String(e.message)))
  } finally {
    safeUnlink(out)
  }
}

export async function handleDanbooru(ctx) {
  return sendBooru(ctx, 'danbooru')
}

export async function handleGelbooru(ctx) {
  return sendBooru(ctx, 'gelbooru')
}

export async function handleR34(ctx) {
  if (!isNsfwEnabled()) return nsfwDisabledReply(ctx)
  const tag = argText(ctx)
  if (!tag) return ctx.reply('Uso: /r34 <tag>')
  const status = await ctx.reply(`Buscando rule34: ${tag}...`)
  const out = tmpPath(`${Date.now()}-r34.jpg`)
  try {
    const got = await getRule34Image(tag)
    if (got.error || !got.url) {
      return ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        got.error || 'Sin resultado'
      )
    }
    await downloadToFile(got.url, out, { timeout: 120000 })
    await ctx.replyWithPhoto(new InputFile(out), { caption: `r34: ${tag}` })
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
  } catch (e) {
    console.error('[r34]', e)
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
      .catch(() => ctx.reply(String(e.message)))
  } finally {
    safeUnlink(out)
  }
}

async function sendInteractionMedia(ctx, mediaUrl, caption) {
  const out = tmpPath(`${Date.now()}-inter.mp4`)
  try {
    await downloadToFile(mediaUrl, out, { timeout: 180000 })
    const size = fs.statSync(out).size
    const input = new InputFile(out)
    // Preferir animation (gifPlayback style), luego video, luego document
    try {
      await ctx.replyWithAnimation(input, { caption })
      return
    } catch (e1) {
      console.error('[nsfw/inter] animation', e1?.message || e1)
    }
    try {
      await ctx.replyWithVideo(new InputFile(out), { caption })
      return
    } catch (e2) {
      console.error('[nsfw/inter] video', e2?.message || e2)
    }
    await ctx.replyWithDocument(new InputFile(out), { caption })
  } catch (e) {
    // URL directa si falla descarga o archivo pequeño
    console.error('[nsfw/inter] download', e?.message || e)
    try {
      await ctx.replyWithVideo(mediaUrl, { caption })
    } catch {
      try {
        await ctx.replyWithAnimation(mediaUrl, { caption })
      } catch {
        await ctx.reply(`No pude enviar el media.\n${mediaUrl}\n${e.message || e}`)
      }
    }
  } finally {
    safeUnlink(out)
  }
}

export async function handleNsfwInteraction(ctx) {
  if (!isNsfwEnabled()) return nsfwDisabledReply(ctx)
  const rawCmd = (ctx.message?.text || '')
    .trim()
    .split(/\s+/)[0]
    .replace(/^\//, '')
    .split('@')[0]
    .toLowerCase()
  const baseCommand = resolveInteractionCommand(rawCmd || ctx.match)
  if (!captions[baseCommand]) return

  const caption = buildInteractionCaption(ctx, baseCommand)
  const status = await ctx.reply(`🔞 ${baseCommand}...`)
  try {
    const got = await getNsfwInteraction(baseCommand)
    if (got.error || !got.url) {
      return ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        '《✧》 Error NSFW: ' + (got.error || 'sin resultado')
      )
    }
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
    await sendInteractionMedia(ctx, got.url, caption)
  } catch (e) {
    console.error('[nsfw/inter]', e)
    const hint = /ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(String(e?.message || e))
      ? '\n📌 La API se cayo un momento (red). Proba de nuevo en unos segundos.'
      : ''
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        status.message_id,
        `《✧》 Error NSFW: ${e?.message || e}${hint}`
      )
      .catch(() => ctx.reply(String(e?.message || e)))
  }
}

/**
 * /xnxx — search o URL. Usa sendOrCompress de index (inyectado).
 * @param {(ctx, path, opts) => Promise<boolean>} sendOrCompress
 */
export function createXnxxHandler(sendOrCompress) {
  return async function handleXnxx(ctx) {
    if (!isNsfwEnabled()) return nsfwDisabledReply(ctx)
    const q = argText(ctx)
    if (!q) return ctx.reply('✿ Ingresa el nombre de un video o una URL de XNXX.\nUso: /xnxx <query|url>')

    const status = await ctx.reply('Procesando XNXX...')
    try {
      let videoUrl = q
      let title = 'xnxx'

      if (!(q.startsWith('http') && q.includes('xnxx.com'))) {
        const found = await getXnxxSearch(q)
        if (found.error || !found.results?.length) {
          return ctx.api.editMessageText(
            ctx.chat.id,
            status.message_id,
            'No se encontro el video.\n' + (found.error || '')
          )
        }
        const pick = found.results[Math.floor(Math.random() * found.results.length)]
        videoUrl = pick.url
        title = pick.title || title
        const info =
          `- ׄ　ꕤ　ׅ　✤ ໌　۟　🅧nxx　ׅ\n` +
          `✿ Titulo :: ${pick.title || title}\n` +
          `✿ Vistas :: ${pick.views || '?'}\n` +
          `✿ Resolucion :: ${pick.resolution || '?'}\n` +
          `✿ Duracion :: ${pick.duration || '?'}\n` +
          `✿ Ver en :: ${wwwSite(pick.url)}`
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, info)
      }

      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Obteniendo enlace de descarga...')
        .catch(() => {})

      const got = await getXnxxDownload(wwwSite(videoUrl))
      if (got.error || !got.candidates?.length) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No se pudo obtener el video.\n' + (got.error || '')
        )
      }

      const out = tmpPath(`${Date.now()}-xnxx.mp4`)
      let usedLink = null
      let lastErr = ''
      try {
        for (const c of got.candidates) {
          try {
            await ctx.api
              .editMessageText(
                ctx.chat.id,
                status.message_id,
                `Bajando calidad ${c.quality} HD preferido (tope ${mb(MAX_DOWNLOAD)} MB)...`
              )
              .catch(() => {})
            await downloadToFile(c.url, out, { timeout: 1_800_000 })
            usedLink = c.url
            break
          } catch (e) {
            lastErr = e.message || String(e)
            safeUnlink(out)
            console.error('[xnxx]', c.quality, lastErr)
          }
        }

        if (!usedLink || !fs.existsSync(out)) {
          return ctx.api.editMessageText(
            ctx.chat.id,
            status.message_id,
            'Fallo la descarga.\n' + lastErr
          )
        }

        const size = fs.statSync(out).size
        await ctx.api
          .editMessageText(
            ctx.chat.id,
            status.message_id,
            `Descargado ${mb(size)} MB. Preparando envio...`
          )
          .catch(() => {})

        await sendOrCompress(ctx, out, {
          kind: 'video',
          fileName: 'xnxx.mp4',
          caption: title,
          statusId: status.message_id,
          fallbackLink: usedLink
        })
      } finally {
        safeUnlink(out)
      }
    } catch (e) {
      console.error('[xnxx]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
        .catch(() => ctx.reply(String(e.message)))
    }
  }
}
