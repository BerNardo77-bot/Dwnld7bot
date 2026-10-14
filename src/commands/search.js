import fetch from 'node-fetch'
import { InputFile } from 'grammy'
import { argText, getConfig, errText, isNsfwEnabled, sendLimit, downloadToFile, tmpPath, safeUnlink, mb } from '../api.js'
import fs from 'fs'
import { offerOversize } from '../oversize.js'
import { chatOf } from '../store.js'
import { buscarImagen } from '../imagenWeb.js'
import { miniaturaYouTube, bajarImagen } from '../ytMiniatura.js'

const FALLBACK_KEY = 'LUFFY-FIX67'
// /ytsearch: cuántos resultados se mandan (cada uno es un mensaje con su miniatura) y pausa entre envíos
const MAX_RESULTADOS = 10
const PAUSA_MS = 700
const CAPTION_MAX = 1024 // límite de Telegram para pies de foto

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

// Reintenta una vez si Telegram responde 429 (demasiadas peticiones)
async function conReintento(fn) {
  try {
    return await fn()
  } catch (e) {
    const wait = Number(e?.parameters?.retry_after || e?.error?.parameters?.retry_after)
    if (e?.error_code === 429 && wait > 0 && wait <= 30) {
      await esperar(wait * 1000 + 250)
      return await fn()
    }
    throw e
  }
}

function text(ctx) {
  return argText(ctx)
}

function apiKeys() {
  const { apiKey } = getConfig()
  let key = (apiKey || '').trim()
  if (!key || key === 'TU-API-KEY' || key === 'undefined') key = FALLBACK_KEY
  const keys = [key]
  if (key !== FALLBACK_KEY) keys.push(FALLBACK_KEY)
  return keys
}

function apiBase() {
  return getConfig().apiUrl
}

export async function handleWiki(ctx) {
  const q = text(ctx)
  if (!q) return ctx.reply('Uso: /wiki <tema>\nEjemplo: /wiki Albert Einstein')
  const status = await ctx.reply('Buscando en Wikipedia...')
  try {
    const searchUrl =
      `https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=` +
      `${encodeURIComponent(q)}&format=json&utf8=1&srlimit=5`
    const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Dwnld7bot/1.0' } })
    const json = await res.json().catch(() => ({}))
    const results = json?.query?.search || []
    if (!results.length) {
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, `Sin resultados en Wikipedia para ${q}`)
    }

    const best = results[0]
    const extractUrl =
      `https://es.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=0&explaintext=1` +
      `&redirects=1&format=json&titles=${encodeURIComponent(best.title)}`
    const res2 = await fetch(extractUrl, { headers: { 'User-Agent': 'Dwnld7bot/1.0' } })
    const json2 = await res2.json().catch(() => ({}))
    const pages = json2?.query?.pages || {}
    const page = Object.values(pages)[0] || {}
    const title = page.title || best.title
    let extract = String(page.extract || '').trim()
    if (!extract) extract = String(best.snippet || '').replace(/<[^>]+>/g, '')
    if (extract.length > 2800) extract = extract.slice(0, 2800).trim() + '…'
    const link = `https://es.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

    let mainMsg =
      `Wikipedia\n> ${q}\n\n` +
      `${title}\n\n` +
      `${extract || '(sin extracto)'}\n\n` +
      `Articulo completo:\n${link}`
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, mainMsg.slice(0, 3900))

    if (results.length > 1) {
      let more = `Otras coincidencias\n\n`
      for (const r of results.slice(1, 5)) {
        const snippet = String(r.snippet || '').replace(/<[^>]+>/g, '')
        const rlink = `https://es.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`
        more += `• ${r.title}\n${snippet}\n${rlink}\n\n`
      }
      await ctx.reply(more.trim().slice(0, 3900))
    }
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e)).catch(() => {})
  }
}

export async function handleImagen(ctx) {
  const q = text(ctx)
  if (!q) return ctx.reply('Uso: /imagen <tema>\nEjemplo: /imagen gato')

  const banned = ['xxx', 'porn', 'porno', 'xnxx', 'xvideos', 'onlyfans', 'hentai']
  const chat = chatOf(ctx)
  const nsfwOn = isNsfwEnabled() && (chat?.nsfw === 1 || chat?.nsfw === true || chat?.nsfw === 'enable')
  if (!nsfwOn && banned.some((w) => q.toLowerCase().includes(w))) {
    return ctx.reply('Este comando no permite busquedas NSFW (activa /rpg nsfw o NSFW_ENABLED).')
  }

  const status = await ctx.reply('Buscando imagen...')
  try {
    // Descarga la imagen y valida que sea JPEG/PNG real antes de mandarla (varias fuentes de respaldo)
    const img = await buscarImagen(q, { safe: !nsfwOn })
    if (!img) {
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, `No pude conseguir una imagen para ${q}. Prueba con otras palabras o intenta de nuevo en un momento.`)
    }
    const ext = img.mimetype === 'image/png' ? 'png' : 'jpg'
    await ctx.replyWithPhoto(new InputFile(img.buffer, `img.${ext}`), { caption: q.slice(0, CAPTION_MAX) })
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e)).catch(() => {})
  }
}

