// Turn ChatGPT and Claude data exports into one Markdown note per conversation.
// No model is used: this is a deterministic copy with tidy front matter, so it
// is fast, free and repeatable. Running it again only touches what changed.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { INBOX, STATE, UserError, clip, existingIds, isoDate, readJson, upsertNote, writeJson, slugify } from './notes.mjs'

const MAX_BODY = 400_000
const MAX_ATTACHMENT = 4_000

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

function unzip(root, zip) {
  const dest = path.join(root, INBOX, '.unpacked', slugify(path.basename(zip, '.zip'), 80))
  fs.mkdirSync(dest, { recursive: true })
  const tries = process.platform === 'win32'
    ? [['tar', ['-xf', zip, '-C', dest]]]
    : [['unzip', ['-q', '-o', zip, '-d', dest]], ['tar', ['-xf', zip, '-C', dest]]]
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' })
    if (r.status === 0) return dest
  }
  throw new UserError(`I could not unzip ${path.basename(zip)}. Double-click it to unzip it, then run the import on the folder.`)
}

// Find export files under a path: a .zip, a folder, or a single .json file.
export function findExportFiles(root, input) {
  const start = path.resolve(input)
  if (!fs.existsSync(start)) throw new UserError(`Nothing found at ${input}.`)
  let base = start
  if (fs.statSync(start).isFile() && start.toLowerCase().endsWith('.zip')) base = unzip(root, start)
  if (fs.statSync(base).isFile()) return [base]
  const found = []
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory() && depth < 4 && !e.name.startsWith('.') && e.name !== '__MACOSX') walk(full, depth + 1)
      else if (e.isFile() && /^(conversations.*|projects)\.json$/i.test(e.name)) found.push(full)
    }
  }
  walk(base, 0)
  return found.sort()
}

function loadJson(file) {
  const size = fs.statSync(file).size
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e instanceof RangeError || /memory|Invalid string length/i.test(e.message)) {
      throw new UserError(`${path.basename(file)} is very large (${Math.round(size / 1e6)} MB). Run the same command again with more memory: NODE_OPTIONS=--max-old-space-size=8192 node kit/brain.mjs import …`)
    }
    throw new UserError(`${path.basename(file)} is not readable JSON (${e.message.slice(0, 80)}). Re-download the export and unzip it again.`)
  }
}

export function detectKind(data, file) {
  if (/projects\.json$/i.test(file) && Array.isArray(data)) return 'claude-projects'
  if (!Array.isArray(data)) return 'unknown'
  const sample = data.find(x => x && typeof x === 'object')
  if (!sample) return 'empty'
  if ('mapping' in sample) return 'chatgpt'
  if ('chat_messages' in sample) return 'claude'
  return 'unknown'
}

// ---- ChatGPT ----------------------------------------------------------------

function chatgptText(message) {
  const c = message?.content
  if (!c) return ''
  if (c.content_type === 'text' || c.content_type === 'multimodal_text') {
    return (c.parts ?? []).map(p => {
      if (typeof p === 'string') return p
      if (p?.content_type === 'audio_transcription') return p.text ?? ''
      if (p?.content_type === 'image_asset_pointer') return '[image]'
      return ''
    }).filter(Boolean).join('\n\n')
  }
  if (c.content_type === 'code' && c.text) return '```\n' + c.text + '\n```'
  return ''
}

function chatgptTurns(conv) {
  const mapping = conv.mapping ?? {}
  let node = conv.current_node && mapping[conv.current_node] ? conv.current_node : null
  if (!node) {
    // No current node recorded: follow the latest leaf.
    const leaves = Object.values(mapping).filter(n => !n.children?.length)
    leaves.sort((a, b) => (b.message?.create_time ?? 0) - (a.message?.create_time ?? 0))
    node = leaves[0]?.id ?? null
  }
  const chain = []
  const seen = new Set()
  while (node && mapping[node] && !seen.has(node)) {
    seen.add(node)
    chain.push(mapping[node])
    node = mapping[node].parent
  }
  chain.reverse()
  const turns = []
  for (const n of chain) {
    const m = n.message
    if (!m) continue
    const role = m.author?.role
    if (role !== 'user' && role !== 'assistant') continue
    if (m.metadata?.is_visually_hidden_from_conversation) continue
    if (role === 'assistant' && m.recipient && m.recipient !== 'all') continue
    const text = chatgptText(m).trim()
    if (!text) continue
    turns.push({ who: role === 'user' ? 'You' : 'ChatGPT', text, at: isoDate(m.create_time) })
  }
  return turns
}

function chatgptNote(conv) {
  const turns = chatgptTurns(conv)
  if (turns.length === 0) return null
  const id = conv.conversation_id ?? conv.id
  if (!id) return null
  const title = conv.title?.trim() || clip(turns[0].text, 60)
  return {
    source: 'chatgpt',
    sourceId: id,
    title,
    date: isoDate(conv.create_time) ?? turns[0].at,
    updated: isoDate(conv.update_time),
    url: `https://chatgpt.com/c/${id}`,
    summary: `Started with: ${clip(turns.find(t => t.who === 'You')?.text ?? turns[0].text, 180)}`,
    extra: { messages: turns.length, archived: conv.is_archived ? true : undefined },
    body: renderTurns(title, 'ChatGPT', turns),
  }
}

// ---- Claude -----------------------------------------------------------------

function claudeText(msg) {
  const parts = Array.isArray(msg.content) ? msg.content : []
  const text = parts.filter(p => p?.type === 'text' && p.text).map(p => p.text).join('\n\n')
  return (text || msg.text || '').trim()
}

