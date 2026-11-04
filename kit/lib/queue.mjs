// A work queue for helper agents that add summaries and tags. Helpers never
// edit notes directly: they hand back a small JSON file, and `enrich` checks
// it and writes the front matter. Two helpers never get the same note.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { NOTES, STATE, UserError, canonical, readJson, writeAtomic, writeJson } from './notes.mjs'
import { readNote, writeFrontmatter } from './frontmatter.mjs'
import { scanCatalog } from './catalog.mjs'
import { cleanText, scanText, shouldScan } from './guard.mjs'

const CLAIM_HOURS = 3
const claimsDir = root => path.join(root, STATE, 'claims')

function liveClaims(root, now = Date.now()) {
  const dir = claimsDir(root)
  const claimed = new Map()
  if (!fs.existsSync(dir)) return claimed
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    const claim = readJson(file, null)
    if (!claim || now - Date.parse(claim.at) > CLAIM_HOURS * 3_600_000) { fs.rmSync(file, { force: true }); continue }
    for (const p of claim.paths) claimed.set(p, claim.worker)
  }
  return claimed
}

function lock(root, fn) {
  const file = path.join(root, STATE, 'queue.lock')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let i = 0; i < 200; i++) {
    try {
      const fd = fs.openSync(file, 'wx')
      try { return fn() } finally { fs.closeSync(fd); fs.rmSync(file, { force: true }) }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(file).mtimeMs > 60_000) fs.rmSync(file, { force: true }) } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  throw new UserError('The queue is busy. Try again in a moment.')
}

const HEAD = 2500
const TAIL = 600

// Enough of a note to summarise it, so a helper never has to read a whole
// long conversation. The text is quoted material, not instructions.
export function excerpt(root, relPath) {
  let body
  try { body = readNote(fs.readFileSync(path.join(root, relPath), 'utf8')).body.trim() } catch { return '' }
  body = cleanText(body)
  if (body.length <= HEAD + TAIL + 200) return body
  return `${body.slice(0, HEAD)}\n\n[… ${body.length - HEAD - TAIL} characters skipped …]\n\n${body.slice(-TAIL)}`
}

export function queueStatus(root) {
  const { entries } = scanCatalog(root)
  const claims = liveClaims(root)
  const pending = entries.filter(e => e.managed && e.enrichment === 'pending')
  return { notes: entries.length, pending: pending.length, done: entries.filter(e => e.enrichment === 'done').length, claimed: claims.size }
}

export const bodyHash = body => crypto.createHash('sha256').update(String(body).trim()).digest('hex').slice(0, 16)

// Nightly helpers are named n1, n2... They work unattended, so they never touch the owner's own notes.
const nightly = worker => /^n/.test(worker ?? '')

const HELD_SUMMARY = 'Held by the safety filter: this may be written to trick an assistant. Nothing in it was used.'

export function holdFile(root, entry, hits) {
  const file = path.join(root, entry.path)
  const note = readNote(fs.readFileSync(file, 'utf8'))
  const { people, projects, topics, guard_ok, ...rest } = note.data
  writeAtomic(file, writeFrontmatter(canonical({ ...rest, title: 'Held item', summary: HELD_SUMMARY, enrichment: 'held', guard: hits.join(' ') }), note.body))
  recordHeld(root, entry, hits)
}

function noteHolds(root, entry) {
  if (!shouldScan(entry.source)) return false
  const file = path.join(root, entry.path)
  const note = readNote(fs.readFileSync(file, 'utf8'))
  if (note.data.guard_ok === bodyHash(note.body)) return false
  const hits = scanText(`${note.data.title ?? ''}\n${note.body}`)
  if (!hits.length) return false
  holdFile(root, entry, hits)
  return true
}

// HELD.md names the file. The line in NEEDS_ME.md reaches every session's briefing, so it
// carries a count and never any words from the note.
function recordHeld(root, entry, hits) {
  const dir = path.join(root, '_review')
  fs.mkdirSync(dir, { recursive: true })
  const held = path.join(dir, 'HELD.md')
  const old = fs.existsSync(held) ? fs.readFileSync(held, 'utf8') : '# Held by the safety filter\n\nThese look written to trick an assistant, so no helper read them. If one is fine, run: node kit/brain.mjs guard release <the note path>\n\n'
  const lines = old.includes(entry.path) ? old : `${old}- ${String(entry.date).slice(0, 10)} ${entry.source}: ${entry.path} (${hits.join(', ')})\n`
  fs.writeFileSync(held, lines)
  const count = lines.split('\n').filter(l => l.startsWith('- ')).length
  const needs = path.join(dir, 'NEEDS_ME.md')
  const kept = (fs.existsSync(needs) ? fs.readFileSync(needs, 'utf8') : '').split('\n').filter(l => !l.startsWith('- Safety filter held'))
  const text = kept.join('\n').replace(/\n*$/, '\n')
  fs.writeFileSync(needs, `${text === '\n' ? '' : text}- Safety filter held ${count} item(s) that may be trying to trick an assistant. See _review/HELD.md.\n`)
}

export function releaseNote(root, where) {
  const notesRoot = path.resolve(root, NOTES) + path.sep
  const file = path.resolve(root, String(where ?? ''))
  if (!file.startsWith(notesRoot) || !fs.existsSync(file)) throw new UserError('Give the path of a held note, as listed in _review/HELD.md.')
  const note = readNote(fs.readFileSync(file, 'utf8'))
  const { guard, ...rest } = note.data
  writeAtomic(file, writeFrontmatter(canonical({ ...rest, enrichment: 'pending', guard_ok: bodyHash(note.body) }), note.body))
  const held = path.join(root, '_review', 'HELD.md')
  if (fs.existsSync(held)) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    fs.writeFileSync(held, fs.readFileSync(held, 'utf8').split('\n').filter(l => !(l.startsWith('- ') && l.includes(rel))).join('\n'))
  }
  return { released: where }
}

