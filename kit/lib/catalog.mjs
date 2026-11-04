// The catalog: one line of facts per note, kept in index/notes.jsonl, plus the
// human-readable INDEX.md and folder pages an agent reads to find its way.
import { safeName } from './guard.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { INDEX, NOTES, clip, localTime, readHead, rel, slugify, walkNotes, writeAtomic } from './notes.mjs'
import { readNote, writeFrontmatter } from './frontmatter.mjs'

function firstHeading(text) {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

function list(v) {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []
}

const names = v => [...new Set(list(v).map(safeName).filter(Boolean))]

export function catalogEntry(root, file) {
  let head = readHead(file, 16384)
  // Front matter longer than the head: read the whole file.
  if (head.startsWith('---') && !/\n---\r?\n/.test(head.slice(3))) head = fs.readFileSync(file, 'utf8')
  const note = readNote(head)
  const d = note.data
  const stat = fs.statSync(file)
  const relPath = rel(root, file)
  const area = relPath.split('/').slice(1, -1).filter(p => !/^\d{4}$|^undated$/.test(p)).join('/') || '(top)'
  const tags = list(d.tags)
  return {
    path: relPath,
    id: d.kg?.id ?? null,
    title: String(d.title || firstHeading(note.body) || path.basename(file, '.md')),
    date: d.date ? String(d.date).slice(0, 10) : new Date(stat.mtimeMs).toISOString().slice(0, 10),
    source: d.source ? String(d.source) : 'note',
    area,
    summary: clip(d.summary || '', 300),
    topics: list(d.topics),
    people: names(d.people),
    projects: names(d.projects),
    concepts: tags.filter(t => t.startsWith('concept:')).map(t => t.slice(8)),
    enrichment: d.enrichment ? String(d.enrichment) : (note.hasFrontmatter ? 'unmanaged' : 'no-front-matter'),
    bytes: stat.size,
    managed: Boolean(d.kg?.id),
  }
}

export function scanCatalog(root) {
  const entries = []
  const problems = []
  for (const file of walkNotes(root)) {
    try { entries.push(catalogEntry(root, file)) } catch (e) { problems.push({ path: rel(root, file), error: e.message }) }
  }
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path))
  return { entries, problems }
}

const line = e => `- ${e.date} · [${e.title.replace(/[[\]]/g, '')}](../${e.path})${e.summary ? ` — ${clip(e.summary, 160)}` : ''}`

