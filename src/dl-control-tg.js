// Botones ❌ Cancelar / ⏸️ Pausar / ▶️ Continuar en los mensajes de progreso de descarga,
// más /cancelar, /pausar y /continuar. Solo quien inició la descarga puede usarlos.
// Importante: las actualizaciones se procesan sin esperar a que termine la anterior, si no
// el botón no llegaría hasta que acabara la descarga.
import path from 'path'
import { runJob, currentJob, getJob, activeJobs, cancelJob, pauseJob, resumeJob, outsideJob, PAUSE_MAX_MS, configurePending, takePending, markDownload, touchJob, isShuttingDown, RESTART_TEXT, noRestartText } from './dl-control.js'

// Pendientes en DATA_DIR (volumen persistente si existe) o ./data (Termux/local: sobrevive; nube sin volumen: no)
const PENDING_FILE = path.join(String(process.env.DATA_DIR || '').trim() ? path.resolve(process.env.DATA_DIR.trim()) : path.join(process.cwd(), 'data'), 'pending-downloads.json')

const PROGRESS_RE = /Bajando|Descargando|Grabando|Convirtiendo|\b\d{1,3}(?:[.,]\d+)?\s?%/i
const EDIT_METHODS = new Set(['editMessageText'])
const SEND_METHODS = new Set(['sendMessage'])
const mins = Math.round(PAUSE_MAX_MS / 60000)

const kb = (job) => ({
  inline_keyboard: [[
    job.state === 'paused'
      ? { text: '▶️ Continuar', callback_data: `dl:resume:${job.id}` }
      : { text: '⏸️ Pausar', callback_data: `dl:pause:${job.id}` },
    { text: '❌ Cancelar', callback_data: `dl:cancel:${job.id}` }
  ]]
})
const pausedText = (t) => `⏸️ Pausado (se cancela solo tras ${mins} min)\n\n${String(t || '').replace(/^⏸️ Pausado[^\n]*\n\n/, '')}`.slice(0, 4000)