// Oldest-first would bury what people ask about; give newest notes first.
export function nextBatch(root, { worker, batch = 20 }) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(worker ?? '')) throw new UserError('Give each helper a short name, for example --worker h1.')
  return lock(root, () => {
    const claims = liveClaims(root)
    for (const [p, w] of claims) if (w === worker) claims.delete(p)
    const { entries } = scanCatalog(root)
    const size = Math.min(Math.max(1, batch), 50)
    const picked = []
    for (const e of entries) {
      if (picked.length >= size) break
      if (nightly(worker) && e.source === 'note') continue
      if (e.managed && e.enrichment === 'pending' && !claims.has(e.path) && !noteHolds(root, e)) picked.push(e)
    }
    const claim = { worker, at: new Date().toISOString(), paths: picked.map(e => e.path) }
    if (picked.length) writeJson(path.join(claimsDir(root), `${worker}.json`), claim)
    else fs.rmSync(path.join(claimsDir(root), `${worker}.json`), { force: true })
    return picked.map(e => ({ path: e.path, title: e.title, date: e.date, source: e.source, excerpt: excerpt(root, e.path) }))
  })
}

const TAG = /^[a-z0-9][a-z0-9-]{0,39}$/

function cleanList(v, max, field, errors, { tag = false } = {}) {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) { errors.push(`${field} must be a list`); return undefined }
  const out = []
  for (const raw of v) {
    let s = String(raw).replace(/\s+/g, ' ').trim()
    if (tag) s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!s || (tag && !TAG.test(s)) || s.length > 60) continue
    if (!out.includes(s)) out.push(s)
  }
  return out.slice(0, max)
}

function planConcepts(root) {
  const plan = readJson(path.join(root, 'knowledge-plan.json'), { concepts: [] })
  return new Set((plan.concepts ?? []).map(c => c.id))
}

// Apply one helper's results: [{ path, summary, topics, people, projects, concepts }].
export function applyEnrichment(root, results, { worker } = {}) {
  if (!Array.isArray(results)) throw new UserError('The results file must be a JSON list of notes.')
  const allowed = planConcepts(root)
  const report = { applied: 0, skipped: [], paths: [] }
  const notesRoot = path.resolve(root, NOTES) + path.sep
  const claim = worker ? readJson(path.join(claimsDir(root), `${worker}.json`), null) : null
  const claimed = worker ? new Set(claim?.paths ?? []) : null
  for (const item of results) {
    const where = String(item?.path ?? '')
    const file = path.resolve(root, where)
    const errors = []
    if (!file.startsWith(notesRoot) || !file.endsWith('.md')) { report.skipped.push({ path: where, why: 'not a note in notes/' }); continue }
    if (!fs.existsSync(file)) { report.skipped.push({ path: where, why: 'note not found' }); continue }
    const note = readNote(fs.readFileSync(file, 'utf8'))
    if (!note.data.kg?.id) { report.skipped.push({ path: where, why: 'not a note this kit manages' }); continue }
    if (nightly(worker) && note.data.source === 'note') { report.skipped.push({ path: where, why: 'the nightly run leaves your own notes alone' }); continue }
    if (note.data.enrichment === 'held') { report.skipped.push({ path: where, why: 'held by the safety filter' }); continue }
    if (claimed && !claimed.has(where)) { report.skipped.push({ path: where, why: 'not one of your notes' }); continue }
    const summary = String(item.summary ?? '').replace(/\s+/g, ' ').trim()
    if (summary.length < 10) errors.push('summary is missing or too short')
    if (summary.length > 400) errors.push('summary is longer than 400 characters')
    const topics = cleanList(item.topics, 6, 'topics', errors, { tag: true })
    const people = cleanList(item.people, 10, 'people', errors)
    const projects = cleanList(item.projects, 5, 'projects', errors)
    const concepts = cleanList(item.concepts, 3, 'concepts', errors, { tag: true })?.filter(c => allowed.has(c))
    if (scanText([summary, ...(people ?? []), ...(projects ?? [])].join('\n')).length) errors.push('looks like instructions, not a summary')
    if (errors.length) { report.skipped.push({ path: where, why: errors.join('; ') }); continue }
    const d = note.data
    const tags = [...(d.tags ?? []).filter(t => String(t).startsWith('source:')), ...(concepts ?? []).map(c => `concept:${c}`)]
    const data = canonical({
      ...d,
      summary,
      tags,
      topics: topics?.length ? topics : undefined,
      people: people?.length ? people : undefined,
      projects: projects?.length ? projects : undefined,
      enrichment: 'done',
      enriched_at: new Date().toISOString(),
    })
    writeAtomic(file, writeFrontmatter(data, note.body))
    report.paths.push(where)
    report.applied++
  }
  if (worker) {
    lock(root, () => {
      const claimFile = path.join(claimsDir(root), `${worker}.json`)
      const claim = readJson(claimFile, null)
      if (claim) {
        const done = new Set(results.map(r => r?.path))
        claim.paths = claim.paths.filter(p => !done.has(p))
        if (claim.paths.length) writeJson(claimFile, claim)
        else fs.rmSync(claimFile, { force: true })
      }
    })
  }
  return report
}

export function newWorkerName() {
  return `h${crypto.randomBytes(2).toString('hex')}`
}