function claudeTurns(conv) {
  const turns = []
  for (const msg of conv.chat_messages ?? []) {
    const who = msg.sender === 'human' ? 'You' : msg.sender === 'assistant' ? 'Claude' : null
    if (!who) continue
    let text = claudeText(msg)
    for (const a of msg.attachments ?? []) {
      const name = a.file_name || 'attachment'
      const extracted = String(a.extracted_content ?? '').trim()
      text += `\n\n> Attached: ${name}${extracted ? '\n>\n' + clip(extracted, MAX_ATTACHMENT).split('\n').map(l => '> ' + l).join('\n') : ''}`
    }
    for (const f of msg.files ?? []) if (f?.file_name) text += `\n\n> Attached file: ${f.file_name}`
    text = text.trim()
    if (!text) continue
    turns.push({ who, text, at: isoDate(msg.created_at) })
  }
  return turns
}

function claudeNote(conv) {
  const turns = claudeTurns(conv)
  if (turns.length === 0 || !conv.uuid) return null
  const title = conv.name?.trim() || clip(turns[0].text, 60)
  return {
    source: 'claude',
    sourceId: conv.uuid,
    title,
    date: isoDate(conv.created_at) ?? turns[0].at,
    updated: isoDate(conv.updated_at),
    url: `https://claude.ai/chat/${conv.uuid}`,
    summary: conv.summary ? clip(conv.summary, 280) : `Started with: ${clip(turns.find(t => t.who === 'You')?.text ?? turns[0].text, 180)}`,
    extra: { messages: turns.length },
    body: renderTurns(title, 'Claude', turns),
  }
}

function claudeProjectNotes(project) {
  if (!project?.uuid) return []
  const name = project.name?.trim() || 'Untitled project'
  const notes = []
  const docs = (project.docs ?? []).filter(d => d && (d.content || d.filename))
  const lines = [`# ${name}`, '', `Claude project · ${docs.length} document${docs.length === 1 ? '' : 's'}`, '']
  if (project.description) lines.push('## Description', '', project.description.trim(), '')
  if (project.prompt_template) lines.push('## Project instructions', '', project.prompt_template.trim(), '')
  if (docs.length) lines.push('## Documents', '', ...docs.map(d => `- ${d.filename || 'untitled'}`), '')
  notes.push({
    source: 'claude-project', sourceId: project.uuid, title: name,
    date: isoDate(project.created_at), updated: isoDate(project.updated_at),
    summary: clip(project.description || `Claude project with ${docs.length} documents`, 280),
    body: capBody(lines.join('\n')),
  })
  for (const d of docs) {
    const title = d.filename || 'Untitled document'
    notes.push({
      source: 'claude-project', sourceId: d.uuid ?? `${project.uuid}/${title}`, title: `${name}: ${title}`,
      date: isoDate(d.created_at) ?? isoDate(project.created_at),
      summary: clip(`Document in the Claude project "${name}". ${String(d.content ?? '').slice(0, 200)}`, 280),
      extra: { project: name },
      body: capBody(`# ${title}\n\nFrom the Claude project "${name}".\n\n${String(d.content ?? '').trim()}\n`),
    })
  }
  return notes
}

// ---- shared -----------------------------------------------------------------

function capBody(body) {
  if (body.length <= MAX_BODY) return body
  return body.slice(0, MAX_BODY) + '\n\n_(Cut here because the original is very long. The full text is still in the export in your inbox.)_\n'
}

function renderTurns(title, app, turns) {
  const first = turns[0]?.at?.slice(0, 10) ?? 'undated'
  const lines = [`# ${title}`, '', `${app} conversation · ${first} · ${turns.length} messages`, '']
  for (const t of turns) lines.push(`### ${t.who}${t.at ? ` · ${t.at.slice(0, 16).replace('T', ' ')}` : ''}`, '', t.text, '')
  return capBody(lines.join('\n'))
}

export function notesFromExport(kind, data) {
  if (kind === 'chatgpt') return data.map(chatgptNote).filter(Boolean)
  if (kind === 'claude') return data.map(claudeNote).filter(Boolean)
  if (kind === 'claude-projects') return data.flatMap(claudeProjectNotes)
  return []
}

export function importExports(root, input, { force = false, log = () => {} } = {}) {
  const files = findExportFiles(root, input)
  if (files.length === 0) {
    throw new UserError(`No conversations.json found in ${input}. Point me at the unzipped ChatGPT or Claude export folder (or its .zip).`)
  }
  const ledgerFile = path.join(root, STATE, 'imports.json')
  const ledger = readJson(ledgerFile, {})
  const ids = existingIds(root)
  const totals = { files: 0, skippedFiles: 0, created: 0, updated: 0, unchanged: 0, unknownFiles: [] }
  for (const file of files) {
    const digest = sha256File(file)
    if (ledger[digest] && !force) { totals.skippedFiles++; log(`already imported: ${path.basename(file)}`); continue }
    const data = loadJson(file)
    const kind = detectKind(data, file)
    if (kind === 'unknown' || kind === 'empty') {
      totals.unknownFiles.push(path.basename(file))
      log(`not a chat export I recognise: ${path.basename(file)}`)
      continue
    }
    const notes = notesFromExport(kind, data)
    const counts = { created: 0, updated: 0, unchanged: 0 }
    for (const note of notes) counts[upsertNote(root, ids, note)]++
    for (const k of Object.keys(counts)) totals[k] += counts[k]
    totals.files++
    ledger[digest] = { file: path.basename(file), kind, at: new Date().toISOString(), ...counts }
    writeJson(ledgerFile, ledger)
    log(`${kind}: ${notes.length} ${kind === 'claude-projects' ? 'project notes' : 'conversations'} (${counts.created} new, ${counts.updated} updated, ${counts.unchanged} unchanged)`)
  }
  return totals
}