export async function handlePin(ctx) {
  const q = text(ctx)
  if (!q) return ctx.reply('Uso: /pin <tema> o /pin <link de Pinterest>')

  const base = apiBase()
  const isUrl = /^https?:\/\//i.test(q)
  const status = await ctx.reply(isUrl ? 'Descargando Pinterest...' : 'Buscando en Pinterest...')

  try {
    for (const key of apiKeys()) {
      try {
        if (isUrl) {
          const url = `${base}/dl/pinterest?url=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
          const res = await fetch(url)
          const json = await res.json().catch(() => ({}))
          const result = json?.data || json?.result
          const dl = result?.dl || result?.url
          if (!dl) continue
          const mediaType = result?.type === 'video' ? 'video' : 'image'
          if (mediaType === 'video') {
            await ctx.replyWithVideo(String(dl)).catch(async () => {
              await ctx.reply(String(dl))
            })
          } else {
            await ctx.replyWithPhoto(String(dl)).catch(async () => {
              const imgRes = await fetch(dl)
              const buf = Buffer.from(await imgRes.arrayBuffer())
              await ctx.replyWithPhoto(new InputFile(buf, 'pin.jpg'))
            })
          }
          await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
          return
        }

        const url = `${base}/search/pinterest?query=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
        const res = await fetch(url)
        const json = await res.json().catch(() => ({}))
        const results = json?.data || []
        if (!json?.status || !results.length) continue

        const top = results.slice(0, 5)
        for (const result of top) {
          const img = result.hd || result.url || result.mini
          if (!img) continue
          const caption =
            `Pinterest` +
            (result.title ? `\nTitulo: ${result.title}` : '') +
            (result.full_name ? `\nAutor: ${result.full_name}` : '') +
            (result.likes != null ? `\nLikes: ${result.likes}` : '')
          try {
            await ctx.replyWithPhoto(String(img), { caption })
          } catch {
            try {
              const imgRes = await fetch(img)
              const buf = Buffer.from(await imgRes.arrayBuffer())
              await ctx.replyWithPhoto(new InputFile(buf, 'pin.jpg'), { caption })
            } catch {}
          }
        }
        await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
        return
      } catch (e) {
        console.error('[pin]', e?.message || e)
      }
    }
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `No encontre resultados para ${q}`)
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e)).catch(() => {})
  }
}

// Pie de foto de un resultado de /ytsearch (texto plano, máx. 1024 caracteres)
function textoResultado(v, i, total) {
  const title = v.title || '?'
  const author = v.autor || v.author?.name || v.author || v.channel || ''
  const dur = v.duration || v.timestamp || ''
  // Los directos llegan con 0 vistas y sin duración: no se muestran esos campos
  const views = v.views && String(v.views) !== '0' ? v.views : ''
  const up = v.uploaded || v.ago || ''
  const link = v.url || ''
  const extra =
    (dur ? `Duracion: ${dur}\n` : '') +
    (author ? `Canal: ${author}\n` : '') +
    (views ? `Vistas: ${views}\n` : '') +
    (up ? `Subido: ${up}\n` : '') +
    `Enlace: ${link}`
  let head = `${i + 1}/${total}. ${title}\n`
  if (head.length + extra.length > CAPTION_MAX) head = head.slice(0, Math.max(20, CAPTION_MAX - extra.length - 2)) + '…\n'
  return (head + extra).slice(0, CAPTION_MAX)
}

