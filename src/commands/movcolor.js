// /movcolor <color> [x] [N] — envía los 10 movimientos de Grok Bot en el color elegido (sticker .webm + GIF con su gesto).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const COLORS = { cafe: 'café', rojo: 'rojo', naranja: 'naranja', amarillo: 'amarillo', verde: 'verde', gris: 'gris', rosa: 'rosa', morado: 'morado', azul: 'azul' }
const norm = (s) => (s || '').toString().trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/)[0]
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

export async function handleGrokMovColor(ctx) {
  const c = norm(ctx.match)
  if (!COLORS[c]) return ctx.reply(`Elige un color:\n${Object.values(COLORS).map((n) => `• ${n}`).join('\n')}\n\nEjemplo: /movcolor rojo  ·  /movcolor rojo x  ·  /movcolor rojo x 3`).catch(() => {})
  const DIR = path.join(BASE, 'movimientos_' + c)
  if (!fs.existsSync(DIR)) return ctx.reply('No encontré los movimientos.').catch(() => {})
  const a = (ctx.match || '').toString().toLowerCase().split(/\s+/).slice(1)
  const x = a.includes('x')
  const n = parseInt(a.find((s) => /^\d+$/.test(s)), 10)
  const list = n >= 1 && n <= ITEMS.length ? [ITEMS[n - 1]] : ITEMS
  for (const [f, caption] of list) {
    if (x) {
      try { await ctx.replyWithDocument(new InputFile(path.join(DIR, f + '_x.gif'), 'grokbot_' + c + '_' + f + '.gif'), { caption }) } catch (e) { console.error('[movcolor]', f, e?.message) }
      await sleep(700)
      continue
    }
    try { await ctx.replyWithSticker(new InputFile(path.join(DIR, f + '.webm'), f + '.webm')) } catch (e) { console.error('[movcolor]', f, e?.message) }
    await sleep(500)
    try { await ctx.replyWithAnimation(new InputFile(path.join(DIR, f + '.mp4'), f + '.mp4'), { caption }) } catch (e) { console.error('[movcolor]', f, e?.message) }
    await sleep(800)
  }
}
