import fs from 'fs'
import path from 'path'

const FILE = path.join(process.cwd(), 'data', 'store.json')

function emptyUser(id, name = '') {
  return {
    id: String(id),
    name: name || '',
    coins: 0,
    bank: 0,
    xp: 0,
    level: 1,
    lastDaily: 0,
    dailyStreak: 0,
    cooldowns: {},
    profile: { desc: '', birth: '', genre: '', hobbies: [] },
    marriedTo: null,
    harem: [],
    pendingRoll: null,
    pendingMath: null,
    createdAt: Date.now()
  }
}

function emptyChat(id) {
  return {
    id: String(id),
    rpg: true,
    gacha: true,
    nsfw: null,
    welcome: false,
    bye: false,
    welcomeText: 'Bienvenido/a {name}',
    byeText: 'Se fue {name}',
    warnLimit: 3,
    warns: {},
    counts: {}
  }
}

let cache = null

function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    cache = { users: {}, chats: {} }
  }
  cache.users ||= {}
  cache.chats ||= {}
  return cache
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(load(), null, 2))
}

export function userOf(ctx) {
  const db = load()
  const id = String(ctx.from?.id || '0')
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ')
  if (!db.users[id]) db.users[id] = emptyUser(id, name)
  if (name) db.users[id].name = name
  db.users[id].cooldowns ||= {}
  db.users[id].profile ||= { desc: '', birth: '', genre: '', hobbies: [] }
  db.users[id].harem ||= []
  return db.users[id]
}

export function chatOf(ctx) {
  const db = load()
  const id = String(ctx.chat?.id || '0')
  if (!db.chats[id]) db.chats[id] = emptyChat(id)
  db.chats[id].warns ||= {}
  db.chats[id].counts ||= {}
  return db.chats[id]
}

export function allUsers() {
  return Object.values(load().users)
}

export function bumpCount(ctx) {
  if (!ctx.from || !ctx.chat) return
  const chat = chatOf(ctx)
  const id = String(ctx.from.id)
  chat.counts[id] = (chat.counts[id] || 0) + 1
  save()
}

export function persist() {
  save()
}

export function fmt(n) {
  return Number(n || 0).toLocaleString('es-MX')
}

export function remain(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

export function cooldownLeft(user, key) {
  return (user.cooldowns[key] || 0) - Date.now()
}

export function setCooldown(user, key, ms) {
  user.cooldowns[key] = Date.now() + ms
}

export function displayName(ctx) {
  return userOf(ctx).name || ctx.from?.username || 'alguien'
}