export async function handleYtSearch(ctx) {
  const q = text(ctx)
  if (!q) return ctx.reply('Uso: /ytsearch <texto>\nEjemplo: /ytsearch quien es Anubis')

  const status = await ctx.reply('Buscando en YouTube...')
  const base = apiBase()
  let last = 'Sin resultados'

  // 1) Búsqueda: si falla aquí es que de verdad no hubo resultados
  let top = null
  for (const key of apiKeys()) {
    try {
      const url = `${base}/search/yt?query=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      const json = await res.json().catch(() => ({}))
      const list = json?.result || json?.data || []
      if (!json?.status || !Array.isArray(list) || !list.length) {
        last = json?.message || last
        continue
      }
      top = list.slice(0, MAX_RESULTADOS)
      break
    } catch (e) {
      last = e.message || last
    }
  }
  if (!top) {
    return ctx.api.editMessageText(ctx.chat.id, status.message_id, `No encontre videos para ${q}.\n${last}`).catch(() => {})
  }

  // 2) Envío: un mensaje por resultado. Miniaturas en paralelo; si una falla, ese resultado va en texto
  try {
    const miniaturas = await Promise.all(
      top.map((v) => miniaturaYouTube(v.videoId, v.url, v.banner || v.thumbnail || v.image).catch(() => null))
    )
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, `${top.length} resultado${top.length === 1 ? '' : 's'} para ${q}:`)
      .catch(() => {})

    for (let i = 0; i < top.length; i++) {
      if (i > 0) await esperar(PAUSA_MS)
      const caption = textoResultado(top[i], i, top.length)
      const thumb = miniaturas[i]
      if (thumb) {
        try {
          await conReintento(() => ctx.replyWithPhoto(new InputFile(thumb.buffer, `yt${i + 1}.jpg`), { caption }))
          continue
        } catch (e) {
          console.error(`[ytsearch] miniatura ${i + 1} no enviada, mando texto:`, errText(e))
        }
      }
      try {
        await conReintento(() => ctx.reply(caption))
      } catch (e) {
        console.error(`[ytsearch] resultado ${i + 1} no enviado:`, errText(e))
      }
    }
  } catch (e) {
    await ctx.reply('Error: ' + errText(e)).catch(() => {})
  }
}

export async function handleTtSearch(ctx) {
  const q = text(ctx)
  if (!q) return ctx.reply('Uso: /ttsearch <texto>\nEjemplo: /ttsearch baile')

  const status = await ctx.reply('Buscando en TikTok...')
  const base = apiBase()
  let last = 'Sin resultados'

  try {
    for (const key of apiKeys()) {
      try {
        const url = `${base}/search/tiktok?query=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
        const res = await fetch(url)
        const json = await res.json().catch(() => ({}))
        const list = json?.data || json?.result || []
        if (!json?.status || !Array.isArray(list) || !list.length) {
          last = json?.message || last
          continue
        }

        const top = list.slice(0, 5)
        let message = `TikTok Search\n> ${q}\n\n`
        top.forEach((result, index) => {
          const author = result.author || {}
          const stats = result.stats || {}
          const nick = author.nickname || author.name || '?'
          const uid = author.unique_id || author.uniqueId || author.id || ''
          const id = result.id || ''
          message += `Titulo: ${result.title || '?'}\n`
          message += `Autor: ${nick}${uid ? ` (@${uid})` : ''}\n`
          message += `Views: ${stats.views ?? '?'}\n`
          message += `Likes: ${stats.likes ?? '?'}\n`
          message += `Duracion: ${result.duration ?? '?'}\n`
          if (uid && id) {
            message += `URL: https://www.tiktok.com/@${uid}/video/${id}\n`
          } else if (result.url) {
            message += `URL: ${result.url}\n`
          }
          if (index < top.length - 1) message += `\n---\n\n`
        })
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, message.slice(0, 3500))
        return
      } catch (e) {
        last = e.message || last
      }
    }
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `No encontre resultados para ${q}.\n${last}`)
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e)).catch(() => {})
  }
}

