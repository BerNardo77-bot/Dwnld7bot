// /movimientos — envía los 12 movimientos de Grok Bot (sticker .webm + GIF con su gesto).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/movimientos')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ITEMS = [
  ['01_mirando', "Mirando..."],
  ['02_girando', "¿Quién?"],
  ['03_girando_diagonal', "Pensándolo bien"],
  ['04_clics', "Buscando..."],
  ['05_parpadeo', "¿Mande?"],
  ['06_avanzando', "Avanzando poco a poco"],
  ['07_pensando', "Pensando..."],
  ['08_dormido', "Tengo sueño"],
  ['09_sorprendido', "¡¿Qué?!"],
  ['10_nervioso', "Nervioso"],
  ['11_triste', "Triste"],
  ['12_guino', "¡Guiño!"],
]

export async function handleGrokMovimientos(ctx) {
  if (!fs.existsSync(DIR)) return ctx.reply('No encontré los movimientos.').catch(() => {})
  for (const [f, caption] of ITEMS) {
    try { await ctx.replyWithSticker(new InputFile(path.join(DIR, f + '.webm'), f + '.webm')) } catch (e) { console.error('[movimientos]', f, e?.message) }
    await sleep(500)
    try { await ctx.replyWithAnimation(new InputFile(path.join(DIR, f + '.mp4'), f + '.mp4'), { caption }) } catch (e) { console.error('[movimientos]', f, e?.message) }
    await sleep(800)
  }
}
