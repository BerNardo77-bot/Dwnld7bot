// /movcian — envía los 10 movimientos de Grok Bot en cian (sticker .webm + GIF con su gesto).
// "/movcian x" manda cada uno como GIF listo para X (documento); "/movcian N" solo ese.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/movimientos_cian')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ITEMS = [
  ['01_mirando', "Mirando alrededor"],
  ['02_encogiendo', "Haciéndose pequeño"],
  ['03_girando', "Girando"],
  ['04_vuelta', "Dando la vuelta"],
  ['05_parpadeo', "Parpadeando"],
  ['06_mirando_arriba', "Mirando arriba"],
  ['07_ladeando', "Ladeándose"],
  ['08_volteando', "Volteando"],
  ['09_puntos', "Reflexionando al respecto"],
  ['20_estrella', "Grok Bot ⭐"],
]

export async function handleGrokMovCian(ctx) {
  if (!fs.existsSync(DIR)) return ctx.reply('No encontré los movimientos.').catch(() => {})
  const a = (ctx.match || '').toString().toLowerCase().split(/\s+/)
  const x = a.includes('x')
  const n = parseInt(a.find((s) => /^\d+$/.test(s)), 10)
  const list = n >= 1 && n <= ITEMS.length ? [ITEMS[n - 1]] : ITEMS
  for (const [f, caption] of list) {
    if (x) {
      try { await ctx.replyWithDocument(new InputFile(path.join(DIR, f + '_x.gif'), 'grokbot_cian_' + f + '.gif'), { caption }) } catch (e) { console.error('[movcian]', f, e?.message) }
      await sleep(700)
      continue
    }
    try { await ctx.replyWithSticker(new InputFile(path.join(DIR, f + '.webm'), f + '.webm')) } catch (e) { console.error('[movcian]', f, e?.message) }
    await sleep(500)
    try { await ctx.replyWithAnimation(new InputFile(path.join(DIR, f + '.mp4'), f + '.mp4'), { caption }) } catch (e) { console.error('[movcian]', f, e?.message) }
    await sleep(800)
  }
}
