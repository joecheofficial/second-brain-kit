// Shared helpers: where things live in a brain, note identity, safe writes.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readNote, writeFrontmatter } from './frontmatter.mjs'

export const NOTES = 'notes'
export const INBOX = 'inbox'
export const INDEX = 'index'
export const STATE = '.brain'

export const SOURCES = {
  chatgpt: { folder: 'chats/chatgpt', label: 'ChatGPT chat', idPrefix: 'chat:chatgpt' },
  claude: { folder: 'chats/claude', label: 'Claude chat', idPrefix: 'chat:claude' },
  'claude-project': { folder: 'chats/claude-projects', label: 'Claude project', idPrefix: 'project:claude' },
  gmail: { folder: 'email/gmail', label: 'Email', idPrefix: 'email:gmail' },
  email: { folder: 'email/other', label: 'Email', idPrefix: 'email:other' },
  drive: { folder: 'documents/google-drive', label: 'Google Drive document', idPrefix: 'doc:drive' },
  dropbox: { folder: 'documents/dropbox', label: 'Dropbox document', idPrefix: 'doc:dropbox' },
  calendar: { folder: 'calendar/events', label: 'Calendar event', idPrefix: 'event:calendar' },
  note: { folder: 'my-notes', label: 'My note', idPrefix: 'note:mine' },
  other: { folder: 'other', label: 'Other source', idPrefix: 'item:other' },
}

export function findBrain(start = process.cwd()) {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, STATE, 'brain.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// The brain this kit copy belongs to: setup copies the kit to <brain>/kit.
function kitBrain() {
  const up = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  return fs.existsSync(path.join(up, STATE, 'brain.json')) ? up : null
}

export function requireBrain(options) {
  const root = typeof options.brain === 'string' ? path.resolve(options.brain) : findBrain() ?? kitBrain()
  if (!root || !fs.existsSync(path.join(root, STATE, 'brain.json'))) {
    throw new UserError('I could not find your second brain. Run this from inside it, or add --brain ~/second-brain.')
  }
  return root
}

export class UserError extends Error {}

export function slugify(text, max = 60) {
  const s = String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s.slice(0, max).replace(/-+$/, '') || 'untitled')
}

// A stable, filename-safe id from a source identifier.
export function shortId(sourceId) {
  return crypto.createHash('sha256').update(String(sourceId)).digest('hex').slice(0, 10)
}

export function kgId(source, sourceId) {
  const safe = String(sourceId).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
  return `${SOURCES[source].idPrefix}:${safe || shortId(sourceId)}`
}

export function isoDate(value) {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  const d = Number.isFinite(n) && String(value).trim() !== '' ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function notePath(source, { date, title, sourceId }) {
  const year = date ? date.slice(0, 4) : 'undated'
  const day = date ? date.slice(0, 10) : 'undated'
  const name = `${day}-${slugify(title, 50)}-${shortId(sourceId)}.md`
  return path.posix.join(NOTES, SOURCES[source].folder, year, name)
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

// Walk every Markdown note under notes/, skipping hidden folders.
export function* walkNotes(root) {
  const base = path.join(root, NOTES)
  if (!fs.existsSync(base)) return
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield full
    }
  }
}

export function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

// Map of kg.id -> relative path for every managed note, built once per run.
export function existingIds(root) {
  const ids = new Map()
  for (const file of walkNotes(root)) {
    const head = readHead(file)
    const m = head.match(/\n {2}id: "([^"]+)"/)
    if (m) ids.set(m[1], rel(root, file))
  }
  return ids
}

export function readHead(file, bytes = 8192) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally { fs.closeSync(fd) }
}

const ORDER = ['title', 'summary', 'tags', 'kg', 'source', 'source_id', 'source_url', 'date', 'updated', 'people', 'topics', 'projects', 'project', 'messages', 'archived', 'enrichment', 'enriched_at']

// One field order everywhere, so rewriting an unchanged note is a no-op.
export function canonical(data) {
  const out = {}
  for (const k of ORDER) if (k in data) out[k] = data[k]
  for (const k of Object.keys(data).sort()) if (!(k in out)) out[k] = data[k]
  return out
}

// Build the front matter for a managed note. Enrichment written by a helper
// survives re-imports; a changed conversation is queued to be enriched again.
export function buildNote({ source, sourceId, title, date, updated, summary, url, people, extra, body, previous }) {
  const prev = previous?.data ?? {}
  const enriched = prev.enrichment === 'done' || prev.enrichment === 'pending' && Boolean(prev.enriched_at)
  const bodyChanged = previous ? previous.body.replace(/^\n+/, '') !== body.replace(/^\n+/, '') : true
  const tags = new Set([`source:${source}`])
  for (const t of prev.tags ?? []) if (enriched && !String(t).startsWith('source:')) tags.add(t)
  const data = {
    title: title || 'Untitled',
    summary: enriched && prev.summary ? prev.summary : (summary || ''),
    tags: [...tags],
    kg: { id: kgId(source, sourceId), type: 'document', status: 'active', audience: 'private' },
    source,
    source_id: String(sourceId),
    source_url: url || undefined,
    date: date || undefined,
    updated: updated || undefined,
    people: enriched && prev.people?.length ? prev.people : (people?.length ? people : undefined),
    topics: enriched ? prev.topics : undefined,
    projects: enriched ? prev.projects : undefined,
    ...(extra ?? {}),
    enrichment: enriched && !bodyChanged ? 'done' : 'pending',
    enriched_at: enriched ? prev.enriched_at : undefined,
  }
  return writeFrontmatter(canonical(data), body)
}

// Write or update one managed note. Returns 'created', 'updated' or 'unchanged'.
export function upsertNote(root, ids, note) {
  const id = kgId(note.source, note.sourceId)
  const existingRel = ids.get(id)
  const target = existingRel ?? notePath(note.source, note)
  const file = path.join(root, target)
  if (existingRel && fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8')
    const text = buildNote({ ...note, previous: readNote(old) })
    if (old === text) return 'unchanged'
    writeAtomic(file, text)
    note.writtenPath = target
    return 'updated'
  }
  writeAtomic(file, buildNote(note))
  ids.set(id, target)
  note.writtenPath = target
  return 'created'
}

// "2026-11-03 17:44" in the computer's own time zone.
export function localTime(value = new Date()) {
  const d = new Date(value)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}
