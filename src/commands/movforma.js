// /movnube y /movcuadro — los 22 movimientos de Grok Bot en forma de nube o cuadro (azul).
// "/movnube x" manda cada movimiento como GIF listo para X (documento).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ITEMS = [
  ['01_mirando', "Mirando..."],
  ['02_girando', "¿Quién?"],
  ['03_girando_diagonal', "Pensándolo bien"],
  ['04_clics', "Buscando..."],
  ['05_parpadeo', "¿Mande?"],
  ['06_avanzando', "Trabajando en eso"],
  ['07_pensando', "Pensando..."],
  ['08_dormido', "Tengo sueño"],
  ['09_sorprendido', "¡¿Qué?!"],
  ['10_nervioso', "Nervioso"],
  ['11_triste', "Triste"],
  ['12_guino', "¡Guiño!"],
  ['13_entrecerrar', "Entrecerrando los ojos"],
  ['14_lado_a_lado', "Haciéndolo"],
  ['15_latido', "Encargándose"],
  ['16_brincando', "Brincando"],
  ['17_vueltas', "Dándole vueltas al asunto"],
  ['18_sacandolo', "Sacándolo adelante"],
  ['19_vuelta', "Dando la vuelta"],
  ['20_original', "Avanzando poco a poco"],
  ['21_encargandose', "Encargándose"],
  ['22_puntos', "Reflexionando al respecto"],
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
