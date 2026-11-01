// Reads the relationship graph Atelier writes for an Organizer second brain
// (<root>/brain/atelier-output/knowledge.graph.json) and answers questions about it.
// Read only, no dependencies.

import fs from 'node:fs'
import path from 'node:path'

export const GRAPH_FILE = ['brain', 'atelier-output', 'knowledge.graph.json']
const KINDS = ['projects', 'people', 'companies', 'topics', 'sources']
const DATE = /\b(20\d\d-[01]\d-[0-3]\d)\b/
// Words too common to treat as a mention of a single-word note title.
const COMMON = new Set(['about', 'archive', 'business', 'clients', 'company', 'content', 'design', 'email', 'ideas', 'notes', 'personal', 'project', 'projects', 'people', 'research', 'sources', 'today', 'topics', 'website', 'work', 'writing'])

export function graphPath(root) {
  return path.join(root, ...GRAPH_FILE)
}

export function loadGraph(root) {
  const file = graphPath(root)
  if (!fs.existsSync(file)) return null
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const brainDir = path.join(root, 'brain')
  const nodes = new Map()
  for (const node of raw.nodes || []) {
    const rel = node.path || ''
    const kind = KINDS.find(k => rel.startsWith(`${k}/`)) || 'other'
    const notePath = rel ? path.join(brainDir, rel) : null
    let date = (rel.match(DATE) || (node.title || '').match(DATE) || [])[1] || null
    if (!date && kind === 'sources' && notePath) {
      try { date = fs.statSync(notePath).mtime.toISOString().slice(0, 10) } catch {}
    }
    nodes.set(node.id, { id: node.id, title: node.title || node.id, summary: node.summary || '', kind, notePath, date, links: [] })
  }
  for (const edge of raw.edges || []) {
    const a = nodes.get(edge.source)
    const b = nodes.get(edge.target)
    if (!a || !b || a === b) continue
    a.links.push({ node: b, type: edge.type })
    b.links.push({ node: a, type: edge.type })
  }
  for (const node of nodes.values()) {
    const seen = new Set()
    node.links = node.links.filter(l => !seen.has(l.node.id) && seen.add(l.node.id))
    const dates = node.links.filter(l => l.node.kind === 'sources' && l.node.date).map(l => l.node.date)
    node.lastSeen = node.date || (dates.length ? dates.sort().at(-1) : null)
    node.weight = node.links.filter(l => l.node.kind !== 'topics').length
  }
  return { file, nodes }
}

const norm = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

export function find(graph, words, limit = 10) {
  const terms = norm(words).split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const scored = []
  for (const node of graph.nodes.values()) {
    const title = norm(node.title)
    const text = `${title} ${norm(node.summary)}`
    if (!terms.every(t => text.includes(t))) continue
    let score = node.weight / 100
    if (title === terms.join(' ')) score += 100
    else if (terms.every(t => title.includes(t))) score += 10
    if (node.kind !== 'sources') score += 5
    scored.push({ node, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.node)
}

export function resolve(graph, name) {
  return find(graph, name, 1)[0] || null
}

export function neighbours(node, perKind = 8) {
  const groups = {}
  for (const kind of [...KINDS, 'other']) {
    const list = node.links.map(l => l.node).filter(n => n.kind === kind)
      .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || b.weight - a.weight)
    if (list.length) groups[kind] = { total: list.length, shown: list.slice(0, perKind) }
  }
  return groups
}

export function shortestPath(graph, from, to) {
  if (from === to) return [from]
  const back = new Map([[from.id, null]])
  const queue = [from]
  while (queue.length) {
    const current = queue.shift()
    for (const { node } of current.links) {
      if (back.has(node.id)) continue
      back.set(node.id, current)
      if (node === to) {
        const chain = [to]
        let step = current
        while (step) { chain.unshift(step); step = back.get(step.id) }
        return chain
      }
      // Topics join almost everything; walking through them gives meaningless paths.
      if (node.kind !== 'topics') queue.push(node)
    }
  }
  return null
}

export function recent(graph, limit = 10) {
  const pick = kind => [...graph.nodes.values()].filter(n => n.kind === kind && n.lastSeen)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.weight - a.weight).slice(0, limit)
  return { projects: pick('projects'), people: pick('people'), companies: pick('companies') }
}

export function mentions(graph, prompt, limit = 3) {
  const text = ` ${norm(prompt).replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  const hits = []
  for (const node of graph.nodes.values()) {
    if (!['projects', 'people', 'companies'].includes(node.kind)) continue
    const title = norm(node.title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (title.length < 4) continue
    const single = !title.includes(' ')
    if (single && (COMMON.has(title) || title.length < 5)) continue
    if (text.includes(` ${title} `)) hits.push(node)
  }
  // Prefer the most specific matches: longer titles, then better connected.
  return hits.sort((a, b) => b.title.length - a.title.length || b.weight - a.weight).slice(0, limit)
}
