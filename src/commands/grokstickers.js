// /stickers — envía los 8 stickers de Grok Bot, en orden, como stickers reales.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/stickers')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function handleGrokStickers(ctx) {
  let files = []
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.webp')).sort() } catch {}
  if (!files.length) return ctx.reply('No encontré los stickers.').catch(() => {})
  for (const f of files) {
    try { await ctx.replyWithSticker(new InputFile(path.join(DIR, f), f)) } catch (e) { console.error('[stickers]', f, e?.message) }
    await sleep(800)
  }
}
