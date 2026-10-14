import fetch from 'node-fetch'
import { getConfig, errText } from '../api.js'
import { displayName } from '../store.js'

const FALLBACK_KEY = 'LUFFY-FIX67'

function apiKeys() {
  const { apiKey } = getConfig()
  let key = (apiKey || '').trim()
  if (!key || key === 'TU-API-KEY' || key === 'undefined') key = FALLBACK_KEY
  const keys = [key]
  if (key !== FALLBACK_KEY) keys.push(FALLBACK_KEY)
  return keys
}

export const ANIME = {
  angry: 'esta enojado/a',
  bleh: 'saca la lengua',
  bored: 'esta aburrido/a',
  kisscheek: 'da un beso en la mejilla',
  clap: 'aplaude',
  coffee: 'toma cafe',
  dramatic: 'hace un drama',
  drunk: 'esta mareado/a',
  impregnate: 'mira raro',
  kiss: 'besa',
  laugh: 'se rie',
  love: 'muestra amor',
  pout: 'hace pucheros',
  punch: 'golpea',
  run: 'corre',
  sad: 'esta triste',
  scared: 'tiene miedo',
  seduce: 'intenta seducir',
  shy: 'se pone timido/a',
  sleep: 'duerme',
  smoke: 'fuma',
  spit: 'escupe',
  step: 'pisa',
  think: 'piensa',
  walk: 'camina',
  hug: 'abraza',
  kill: 'ataca',
  eat: 'come',
  wink: 'guina el ojo',
  pat: 'palmea',
  happy: 'esta feliz',
  bully: 'molesta',
  bite: 'muerde',
  blush: 'se sonroja',
  wave: 'saluda',
  bath: 'se bana',
  smug: 'sonrie de lado',
  smile: 'sonrie',
  highfive: 'choca los cinco',
  handhold: 'toma de la mano',
  cringe: 'se averguenza',
  bonk: 'da un bonk',
  cry: 'llora',
  lick: 'lame',
  slap: 'da una bofetada',
  dance: 'baila',
  cuddle: 'se acurruca',
  cold: 'tiene frio',
  sing: 'canta',
  tickle: 'hace cosquillas',
  scream: 'grita',
  push: 'empuja',
  nope: 'dice que no',
  jump: 'salta',
  heat: 'tiene calor',
  gaming: 'juega',
  draw: 'dibuja',
  call: 'llama',
  snuggle: 'se acurruca',
  blowkiss: 'lanza un beso',
  trip: 'tropieza',
  stare: 'mira fijo',
  sniff: 'olfatea',
  curious: 'esta curioso/a',
  thinkhard: 'piensa mucho',
  comfort: 'consuela',
  peek: 'espia'
}

/** Alias ES / extras (como WhatsApp) */
export const ANIME_ALIAS = {
  muak: 'kiss',
  beso: 'kisscheek',
  cafe: 'coffee',
  aburrido: 'bored',
  drama: 'dramatic',
  preg: 'impregnate',
  timido: 'shy',
  correr: 'run',
  triste: 'sad',
  amor: 'love',
  fumar: 'smoke',
  escupir: 'spit',
  pisar: 'step',
  comer: 'eat',
  nom: 'eat',
  feliz: 'happy',
  morder: 'bite',
  abrazo: 'hug',
  abrazar: 'hug',
  baile: 'dance',
  bailar: 'dance',
  cachetada: 'slap',
  bofetada: 'slap',
  llorar: 'cry',
  acurrucar: 'cuddle',
  palmadita: 'pat',
  cosquillas: 'tickle'
}

export const ANIME_COMMANDS = [...new Set([...Object.keys(ANIME), ...Object.keys(ANIME_ALIAS)])]

function targetFrom(ctx) {
  const r = ctx.message?.reply_to_message?.from
  if (r && !r.is_bot) return r
  const ent = (ctx.message?.entities || []).find((e) => e.type === 'text_mention' && e.user)
  if (ent?.user && !ent.user.is_bot) return ent.user
  return null
}

function targetName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'alguien'
}

export async function handleAnime(ctx) {
  const raw = (ctx.message?.text || '').split(/\s+/)[0].replace(/^\//, '').split('@')[0].toLowerCase()
  const cmd = ANIME_ALIAS[raw] || raw
  const verb = ANIME[cmd] || 'interactua'
  const me = displayName(ctx)
  const t = targetFrom(ctx)
  const caption = t ? `${me} ${verb} a ${targetName(t)}.` : `${me} ${verb}.`

  const { apiUrl } = getConfig()
  let last = 'sin gif'
  for (const key of apiKeys()) {
    try {
      const res = await fetch(
        `${apiUrl}/sfw/interaction?inter=${encodeURIComponent(cmd)}&key=${encodeURIComponent(key)}`
      )
      const json = await res.json().catch(() => ({}))
      const videoUrl = typeof json.result === 'string' ? json.result : json.result?.url || json.url
      if (!json.status || !videoUrl) {
        last = json.message || last
        continue
      }
      await ctx.replyWithAnimation(String(videoUrl), { caption }).catch(async () => {
        await ctx.replyWithVideo(String(videoUrl), { caption }).catch(async () => {
          await ctx.reply(`${caption}\n${videoUrl}`)
        })
      })
      return
    } catch (e) {
      last = errText(e)
      console.error('[anime]', e)
    }
  }
  await ctx.reply(`${caption}\nNo pude bajar el gif. (${last})`)
}
