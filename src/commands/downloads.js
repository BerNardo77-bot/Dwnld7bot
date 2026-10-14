import { findTiktokUrls, resolveTiktokUrl } from '../tt-url.js'
import fs from 'fs'
import { InputFile } from 'grammy'
import {
  argText,
  downloadToFile,
  getTiktok,
  getInstagram,
  getFacebookDownloadUrl,
  getSpotify,
  getMediafire,
  tmpPath,
  safeUnlink,
  mb,
  MAX_DOWNLOAD
} from '../api.js'

/**
 * sendOrCompress se inyecta desde index para evitar dependencia circular.
 * @param {(ctx, path, opts) => Promise<boolean>} sendOrCompress
 */
export function createDownloadHandlers(sendOrCompress) {
  async function handleTiktok(ctx) {
    const q = argText(ctx)
    if (!q) return ctx.reply('Uso: /tiktok <enlace o busca con URL de tiktok.com>')
    const urls = findTiktokUrls(q).slice(0, 1)
    if (!urls.length) return ctx.reply('Necesito un enlace de TikTok (tiktok.com, vm.tiktok.com o tt.site).')
    const status = await ctx.reply('Procesando TikTok...')
    const out = tmpPath(`${Date.now()}-tiktok.mp4`)
    try {
      const got = await getTiktok(await resolveTiktokUrl(urls[0]), { mp3: false })
      if (got.error || !got.dl) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No pude bajar el TikTok.\n' + (got.error || '')
        )
      }
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Descargando a disco...')
      await downloadToFile(got.dl, out, { timeout: 1_800_000 })
      const caption = [got.title, got.author].filter(Boolean).join(' — ')
      await sendOrCompress(ctx, out, {
        kind: 'video',
        fileName: 'tiktok.mp4',
        caption,
        statusId: status.message_id,
        fallbackLink: got.dl
      })
    } catch (e) {
      console.error('[tiktok]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
        .catch(() => ctx.reply(String(e.message)))
    } finally {
      safeUnlink(out)
    }
  }

  async function handleTiktokMp3(ctx) {
    const q = argText(ctx)
    if (!q) return ctx.reply('Uso: /tiktokmp3 <enlace TikTok>')
    const urls = findTiktokUrls(q).slice(0, 1)
    if (!urls.length) return ctx.reply('Necesito un enlace de TikTok.')
    const status = await ctx.reply('Extrayendo audio TikTok...')
    const out = tmpPath(`${Date.now()}-tiktok.mp3`)
    try {
      const got = await getTiktok(await resolveTiktokUrl(urls[0]), { mp3: true })
      if (got.error || !got.dl) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No pude bajar el audio.\n' + (got.error || '')
        )
      }
      await downloadToFile(got.dl, out)
      await sendOrCompress(ctx, out, {
        kind: 'audio',
        fileName: ((got.title || 'tiktok').slice(0, 40) || 'tiktok') + '.mp3',
        caption: got.title,
        statusId: status.message_id,
        fallbackLink: got.dl
      })
    } catch (e) {
      console.error('[tiktokmp3]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
        .catch(() => ctx.reply(String(e.message)))
    } finally {
      safeUnlink(out)
    }
  }

  async function handleInstagram(ctx) {
    const q = argText(ctx)
    if (!q) return ctx.reply('Uso: /ig <enlace Instagram (p/reel/tv)>')
    const urls = q.match(/https?:\/\/[^\s]*instagram\.com\/(p|reel|share|tv)\/[^\s]*/i)
    if (!urls.length) return ctx.reply('Enlace de Instagram no válido.')
    const status = await ctx.reply('Procesando Instagram...')
    try {
      const got = await getInstagram(urls[0])
      if (got.error || !got.downloads?.length) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No se pudo obtener el contenido.\n' + (got.error || '')
        )
      }
      const items = got.downloads.slice(0, 10)
      for (let i = 0; i < items.length; i++) {
        const media = items[i]
        const isVideo = media.type === 'video'
        const out = tmpPath(`${Date.now()}-ig-${i}.${isVideo ? 'mp4' : 'jpg'}`)
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            status.message_id,
            `Descargando ${i + 1}/${items.length}...`
          )
          await downloadToFile(media.url, out, { timeout: 1_800_000 })
          if (isVideo) {
            await sendOrCompress(ctx, out, {
              kind: 'video',
              fileName: 'instagram.mp4',
              caption: i === 0 ? 'Instagram (HD)' : undefined,
              statusId: i === items.length - 1 ? status.message_id : undefined,
              fallbackLink: media.url
            })
          } else {
            await ctx.replyWithPhoto(new InputFile(out), {
              caption: i === 0 ? 'Instagram' : undefined
            })
            if (i === items.length - 1) {
              await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
            }
          }
        } finally {
          safeUnlink(out)
        }
      }
    } catch (e) {
      console.error('[ig]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
        .catch(() => ctx.reply(String(e.message)))
    }
  }

  async function handleFacebook(ctx) {
    const q = argText(ctx)
    if (!q) return ctx.reply('Uso: /fb <enlace Facebook / fb.watch>')
    const urls = q.match(/https?:\/\/[^\s]*(facebook\.com|fb\.watch|video\.fb\.com)[^\s]*/i)
    if (!urls.length) return ctx.reply('Enlace de Facebook no válido.')
    const status = await ctx.reply('Procesando Facebook...')
    const out = tmpPath(`${Date.now()}-fb.mp4`)
    try {
      const got = await getFacebookDownloadUrl(urls[0])
      if (got.error || !got.dl) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No se pudo obtener el video.\n' + (got.error || '')
        )
      }
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `Descargando a disco (tope ${mb(MAX_DOWNLOAD)} MB)...`
      )
      await downloadToFile(got.dl, out, { timeout: 1_800_000 })
      await sendOrCompress(ctx, out, {
        kind: 'video',
        fileName: 'fb.mp4',
        caption: (got.title || 'Facebook') + ' (HD)',
        statusId: status.message_id,
        fallbackLink: got.binaryEndpoint ? undefined : got.dl
      })
    } catch (e) {
      console.error('[fb]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
        .catch(() => ctx.reply(String(e.message)))
    } finally {
      safeUnlink(out)
    }
  }

  async function handleSpotify(ctx) {
    const q = argText(ctx)
    if (!q) return ctx.reply('Uso: /spotify <nombre o URL de track>')
    const status = await ctx.reply('Buscando en Spotify...')
    const out = tmpPath(`${Date.now()}-spotify.mp3`)
    try {
      const got = await getSpotify(q)
      if (got.error || !got.dl) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No se pudo descargar.\n' + (got.error || '')
        )
      }
      const caption = [got.title, got.artist].filter(Boolean).join(' — ') + (got.source === 'youtube' ? ' (YouTube)' : '')
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, `Descargando: ${caption}`)
      await downloadToFile(got.dl, out)
      await sendOrCompress(ctx, out, {
        kind: 'audio',
        fileName: ((got.title || 'spotify').slice(0, 40) || 'spotify') + '.mp3',
        caption,
        statusId: status.message_id,
        fallbackLink: got.dl
      })
    } catch (e) {
      console.error('[spotify]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
        .catch(() => ctx.reply(String(e.message)))
    } finally {
      safeUnlink(out)
    }
  }

  async function handleMediafire(ctx) {
    const q = argText(ctx)
    if (!q) return ctx.reply('Uso: /mediafire <URL mediafire.com>')
    if (!/^https?:\/\/(www\.)?mediafire\.com/i.test(q.trim())) {
      return ctx.reply('Solo se aceptan enlaces de MediaFire.')
    }
    const status = await ctx.reply('Procesando MediaFire...')
    const out = tmpPath(`${Date.now()}-mf.bin`)
    try {
      const got = await getMediafire(q.trim())
      if (got.error || !got.download) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No se pudo obtener el archivo.\n' + (got.error || '')
        )
      }
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `Descargando ${got.filename} (${got.filesize || '?'})...`
      )
      await downloadToFile(got.download, out, { timeout: 1_800_000 })
      // rename conceptually via fileName
      const finalName = got.filename || 'mediafire.bin'
      await sendOrCompress(ctx, out, {
        kind: 'document',
        fileName: finalName,
        caption: `${got.filename}\n${got.filesize || ''} ${got.filetype || ''}`.trim(),
        statusId: status.message_id,
        fallbackLink: got.download
      })
    } catch (e) {
      console.error('[mf]', e)
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + e.message)
        .catch(() => ctx.reply(String(e.message)))
    } finally {
      safeUnlink(out)
    }
  }

  return {
    handleTiktok,
    handleTiktokMp3,
    handleInstagram,
    handleFacebook,
    handleSpotify,
    handleMediafire
  }
}