function isControlText(text) {
  const cmd = String(text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase()
  return ['/cancelar', '/cancel', '/pausar', '/pause', '/continuar', '/reanudar', '/resume'].includes(cmd) ? cmd : null
}

export function installDlControl(bot) {
  configurePending(PENDING_FILE)
  // Al arrancar: avisar y volver a empezar las descargas que se cortaron por un reinicio
  const t = setInterval(() => {
    if (!bot.isInited()) return
    clearInterval(t)
    resumePending(bot).catch((e) => console.error('[dl-resume]', e?.message || e))
  }, 1500)
  t.unref?.()
  const editStatus = (job) => outsideJob(async () => {
    const s = job.status
    if (!s) return
    try {
      if (job.state === 'cancelled') await bot.api.editMessageText(s.chat_id, s.message_id, '❌ Descarga cancelada')
      else if (job.state === 'paused') await bot.api.editMessageText(s.chat_id, s.message_id, pausedText(s.text), { reply_markup: kb(job) })
      else await bot.api.editMessageText(s.chat_id, s.message_id, s.text, { reply_markup: kb(job) })
    } catch (e) { if (!/not modified/i.test(e?.description || e?.message || '')) console.error('[dl-control] edit', e?.description || e?.message) }
  })
  const notifyCancel = (job, reason) => outsideJob(async () => {
    if (job.status) return editStatus(job)
    if (job.chat) try { await bot.api.sendMessage(job.chat, reason && reason !== 'usuario' ? `❌ Descarga cancelada (${reason})` : '❌ Descarga cancelada') } catch {}
  })

  // Transformer: agrega los botones a los mensajes de progreso y silencia el trabajo cancelado
  bot.api.config.use(async (prev, method, payload, signal) => {
    const job = currentJob()
    if (!job || job.skip) return prev(method, payload, signal)
    if (job.state === 'cancelled' || isShuttingDown()) {
      // ya se avisó "Descarga cancelada"; no mandar errores ni archivos a medias
      return { ok: true, result: method.startsWith('send') ? { message_id: 0, date: 0, chat: { id: payload?.chat_id || 0 } } : true }
    }
    const text = payload?.text
    const isProgress = (SEND_METHODS.has(method) || EDIT_METHODS.has(method)) && typeof text === 'string' && PROGRESS_RE.test(text) && !payload.reply_markup
    const isStatusEdit = EDIT_METHODS.has(method) && job.status && payload.message_id === job.status.message_id && String(payload.chat_id) === String(job.status.chat_id)
    if (isProgress) {
      if (job.state === 'paused') payload = { ...payload, text: pausedText(text) }
      payload = { ...payload, reply_markup: kb(job) }
    } else if (isStatusEdit) {
      job.status = null // el mensaje de progreso se convirtió en otra cosa (resultado/error)
    }
    const res = await prev(method, payload, signal)
    if (isProgress && res?.ok) {
      markDownload(job)
      const r = res.result
      if (SEND_METHODS.has(method) && r?.message_id) job.status = { chat_id: r.chat?.id ?? payload.chat_id, message_id: r.message_id, text }
      else if (EDIT_METHODS.has(method)) job.status = { chat_id: payload.chat_id, message_id: payload.message_id, text }
      touchJob(job)
    }
    if (method === 'deleteMessage' && job.status && payload.message_id === job.status.message_id) job.status = null
    return res
  })

  const act = (job, action) => {
    job.onChange = (j, st, reason) => (st === 'cancelled' ? notifyCancel(j, reason) : editStatus(j))
    if (action === 'cancel') return cancelJob(job)
    if (action === 'pause') return pauseJob(job)
    return resumeJob(job)
  }

  // Primer middleware: controles inmediatos; todo lo demás corre en su propio trabajo sin bloquear
  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data || ''
    const m = /^dl:(cancel|pause|resume):(\d+)$/.exec(data)
    if (m) {
      const job = getJob(m[2])
      if (!job || job.state === 'done' || (!job.children.size && !job.pending)) return ctx.answerCallbackQuery({ text: 'Esta descarga ya terminó.' }).catch(() => {})
      if (String(ctx.from?.id) !== job.user) return ctx.answerCallbackQuery({ text: 'Solo quien inició la descarga puede usar este botón.', show_alert: true }).catch(() => {})
      if (job.state === 'cancelled') return ctx.answerCallbackQuery({ text: 'Ya estaba cancelada.' }).catch(() => {})
      const r = act(job, m[1])
      const txt = { cancel: '❌ Descarga cancelada', pause: '⏸️ Pausado', resume: '▶️ Continuando…' }[m[1]]
      return ctx.answerCallbackQuery({ text: r.ok ? txt : (m[1] === 'pause' ? 'Ya está pausada.' : 'No está pausada.') }).catch(() => {})
    }
    const ctl = ctx.message ? isControlText(ctx.message.text) : null
    if (ctl) {
      const action = /cancel/.test(ctl) ? 'cancel' : /paus/.test(ctl) ? 'pause' : 'resume'
      const list = activeJobs(ctx.from?.id, ctx.chat?.id).filter((j) => action !== 'resume' || j.state === 'paused').filter((j) => action !== 'pause' || j.state === 'running')
      if (!list.length) {
        const msg = { cancel: 'No tienes ninguna descarga en curso.', pause: 'No tienes ninguna descarga en curso para pausar.', resume: 'No tienes ninguna descarga pausada.' }[action]
        return ctx.reply(msg).catch(() => {})
      }
      const job = list[0]
      const r = act(job, action)
      if (action === 'cancel') return // notifyCancel ya avisa
      const txt = action === 'pause' ? `⏸️ Pausado. Usa /continuar para seguir o /cancelar (se cancela solo tras ${mins} min).` : '▶️ Continuando la descarga…'
      return r.ok ? ctx.reply(txt).catch(() => {}) : undefined
    }
    const text = String(ctx.message?.text || '')
    const skip = /^\/(tv|canal|canaltv|television|tvmin|tvminutos|tvcancel|tvcancelar|cancelartv)\b/i.test(text) || /^tv[a-z]?(:|$)/.test(data)
    const msgText = ctx.message?.text || ''
    const replay = /^\/|https?:\/\//i.test(msgText.trim()) ? msgText.trim() : null
    const meta = ctx.from && ctx.chat ? { chatType: ctx.chat.type, firstName: ctx.from.first_name || '', msgId: ctx.message?.message_id || ctx.callbackQuery?.message?.message_id || 0 } : null
    const task = runJob({ user: ctx.from?.id, chat: ctx.chat?.id, skip, replay, meta, restarts: ctx.update?.__dlRestarts }, () => next())
    task.catch((e) => {
      console.error('[handler]', e?.error || e?.message || e)
    })
  })
}

async function resumePending(bot) {
  const list = takePending()
  if (!list.length) return
  console.log(`[dl-resume] ${list.length} descarga(s) cortadas por reinicio`)
  for (const e of list) {
    const text = e.ok ? RESTART_TEXT : noRestartText(e.reason)
    let edited = false
    if (e.status?.message_id) {
      try { await bot.api.editMessageText(e.status.chat_id, e.status.message_id, text); edited = true } catch {}
    }
    if (!edited) {
      try { await bot.api.sendMessage(e.chat, text, e.meta?.msgId ? { reply_parameters: { message_id: e.meta.msgId, allow_sending_without_reply: true } } : {}) } catch (err) { console.error('[dl-resume] aviso', err?.description || err?.message) }
    }
    if (!e.ok) continue
    const cmdLen = e.replay.startsWith('/') ? e.replay.split(/\s/)[0].length : 0
    const update = {
      update_id: 0,
      message: {
        message_id: e.meta?.msgId || 0,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(e.chat), type: e.meta?.chatType || 'private' },
        from: { id: Number(e.user), is_bot: false, first_name: e.meta?.firstName || 'Usuario' },
        text: e.replay,
        ...(cmdLen ? { entities: [{ type: 'bot_command', offset: 0, length: cmdLen }] } : {})
      }
    }
    Object.defineProperty(update, '__dlRestarts', { value: (e.restarts || 0) + 1, enumerable: false })
    console.log(`[dl-resume] repitiendo para ${e.user}: ${e.replay.slice(0, 80)} (reinicio ${(e.restarts || 0) + 1})`)
    await bot.handleUpdate(update).catch((err) => console.error('[dl-resume] repetir', err?.message || err))
  }
}