export async function handleApk(ctx) {
  const q = text(ctx)
  if (!q) {
    return ctx.reply(
      'Uso:\n' +
        '/apk <nombre> — busca en Aptoide\n' +
        'Ejemplo: /apk WhatsApp\n\n' +
        'Si ya tienes el link .apk, abrelo en el navegador.\n' +
        `Tope de envío ahora: ${mb(sendLimit())} MB (más grande → solo link).`
    )
  }

  // Link directo de APK (no es busqueda)
  if (/^https?:\/\//i.test(q)) {
    const nameGuess = decodeURIComponent(q.split('/').pop() || 'app.apk').split('?')[0] || 'app.apk'
    await ctx.reply(
      `Link APK detectado\n\n` +
        `Archivo: ${nameGuess}\n` +
        `URL: ${q}\n\n` +
        `Tope de envío: ${mb(sendLimit())} MB.\n` +
        `Abre el link en el navegador o un gestor de descargas.\n\n` +
        `Para buscar por nombre: /apk WhatsApp`
    )
    return
  }

  const status = await ctx.reply('Buscando APK...')
  const base = apiBase()
  let last = 'Sin resultados'

  try {
    for (const key of apiKeys()) {
      try {
        const url = `${base}/search/apk?query=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
        const res = await fetch(url)
        const json = await res.json().catch(() => ({}))
        const data = json?.data
        if (!json?.status || !data?.name || !data?.dl) {
          last = json?.message || last
          continue
        }

        const info =
          `APK\n\n` +
          `Nombre: ${data.name}\n` +
          `Paquete: ${data.package || '?'}\n` +
          `Actualizacion: ${data.lastUpdated || '?'}\n` +
          `Tamano: ${data.size || '?'}\n` +
          `Link: ${data.dl}`

        await ctx.api.editMessageText(ctx.chat.id, status.message_id, info)

        const limit = sendLimit()
        const sizeTxt = String(data.size || '')
        const num = parseFloat(sizeTxt.replace(/[^0-9.]/g, ''))
        const est = Number.isFinite(num) ? num * (/gb/i.test(sizeTxt) ? 1024 : /kb/i.test(sizeTxt) ? 1 / 1024 : 1) * 1024 * 1024 : 0
        const fileName = `${String(data.name).replace(/[^\w.\- ]+/g, '').trim() || 'app'}.apk`
        if (est > limit) {
          return offerOversize(ctx, {
            size: est, kind: 'document', fileName, caption: data.name, link: String(data.dl),
            fetchFile: async (max) => { const f = tmpPath(`${Date.now()}-big.apk`); await downloadToFile(String(data.dl), f, { maxBytes: max }); return f }
          })
        }
        const out = tmpPath(`${Date.now()}-${fileName.replace(/\s+/g, '_')}`)
        const prog = await ctx.reply(`Descargando APK${est ? ` (~${mb(est)} MB)` : ''}...`)
        try {
          await downloadToFile(String(data.dl), out, { maxBytes: limit })
          const size = fs.statSync(out).size
          if (size > limit) throw new Error(`pesa ${mb(size)} MB (tope ${mb(limit)} MB)`)
          await ctx.api.editMessageText(ctx.chat.id, prog.message_id, `Subiendo APK (${mb(size)} MB)...`).catch(() => {})
          await ctx.replyWithDocument(new InputFile(out, fileName), { caption: `${data.name}.apk · ${mb(size)} MB` })
          await ctx.api.deleteMessage(ctx.chat.id, prog.message_id).catch(() => {})
        } catch (e) {
          console.error('[apk] document', errText(e))
          await ctx.api.editMessageText(ctx.chat.id, prog.message_id, `No pude enviar el APK (${errText(e).slice(0, 150)}). Usa el link de arriba.`).catch(() => {})
        } finally {
          safeUnlink(out)
        }
        return
      } catch (e) {
        last = e.message || last
      }
    }
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      `No encontre la app "${q}".\nPrueba otro nombre (ej: /apk GTA).\n${last}`
    )
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e)).catch(() => {})
  }
}

export async function handleAms(ctx) {
  const q = text(ctx)
  if (!q) return ctx.reply('Uso: /ams <cancion o artista>\nEjemplo: /ams bad bunny')

  const status = await ctx.reply('Buscando en Apple Music / iTunes...')
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=8`,
      { headers: { 'User-Agent': 'Dwnld7bot/1.0' } }
    )
    const json = await res.json().catch(() => ({}))
    const list = json?.results || []
    if (!list.length) {
      return ctx.api.editMessageText(ctx.chat.id, status.message_id, `No encontre resultados para ${q}`)
    }

    let texto = `Apple Music / iTunes: ${q}\n\n`
    list.forEach((song, i) => {
      texto += `${i + 1}. ${song.trackName || song.collectionName || '?'}\n`
      texto += `   Artista: ${song.artistName || '?'}\n`
      texto += `   Album: ${song.collectionName || '?'}\n`
      texto += `   Enlace: ${song.trackViewUrl || song.collectionViewUrl || '?'}`
      if (i !== list.length - 1) texto += `\n\n`
    })

    const first = list[0]
    const thumb = first.artworkUrl100?.replace('100x100bb', '600x600bb') || first.artworkUrl100
    // Portada descargada y validada; si falla, solo texto
    const portada = thumb ? await bajarImagen(thumb) : null
    let conFoto = false
    if (portada) {
      try {
        await ctx.replyWithPhoto(new InputFile(portada.buffer, 'portada.jpg'), { caption: texto.slice(0, CAPTION_MAX) })
        conFoto = true
      } catch (e) {
        console.error('[ams] portada', errText(e))
      }
    }
    if (conFoto) {
      if (texto.length > CAPTION_MAX) await ctx.reply(texto.slice(CAPTION_MAX, 3500)).catch(() => {})
      await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
    } else {
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, texto.slice(0, 3500))
    }
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e)).catch(() => {})
  }
}
