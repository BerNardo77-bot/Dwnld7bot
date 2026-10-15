// /mapa <lugar | lat,lon | link de Google Maps> → ubicación (sendVenue) + link de Google Maps
import { geocode, parseInput, mapsLink, placeLine } from '../maps-core.js'
import { markList, lastList } from './music.js'

export const MAPA_COMMANDS = ['mapa', 'maps', 'ubicacion', 'map']
const lists = new Map()
const TTL = 5 * 60 * 1000

async function enviar(ctx, p) {
  await ctx.replyWithVenue(p.lat, p.lon, p.name.slice(0, 100), (p.address || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`).slice(0, 200)).catch(() => ctx.replyWithLocation(p.lat, p.lon))
  await ctx.reply(`📍 ${p.name}${p.address ? `\n${p.address}` : ''}\n🗺 ${mapsLink(p.lat, p.lon)}`, { link_preview_options: { is_disabled: true } })
}

export async function handleMapa(ctx) {
  const q = String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim()
  if (!q) return ctx.reply('🗺 Uso: /mapa <lugar>\nEjemplos: /mapa Zócalo CDMX · /mapa 19.4326,-99.1332 · /mapa <link de Google Maps>')
  try {
    const inp = await parseInput(q)
    if (inp.kind === 'point') return await enviar(ctx, inp.place)
    if (inp.kind === 'bad') return ctx.reply('No entendí ese link de Google Maps. Mándame el nombre del lugar o las coordenadas (ej. 19.43,-99.13).')
    const list = await geocode(inp.q, 10)
    if (!list.length) return ctx.reply(`No encontré "${inp.q}" en el mapa. Prueba agregando la ciudad o el país.`)
    if (list.length === 1) return await enviar(ctx, list[0])
    lists.set(String(ctx.chat.id), { items: list, until: Date.now() + TTL })
    markList(ctx.chat.id, 'mapa')
    const rows = []
    for (let s = 0; s < list.length; s += 5) rows.push(list.slice(s, s + 5).map((_, j) => ({ text: String(s + j + 1), callback_data: `map:${s + j + 1}` })))
    await ctx.reply(`🗺 Mapa › ${inp.q}\n\n${list.map(placeLine).join('\n')}\n\n✎ Toca un botón o responde el número (1-${list.length}) · vale 5 min`, { reply_markup: { inline_keyboard: rows } })
  } catch (e) {
    console.error('[mapa]', e?.message || e)
    await ctx.reply('El mapa no responde ahora. Intenta en un momento.')
  }
}

async function pick(ctx, n) {
  const l = lists.get(String(ctx.chat.id))
  if (!l || Date.now() > l.until) return false
  if (n < 1 || n > l.items.length) { await ctx.reply(`Elige un número del 1 al ${l.items.length}.`); return true }
  await enviar(ctx, l.items[n - 1])
  return true
}

export function registerMapa(bot) {
  bot.callbackQuery(/^map:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    try { if (!(await pick(ctx, Number(ctx.match[1])))) await ctx.reply('Esa lista ya venció (5 min). Busca otra vez con /mapa.') } catch (e) { console.error('[mapa]', e?.message || e) }
  })
  bot.hears(/^\s*(\d{1,2})\s*$/, async (ctx, next) => {
    const k = String(ctx.chat?.id)
    if (lastList.get(k) !== 'mapa' || !lists.has(k)) return next()
    try { if (!(await pick(ctx, Number(ctx.match[1])))) return next() } catch (e) { console.error('[mapa]', e?.message || e) }
  })
}
