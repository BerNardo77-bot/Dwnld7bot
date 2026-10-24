// /movcolor <color> — envía los 22 movimientos de Grok Bot en el color elegido (sticker .webm + GIF con su gesto).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const COLORS = { cafe: 'café', rojo: 'rojo', naranja: 'naranja', amarillo: 'amarillo', verde: 'verde', gris: 'gris', rosa: 'rosa', morado: 'morado', azul: 'azul' }
const norm = (s) => (s || '').toString().trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/)[0]
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
  ['20_estrella', "Grok Bot ⭐"],
  ['21_encargandose', "Encargándose"],
  ['22_puntos', "Reflexionando al respecto"],
]

export async function handleGrokMovColor(ctx) {
  const c = norm(ctx.match)
  if (!COLORS[c]) return ctx.reply(`Elige un color:\n${Object.values(COLORS).map((n) => `• ${n}`).join('\n')}\n\nEjemplo: /movcolor rojo`).catch(() => {})
  const DIR = path.join(BASE, 'movimientos_' + c)
  if (!fs.existsSync(DIR)) return ctx.reply('No encontré los movimientos.').catch(() => {})
  for (const [f, caption] of ITEMS) {
    try { await ctx.replyWithSticker(new InputFile(path.join(DIR, f + '.webm'), f + '.webm')) } catch (e) { console.error('[movcolor]', f, e?.message) }
    await sleep(500)
    try { await ctx.replyWithAnimation(new InputFile(path.join(DIR, f + '.mp4'), f + '.mp4'), { caption }) } catch (e) { console.error('[movcolor]', f, e?.message) }
    await sleep(800)
  }
}