function countBy(entries, key) {
  const m = new Map()
  for (const e of entries) for (const v of [].concat(e[key])) if (v) m.set(v, (m.get(v) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const pageName = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other'

export function writeIndex(root, { entries, problems }, { now = new Date() } = {}) {
  const dir = path.join(root, INDEX)
  // Rebuilt from scratch every time; nothing in index/ is hand-edited.
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'areas'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'topics'), { recursive: true })
  writeAtomic(path.join(dir, 'notes.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))

  const areas = new Map()
  for (const e of entries) {
    const year = e.date?.slice(0, 4) || 'undated'
    const key = `${e.area}|${year}`
    if (!areas.has(key)) areas.set(key, [])
    areas.get(key).push(e)
  }
  const areaPages = new Map()
  for (const [key, list] of areas) {
    const [area, year] = key.split('|')
    const name = `${pageName(area)}-${year}.md`
    writeAtomic(path.join(dir, 'areas', name), [`# ${area} · ${year}`, '', `${list.length} notes, newest first.`, '', ...list.map(e => line(e).replace('](../', '](../../'))].join('\n') + '\n')
    if (!areaPages.has(area)) areaPages.set(area, [])
    areaPages.get(area).push({ year, name, count: list.length })
  }

  const topics = countBy(entries, 'topics')
  for (const [topic] of topics.slice(0, 300)) {
    const list = entries.filter(e => e.topics.includes(topic))
    writeAtomic(path.join(dir, 'topics', `${pageName(topic)}.md`), [`# Topic: ${topic}`, '', `${list.length} notes.`, '', ...list.map(e => line(e).replace('](../', '](../../'))].join('\n') + '\n')
  }

  const pending = entries.filter(e => e.enrichment === 'pending').length
  const people = countBy(entries, 'people').slice(0, 40)
  const projects = countBy(entries, 'projects').slice(0, 40)
  const out = [
    '# Index of my second brain',
    '',
    `Rebuilt ${localTime(now)} · ${entries.length} notes · ${pending} still waiting for a summary`,
    '',
    'Find anything: `node kit/brain.mjs find "words you remember"`. This page is generated; edits here are replaced.',
    '',
    '## Areas',
    '',
    ...[...areaPages.entries()].sort().map(([area, years]) => `- **${area}** (${years.reduce((n, y) => n + y.count, 0)}): ${years.sort((a, b) => b.year.localeCompare(a.year)).map(y => `[${y.year}](areas/${y.name}) ${y.count}`).join(' · ')}`),
    '',
  ]
  if (projects.length) out.push('## Projects', '', ...projects.map(([p, n]) => `- ${p} (${n})`), '')
  if (people.length) out.push('## People', '', ...people.map(([p, n]) => `- ${p} (${n})`), '')
  if (topics.length) out.push('## Topics', '', topics.slice(0, 60).map(([t, n]) => `[${t}](topics/${pageName(t)}.md) ${n}`).join(' · '), '')
  out.push('## Most recent', '', ...entries.slice(0, 40).map(line), '')
  if (problems.length) out.push('## Notes I could not read', '', ...problems.map(p => `- ${p.path}: ${p.error}`), '')
  writeAtomic(path.join(dir, 'INDEX.md'), out.join('\n'))
  if (lastHubs.has(root)) writeHubIndex(root, lastHubs.get(root))
  return { notes: entries.length, pending, areas: areaPages.size, topics: topics.length, problems: problems.length }
}

const HUBS = 'hubs'
const lastHubs = new Map()  // writeIndex clears index/, so it rewrites hubs.json from here
const MAX_LISTED = 500     // links listed in the hub page itself
const MAX_MEMBERS = 5000   // members declared as related
const MIN_SHARED = 1       // one shared note is a real link; MAX_LINKS keeps the strongest
const MAX_LINKS = 15       // connections kept per hub, strongest first

// Hub notes: one per project and per person named on two or more notes. Each
// declares a `related` relation to its notes, which gives the map its shape and
// gives an assistant one page per project or person. Rebuilt every refresh.
export function writeHubs(root, entries) {
  const dir = path.join(root, NOTES, HUBS)
  const written = new Set()
  const groups = [['projects', 'projects', 'Project'], ['people', 'people', 'Person']]

  // First pass: decide every hub, so hubs can link to each other.
  const hubs = []
  for (const [field, folder, label] of groups) {
    const by = new Map()
    for (const e of entries) for (const v of e[field]) {
      const key = v.toLowerCase()
      if (!by.has(key)) by.set(key, { name: v, notes: [] })
      by.get(key).notes.push(e)
    }
    const ranked = [...by.values()].filter(g => g.notes.length >= 2).sort((a, b) => b.notes.length - a.notes.length).slice(0, 500)
    const slugs = new Set()
    for (const g of ranked) {
      const slug = slugify(g.name, 60)
      if (slugs.has(slug)) continue
      slugs.add(slug)
      hubs.push({ ...g, folder, label, slug, id: `hub:${folder}:${slug}`, relPath: path.posix.join(NOTES, HUBS, folder, `${slug}.md`), links: [] })
    }
  }

  // The relationship graph: two hubs are connected when they share notes.
  const onNote = new Map()
  hubs.forEach((h, i) => { for (const e of h.notes) { if (!onNote.has(e.path)) onNote.set(e.path, []); onNote.get(e.path).push(i) } })
  const shared = new Map()
  for (const list of onNote.values()) {
    const few = list.slice(0, 12)
    for (let a = 0; a < few.length; a++) for (let b = a + 1; b < few.length; b++) {
      const key = few[a] < few[b] ? `${few[a]}|${few[b]}` : `${few[b]}|${few[a]}`
      shared.set(key, (shared.get(key) ?? 0) + 1)
    }
  }
  for (const [key, count] of shared) {
    if (count < MIN_SHARED) continue
    const [a, b] = key.split('|').map(Number)
    hubs[a].links.push({ hub: hubs[b], count })
    hubs[b].links.push({ hub: hubs[a], count })
  }
  for (const h of hubs) h.links = h.links.sort((x, y) => y.count - x.count).slice(0, MAX_LINKS)

  for (const h of hubs) {
    const { name, notes, folder, label, slug, id, relPath, links } = h
    const members = notes.filter(e => e.id).slice(0, MAX_MEMBERS)
    const data = {
      title: `${label}: ${name}`,
      summary: `${notes.length} notes mention ${name}. Newest ${notes[0].date}.`,
      tags: [`source:hub`],
      kg: { id, type: 'document', status: 'active', audience: 'private', relations: { related: [...links.map(l => l.hub.id), ...members.map(e => e.id)] } },
      source: 'hub',
      generated: true,
    }
    const connected = links.length ? ['## Connected to', '', ...links.map(l => `- ${l.hub.label}: [${l.hub.name}](../${l.hub.folder}/${l.hub.slug}.md) (${l.count} shared notes)`), ''] : []
    const body = [`# ${name}`, '', `${label} hub, rebuilt by every refresh. ${notes.length} notes, newest first${notes.length > MAX_LISTED ? ` (the ${MAX_LISTED} newest are listed here; search finds the rest)` : ''}.`, '', ...connected, '## Notes', '', ...notes.slice(0, MAX_LISTED).map(e => `- ${e.date} · [${e.title.replace(/[[\]]/g, '')}](../../../${e.path})${e.summary ? ` — ${clip(e.summary, 140)}` : ''}`), '']
    const text = writeFrontmatter(data, body.join('\n'))
    const file = path.join(root, relPath)
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) writeAtomic(file, text)
    written.add(relPath)
  }
  // Remove hubs that no longer have two notes.
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }) : []) {
    const r = path.posix.join(NOTES, HUBS, String(name).split(path.sep).join('/'))
    if (r.endsWith('.md') && !written.has(r)) fs.rmSync(path.join(root, r), { force: true })
  }
  lastHubs.set(root, hubs)
  return [...written].map(r => catalogEntry(root, path.join(root, r)))
}

