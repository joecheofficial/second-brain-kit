// Read and write the small YAML front matter this kit puts on every note.
// Strings are always written double-quoted (JSON escaping is valid YAML), so
// the reader only has to understand what the writer produces. Notes written by
// people may use other YAML; those are read leniently and never rewritten.

const LINE_SEPARATORS = /[\u2028\u2029]/g

export function quote(value) {
  return JSON.stringify(String(value)).replace(LINE_SEPARATORS, c => (c === '\u2028' ? '\\u2028' : '\\u2029'))
}

function emit(value, indent) {
  const pad = '  '.repeat(indent)
  const lines = []
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      lines.push(`${pad}${key}:`)
      for (const item of v) lines.push(`${pad}  - ${quote(item)}`)
    } else if (typeof v === 'object') {
      const inner = emit(v, indent + 1)
      if (inner.length === 0) continue
      lines.push(`${pad}${key}:`, ...inner)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${pad}${key}: ${v}`)
    } else {
      lines.push(`${pad}${key}: ${quote(v)}`)
    }
  }
  return lines
}

export function writeFrontmatter(data, body) {
  return `---\n${emit(data, 0).join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`
}

export function splitFrontmatter(text) {
  const clean = text.replace(/^﻿/, '')
  if (!clean.startsWith('---\n') && !clean.startsWith('---\r\n')) return { yaml: null, body: clean }
  const end = clean.search(/\r?\n---\r?\n|\r?\n---$/)
  if (end < 0) return { yaml: null, body: clean }
  const yaml = clean.slice(clean.indexOf('\n') + 1, end)
  const rest = clean.slice(end).replace(/^\r?\n---\r?\n?/, '').replace(/^\r?\n/, '')
  return { yaml, body: rest }
}

function scalar(raw) {
  const s = raw.trim()
  if (s === '') return ''
  if (s.startsWith('"')) {
    try { return JSON.parse(s) } catch { return s.slice(1, -1) }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map(x => scalar(x)).filter(x => x !== '')
  }
  return s
}

// Indentation-based reader for maps, lists of scalars and nested maps.
export function parseYaml(yaml) {
  const root = {}
  const stack = [{ indent: -1, container: root }]
  let pendingKey = null
  for (const rawLine of yaml.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop()
    const parent = stack.at(-1)
    if (line.startsWith('- ')) {
      if (pendingKey && !Array.isArray(pendingKey.holder[pendingKey.key])) pendingKey.holder[pendingKey.key] = []
      const list = pendingKey ? pendingKey.holder[pendingKey.key] : null
      if (Array.isArray(list)) list.push(scalar(line.slice(2)))
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().replace(/^["']|["']$/g, '')
    const rest = line.slice(colon + 1)
    const holder = parent.container
    if (rest.trim() === '') {
      holder[key] = {}
      stack.push({ indent, container: holder[key] })
      pendingKey = { holder, key }
    } else {
      holder[key] = scalar(rest)
      pendingKey = null
    }
  }
  // Keys that only held list items were created as {} first; fix them up.
  const fix = obj => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (Object.keys(v).length === 0) obj[k] = []
        else fix(v)
      }
    }
  }
  fix(root)
  return root
}

export function readNote(text) {
  const { yaml, body } = splitFrontmatter(text)
  let data = {}
  let error = null
  if (yaml !== null) {
    try { data = parseYaml(yaml) } catch (e) { error = e.message }
  }
  return { data, body, hasFrontmatter: yaml !== null, error }
}
