// /gifs — envía los 8 GIFs de Grok Bot (MP4 como animación).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { InputFile } from 'grammy'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/gifs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function handleGrokGifs(ctx) {
  let files = []
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mp4')).sort() } catch {}
  if (!files.length) return ctx.reply('No encontré los gifs.').catch(() => {})
  for (const f of files) {
    const caption = f.replace(/^\d+_/, '').replace(/\.mp4$/, '')
    try { await ctx.replyWithAnimation(new InputFile(path.join(DIR, f), f), { caption }) } catch (e) { console.error('[gifs]', f, e?.message) }
    await sleep(800)
  }
}