// A small file of who connects to what. The session hooks read this instead of
// the whole graph, so they stay fast however large the brain gets.
function writeHubIndex(root, hubs) {
  const list = hubs.map(h => ({
    id: h.id,
    name: h.name,
    kind: h.folder,
    path: h.relPath,
    notes: h.notes.length,
    newest: h.notes[0]?.date ?? null,
    links: h.links.map(l => ({ name: l.hub.name, kind: l.hub.folder, shared: l.count })),
  }))
  const file = path.join(root, INDEX, 'hubs.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, JSON.stringify(list) + '\n')
}

export function isHub(entry) {
  return entry.path.startsWith(`${NOTES}/${HUBS}/`)
}

// Update the catalog for a few changed notes without a full rebuild, so search
// sees them at once. A full refresh still rebuilds pages, hubs and the graph.
export function updateCatalog(root, relPaths) {
  const file = path.join(root, INDEX, 'notes.jsonl')
  if (!fs.existsSync(file) || relPaths.length === 0) return
  const entries = new Map(readCatalog(root).map(e => [e.path, e]))
  for (const p of relPaths) {
    const full = path.join(root, p)
    if (fs.existsSync(full)) entries.set(p, catalogEntry(root, full))
    else entries.delete(p)
  }
  const list = [...entries.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path))
  writeAtomic(file, list.map(e => JSON.stringify(e)).join('\n') + '\n')
}

export function readCatalog(root) {
  const file = path.join(root, INDEX, 'notes.jsonl')
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

export { NOTES }
