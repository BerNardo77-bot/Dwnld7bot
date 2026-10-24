// /movnube y /movcuadro — los 8 movimientos (sacados del video) de Grok Bot en forma de nube o cuadro (azul).
// "/movnube x" manda cada movimiento como GIF listo para X (documento).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ITEMS = [
  ['01_avanzando', "Avanzando poco a poco"],
  ['02_encogiendo', "Haciéndose pequeño"],
  ['03_mirando_arriba', "Mirando arriba"],
  ['04_girando', "Girando"],
  ['05_mirando', "Mirando alrededor"],
  ['06_ladeando', "Ladeándose"],
  ['07_aplastando', "Aplastándose"],
  ['08_ojitos', "Achicando los ojos"],
]

async function send(ctx, kind) {
  const DIR = path.join(BASE, 'formas_' + kind)
  if (!fs.existsSync(DIR)) return ctx.reply('No encontré los movimientos.').catch(() => {})
  const a = (ctx.match || '').toString().toLowerCase().split(/\s+/)
  const x = a.includes('x')
  const n = parseInt(a.find((s) => /^\d+$/.test(s)), 10)
  const list = n >= 1 && n <= ITEMS.length ? [ITEMS[n - 1]] : ITEMS
  for (const [f, caption] of list) {
    if (x) {
      try { await ctx.replyWithDocument(new InputFile(path.join(DIR, f + '_x.gif'), 'grokbot_' + kind + '_' + f + '.gif'), { caption }) } catch (e) { console.error('[movforma]', f, e?.message) }
      await sleep(700)
      continue
    }
    try { await ctx.replyWithSticker(new InputFile(path.join(DIR, f + '.webm'), f + '.webm')) } catch (e) { console.error('[movforma]', f, e?.message) }
    await sleep(500)
    try { await ctx.replyWithAnimation(new InputFile(path.join(DIR, f + '.mp4'), f + '.mp4'), { caption }) } catch (e) { console.error('[movforma]', f, e?.message) }
    await sleep(800)
  }
}
export const handleGrokMovNube = (ctx) => send(ctx, 'nube')
export const handleGrokMovCuadro = (ctx) => send(ctx, 'cuadro')
