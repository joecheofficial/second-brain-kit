// Save items an agent fetched through a connector (Gmail, Google Drive,
// Dropbox, Calendar) or something the person wants to remember. The agent
// passes JSON; this writes a tidy note and never creates duplicates.
import { SOURCES, UserError, clip, existingIds, isoDate, upsertNote } from './notes.mjs'

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

export function addItems(root, items) {
  const ids = existingIds(root)
  const report = { created: 0, updated: 0, unchanged: 0, skipped: [], paths: [] }
  items.forEach((item, i) => {
    const source = String(item?.source ?? '').toLowerCase()
    const why = []
    if (!SOURCES[source] || ['chatgpt', 'claude', 'claude-project'].includes(source)) why.push(`source must be one of gmail, email, drive, dropbox, calendar, note, other`)
    const sourceId = String(item?.id ?? item?.sourceId ?? '').trim()
    if (!sourceId && source !== 'note') why.push('id is required (the message, thread or file id from the connector)')
    const title = clip(item?.title ?? '', 140)
    if (!title) why.push('title is required')
    const text = String(item?.body ?? item?.text ?? '').trim()
    if (!text && !item?.summary) why.push('body or summary is required')
    if (why.length) { report.skipped.push({ item: i + 1, why: why.join('; ') }); return }
    const date = isoDate(item.date) ?? new Date().toISOString()
    const people = Array.isArray(item.people) ? item.people.map(String).slice(0, 20) : undefined
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
      people,
      summary: item.summary ? clip(item.summary, 400) : clip(text, 200),
      body,
    }
    const result = upsertNote(root, ids, note)
    if (note.writtenPath) report.paths.push(note.writtenPath)
    report[result]++
  })
  return report
}
