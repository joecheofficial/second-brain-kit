// Save items an agent fetched through a connector (Gmail, Google Drive,
// Dropbox, Calendar) or something the person wants to remember. The agent
// passes JSON; this writes a tidy note and never creates duplicates.
import fs from 'node:fs'
import path from 'node:path'
import { SOURCES, UserError, clip, existingIds, isoDate, kgId, upsertNote } from './notes.mjs'
import { readNote } from './frontmatter.mjs'
import { cleanText, safeName, scanText } from './guard.mjs'
import { bodyHash, holdFile } from './queue.mjs'

const MAX_BODY = 200_000

export function parseItems(text) {
  const t = text.trim()
  if (!t) throw new UserError('No items given. Pass a JSON object, a JSON list, or one JSON object per line.')
  if (t.startsWith('[')) return JSON.parse(t)
  if (t.startsWith('{') && !t.includes('\n{')) return [JSON.parse(t)]
  return t.split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l) } catch { throw new UserError(`Line ${i + 1} is not valid JSON.`) }
  })
}

export function addItems(root, items, { connector = false } = {}) {
  const ids = existingIds(root)
  const report = { created: 0, updated: 0, unchanged: 0, skipped: [], paths: [] }
  items.forEach((item, i) => {
    const source = String(item?.source ?? '').toLowerCase()
    const why = []
    if (!SOURCES[source] || ['chatgpt', 'claude', 'claude-project'].includes(source)) why.push(`source must be one of gmail, email, drive, dropbox, calendar, note, other`)
    if (connector && source === 'note') why.push('app items cannot be saved as your own notes')
    const sourceId = String(item?.id ?? item?.sourceId ?? '').trim()
    if (!sourceId && source !== 'note') why.push('id is required (the message, thread or file id from the connector)')
    const title = clip(cleanText(item?.title ?? ''), 140)
    if (!title) why.push('title is required')
    const text = cleanText(item?.body ?? item?.text ?? '').trim()
    if (!text && !item?.summary) why.push('body or summary is required')
    if (why.length) { report.skipped.push({ item: i + 1, why: why.join('; ') }); return }
    const date = isoDate(item.date) ?? new Date().toISOString()
    const people = Array.isArray(item.people) ? item.people.map(safeName).filter(Boolean).slice(0, 20) : undefined
    const body = [
      `# ${title}`,
      '',
      `${SOURCES[source].label}${date ? ` · ${date.slice(0, 10)}` : ''}${people?.length ? ` · ${people.join(', ')}` : ''}`,
      item.url ? `\nOpen the original: ${item.url}` : '',
      '',
      text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '\n\n_(Cut here because the original is very long.)_' : text,
      '',
    ].join('\n')
    const note = {
      source,
      sourceId: sourceId || `${date}-${title}`,
      title,
      date,
      url: typeof item.url === 'string' ? item.url : undefined,
      summary: item.summary ? clip(item.summary, 400) : clip(text, 200),
      body,
    }
    // Names from mail headers stay in the note text. Only a helper's reading adds someone to the
    // graph, so a sender cannot put words into a briefing by choosing a display name.
    // Checked here, before anything reaches the index, the hubs or a search result.
    const known = ids.get(kgId(source, note.sourceId))
    const released = known && fs.existsSync(path.join(root, known)) && readNote(fs.readFileSync(path.join(root, known), 'utf8')).data.guard_ok === bodyHash(body)
    const hits = released ? [] : scanText([title, item.summary ?? '', text, ...(people ?? [])].join('\n'))
    if (released) note.extra = { guard_ok: bodyHash(body) }
    if (hits.length) note.summary = ''
    const result = upsertNote(root, ids, note)
    if (hits.length) { holdFile(root, { path: ids.get(kgId(source, note.sourceId)), date, source }, hits); report.held = (report.held ?? 0) + 1 }
    if (note.writtenPath) report.paths.push(note.writtenPath)
    report[result]++
  })
  return report
}
