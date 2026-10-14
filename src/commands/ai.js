import fetch from 'node-fetch'
import { InputFile } from 'grammy'
import { argText, getConfig, errText } from '../api.js'
import { downloadTelegramFile } from '../tgapi.js'

const FALLBACK_KEY = 'LUFFY-FIX67'
const NANO_API = 'https://api-faa.my.id/faa/nano-banana'
const OMEGA_EDIT = 'https://omegatech-api.dixonomega.tech/api/ai/nano-banana'
const OMEGA_TXT = 'https://omegatech-api.dixonomega.tech/api/ai/nano-banana-pro'

function keys() {
  const { apiKey } = getConfig()
  const list = [apiKey].filter(Boolean)
  if (!list.includes(FALLBACK_KEY)) list.push(FALLBACK_KEY)
  return list
}

function extractAiText(json) {
  if (!json) return ''
  const v =
    json.result ??
    json.response ??
    json.data?.result ??
    json.data?.response ??
    json.message
  if (typeof v === 'string') return v.trim()
  if (v != null) return String(v).trim()
  return ''
}

async function runAiChat(ctx, { label, endpoint, usage }) {
  const q = argText(ctx)
  if (!q) {
    return ctx.reply(usage || `Uso: /${endpoint} tu pregunta`)
  }

  const { apiUrl } = getConfig()
  const status = await ctx.reply(`✎ *${label}* está pensando...`, { parse_mode: 'Markdown' })
  let last = 'Sin respuesta'

  try {
    for (const key of keys()) {
      try {
        const url = `${apiUrl}/ai/${endpoint}?text=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
        const res = await fetch(url, { signal: AbortSignal.timeout(90000) })
        const json = await res.json().catch(() => ({}))
        const out = extractAiText(json)
        if (json?.status && out) {
          await ctx.api.editMessageText(ctx.chat.id, status.message_id, out.slice(0, 4000))
          return
        }
        last = json?.message || last
      } catch (e) {
        last = e.message || last
      }
    }
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      `✎ No pude obtener respuesta de ${label}.\n${last}`
    )
  } catch (e) {
    console.error(`[ai/${endpoint}]`, e)
    await ctx.api
      .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e))
      .catch(() => {})
  }
}

export async function handleIa(ctx) {
  return runAiChat(ctx, {
    label: 'ChatGPT',
    endpoint: 'chatgpt',
    usage: 'Uso: /ia tu pregunta\nAlias: /chatgpt /gpt'
  })
}

export async function handleGemini(ctx) {
  return runAiChat(ctx, {
    label: 'Gemini',
    endpoint: 'gemini',
    usage: 'Uso: /gemini tu pregunta\nAlias: /geminis'
  })
}

export async function handleDeepseek(ctx) {
  return runAiChat(ctx, {
    label: 'DeepSeek',
    endpoint: 'deepseek',
    usage: 'Uso: /deepseek tu pregunta\nAlias: /ds'
  })
}

export async function handleGrok(ctx) {
  return runAiChat(ctx, {
    label: 'Grok',
    endpoint: 'grok',
    usage: 'Uso: /grok tu pregunta'
  })
}

async function uploadToUguu(buffer, filename = 'image.jpg') {
  const form = new FormData()
  const blob = new Blob([buffer], { type: 'image/jpeg' })
  form.append('files[]', blob, filename)
  const res = await fetch('https://uguu.se/upload.php', { method: 'POST', body: form })
  const json = await res.json().catch(() => ({}))
  return json.files?.[0]?.url || null
}

async function downloadTelegramPhoto(ctx) {
  const msg = ctx.message
  const reply = msg?.reply_to_message
  let photos = reply?.photo || msg?.photo
  // also accept document image
  const doc = reply?.document || msg?.document
  let fileId = null
  if (photos?.length) {
    fileId = photos[photos.length - 1].file_id
  } else if (doc?.mime_type?.startsWith('image/')) {
    fileId = doc.file_id
  }
  if (!fileId) return null
  const file = await ctx.api.getFile(fileId)
  if (!file?.file_path) return null
  try {
    return await downloadTelegramFile(file, process.env.TELEGRAM_BOT_TOKEN)
  } catch (e) {
    console.error('[ai] foto telegram', e?.message || e)
    return null
  }
}

async function fetchEditBuffer(imageUrl, prompt) {
  const qs = `url=${encodeURIComponent(imageUrl)}&prompt=${encodeURIComponent(prompt)}`
  try {
    const res = await fetch(`${NANO_API}?${qs}`, { signal: AbortSignal.timeout(120000) })
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      const ct = String(res.headers.get('content-type') || '')
      if ((ct.startsWith('image/') || buf[0] === 0x89 || buf[0] === 0xff) && buf.length > 256) {
        return buf
      }
    }
  } catch (e) {
    console.error('[nano] api-faa', e?.message || e)
  }
  try {
    const res = await fetch(`${OMEGA_EDIT}?${qs}`, { signal: AbortSignal.timeout(120000) })
    const ct = String(res.headers.get('content-type') || '')
    const buf = Buffer.from(await res.arrayBuffer())
    if (ct.startsWith('image/') && buf.length > 256) return buf
    try {
      const json = JSON.parse(buf.toString('utf8'))
      const out = json?.image || json?.url || json?.result || json?.data?.image || json?.data?.url
      if (typeof out === 'string' && /^https?:\/\//i.test(out)) {
        const img = await fetch(out, { signal: AbortSignal.timeout(60000) })
        if (img.ok) {
          const ib = Buffer.from(await img.arrayBuffer())
          if (ib.length > 256) return ib
        }
      }
    } catch {}
  } catch (e) {
    console.error('[nano] omega-edit', e?.message || e)
  }
  return null
}

async function fetchTextToImage(prompt) {
  // 1) Omega NanoBanana Pro
  try {
    const res = await fetch(`${OMEGA_TXT}?prompt=${encodeURIComponent(prompt)}`, {
      signal: AbortSignal.timeout(20000)
    })
    const json = await res.json().catch(() => ({}))
    const out = json?.image || json?.url || json?.result || json?.data?.image
    console.log('[nano] omega-txt status', res.status, Boolean(out))
    if (typeof out === 'string' && /^https?:\/\//i.test(out)) {
      const img = await fetch(out, { signal: AbortSignal.timeout(60000) })
      if (img.ok) {
        const ib = Buffer.from(await img.arrayBuffer())
        if (ib.length > 256) return ib
      }
    }
  } catch (e) {
    console.error('[nano] omega-txt', e?.message || e)
  }

  // 2) Pollinations (texto -> imagen, fiable)
  try {
    const url =
      'https://image.pollinations.ai/prompt/' +
      encodeURIComponent(prompt + ', high quality') +
      '?width=768&height=768&nologo=true&safe=false'
    const res = await fetch(url, { signal: AbortSignal.timeout(90000) })
    console.log('[nano] pollinations', res.status)
    if (res.ok) {
      const ib = Buffer.from(await res.arrayBuffer())
      if (ib.length > 256 && (ib[0] === 0xff || ib[0] === 0x89)) return ib
    }
  } catch (e) {
    console.error('[nano] pollinations', e?.message || e)
  }
  return null
}

export async function handleNano(ctx) {
  console.log('[nano] enter', Boolean(ctx.message?.reply_to_message?.photo), Boolean(ctx.message?.photo))
  let prompt = argText(ctx)
  // caption: /nano prompt
  if (!prompt && ctx.message?.caption) {
    const parts = String(ctx.message.caption).trim().split(/\s+/)
    prompt = parts.slice(1).join(' ').trim()
  }
  if (!prompt) {
    return ctx.reply(
      'Uso: responde a una foto con /nano <descripcion>\nEjemplo: /nano hazla estilo anime\nAlias: /nanobanana\nSin foto: genera desde el texto.'
    )
  }

  let status
  try {
    status = await ctx.reply('NanoBanana trabajando...')
  } catch (e) {
    console.error('[nano] reply status failed', e)
    return
  }

  try {
    const photoBuf = await downloadTelegramPhoto(ctx)
    let result = null

    if (photoBuf?.length) {
      console.log('[nano] photo bytes', photoBuf.length)
      const uploaded = await uploadToUguu(photoBuf)
      console.log('[nano] uguu', uploaded)
      if (!uploaded) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          'No pude subir la imagen para editarla.'
        )
      }
      result = await fetchEditBuffer(uploaded, prompt)
    } else {
      await ctx.api
        .editMessageText(
          ctx.chat.id,
          status.message_id,
          'No hay imagen citada; generando desde el prompt...'
        )
        .catch(() => {})
      result = await fetchTextToImage(prompt)
    }

    if (!result) {
      return ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        'NanoBanana no devolvio una imagen. Intenta de nuevo o responde a una foto.'
      )
    }

    console.log('[nano] result bytes', result.length)
    await ctx.replyWithPhoto(new InputFile(result, 'nano.jpg'), {
      caption: `NanoBanana\n${prompt.slice(0, 200)}`
    })
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {})
  } catch (e) {
    console.error('[nano]', e)
    if (status?.message_id) {
      await ctx.api
        .editMessageText(ctx.chat.id, status.message_id, 'Error: ' + errText(e))
        .catch(() => ctx.reply('Error nano: ' + errText(e)).catch(() => {}))
    } else {
      await ctx.reply('Error nano: ' + errText(e)).catch(() => {})
    }
  }
}
