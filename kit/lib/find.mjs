// Plain keyword search across the catalog and the note text. No model, no
// network. Results are pointers: open the note and read it before answering.
import fs from 'node:fs'
import path from 'node:path'
import { readCatalog, scanCatalog } from './catalog.mjs'

const STOP = new Set('a an and are as at be but by did do does for from had has have how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your about can could would should'.split(' '))

export function terms(query) {
  const words = String(query).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'@.-]*/gu) ?? []
  const kept = words.map(w => w.replace(/[.'-]+$/, '')).filter(w => w.length > 1 && !STOP.has(w))
  return [...new Set(kept)]
}

function count(haystack, term) {
  if (!haystack) return 0
  let n = 0
  let i = haystack.indexOf(term)
  while (i >= 0 && n < 50) { n++; i = haystack.indexOf(term, i + term.length) }
  return n
}

function snippet(body, words) {
  const lines = body.split('\n')
  let best = null
  // Skip the front matter: the match worth showing is in the text.
  let from = 0
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) from = end + 1 }
  for (let i = from; i < lines.length; i++) {
    const l = lines[i].toLowerCase()
    const hits = words.filter(w => l.includes(w)).length
    if (hits && (!best || hits > best.hits)) best = { hits, line: i + 1, text: lines[i].trim() }
  }
  if (!best) return null
  return { line: best.line, text: best.text.length > 220 ? best.text.slice(0, 219) + '…' : best.text }
}

export function find(root, query, { limit = 10, since, source, bodies = true } = {}) {
  const words = terms(query)
  if (words.length === 0) return { query, words, results: [], searched: 0 }
  const catalog = readCatalog(root) ?? scanCatalog(root).entries
  const now = Date.now()
  const scored = []
  for (const e of catalog) {
    if (since && e.date < since) continue
    if (source && e.source !== source) continue
    const meta = {
      title: e.title.toLowerCase(),
      tags: [...e.topics, ...e.people, ...e.projects, ...e.concepts].join(' ').toLowerCase(),
      summary: e.summary.toLowerCase(),
    }
    let score = 0
    let matched = 0
    let body = null
    for (const w of words) {
      const s = 6 * Math.min(count(meta.title, w), 2) + 4 * Math.min(count(meta.tags, w), 2) + 3 * Math.min(count(meta.summary, w), 2)
      let b = 0
      if (bodies) {
        if (body === null) {
          try { body = fs.readFileSync(path.join(root, e.path), 'utf8').toLowerCase() } catch { body = '' }
        }
        b = Math.min(count(body, w), 8)
      }
      if (s + b > 0) matched++
      score += s + b
    }
    if (matched === 0) continue
    // Notes that contain every word rank first; recent notes break ties.
    const coverage = matched / words.length
    const ageDays = Math.max(0, (now - Date.parse(e.date || 0)) / 86_400_000)
    const final = score * (0.4 + coverage) * (coverage === 1 ? 1.5 : 1) + Math.max(0, 3 - ageDays / 120)
    scored.push({ e, score: final, coverage })
  }
  scored.sort((a, b) => b.score - a.score)
  const results = scored.slice(0, limit).map(({ e, score, coverage }) => {
    let where = null
    if (bodies) {
      try { where = snippet(fs.readFileSync(path.join(root, e.path), 'utf8'), words) } catch { where = null }
    }
    return { path: e.path, title: e.title, date: e.date, source: e.source, summary: e.summary, score: Math.round(score), allWords: coverage === 1, match: where }
  })
  return { query, words, results, searched: catalog.length, matched: scored.length, allWords: scored.filter(s => s.coverage === 1).length }
}

export function formatFind(out) {
  if (out.words.length === 0) return 'Give me a few words to look for.'
  if (out.results.length === 0) return `Nothing in ${out.searched} notes matches "${out.query}". Try other words, a name, or a shorter phrase. No match does not prove it never happened; it may not be imported yet.`
  const lines = [`Searched ${out.searched} notes for "${out.query}": ${out.allWords} contain every word${out.matched > out.allWords ? `, ${out.matched - out.allWords} more contain some` : ''}. Best ${out.results.length}:`, '']
  out.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}  (${r.date}, ${r.source}${r.allWords ? '' : ', some words'})`)
    lines.push(`   ${r.path}${r.match ? `:${r.match.line}` : ''}`)
    if (r.match) lines.push(`   “${r.match.text}”`)
    else if (r.summary) lines.push(`   ${r.summary}`)
  })
  lines.push('', 'Open a note to read it before relying on it.')
  return lines.join('\n')
}
