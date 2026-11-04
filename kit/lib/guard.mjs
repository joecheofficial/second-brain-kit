// Prompt-injection protection, in two parts.
//
// 1. A text filter. Notes from outside (email, documents, calendar) are scanned before a
//    helper reads them. A note that looks written to trick an assistant is held: no helper
//    sees it, it adds nothing to the graph, and the owner is told. A filter can always be
//    fooled by new wording, so this is the smaller half.
// 2. A lock on the nightly run. The scheduled keeper runs with nobody watching, so this
//    PreToolUse hook decides what it may do whatever its instructions say: apps are
//    read-only, there is no internet, and it writes only inside the brain. Hooks still
//    apply in Bypass permissions mode. Every other session is left alone.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- 1. The text filter ---

const OWN_WORDS = new Set(['chatgpt', 'claude', 'claude-project'])
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g
const HIDDEN = /[\u202D\u202E]|[\u{E0000}-\u{E007F}]/u
const ASSISTANT = '(?:ai|a\\.i\\.|assistant|claude|chatgpt|gpt|codex|gemini|copilot|llm|language model|ai agent)'

const RULES = [
  ['override', /\b(?:ignore|disregard|forget|override|bypass|do not follow)\b.{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|system|safety)\b.{0,30}\b(?:instructions?|prompts?|rules?|guidelines?|directions?|guardrails?)\b/i],
  ['role', /\b(?:(?:reveal|print|repeat|show me) your (?:system prompt|instructions)|new instructions? for (?:the |you, )?(?:ai|assistant|agent|claude)|you are now (?:an? )?(?:unrestricted|jailbroken|dan\b|in (?:developer|admin|god) mode))\b/i],
  ['addressed', new RegExp(`\\b${ASSISTANT}\\b[,:!\\s-]{1,4}(?:reading this[,:\\s]+)?(?:please\\s+|you must\\s+|you should\\s+|must\\s+|immediately\\s+)*(?:forward|send|email|reply|delete|run|execute|ignore|click|share|upload|post|transfer|exfiltrate|reveal)\\b`, 'i')],
  ['exfiltrate', /\b(?:forward|send|email|upload|post|share|leak|exfiltrate)\b.{0,50}\b(?:all|every|entire|any)\b.{0,30}\b(?:emails?|messages?|inbox|contacts?|passwords?|api keys?|tokens?|credentials?|secrets?|notes|second brain)\b.{0,40}\b(?:to|at)\b/i],
  ['markup', /<\/?(?:system|assistant|tool_call|function_calls|instructions)\b[^>]*>|\[\/?(?:INST|SYSTEM)\]|<\|im_(?:start|end)\|>/i],
]

export const cleanText = s => String(s).replace(INVISIBLE, '')

function rulesHit(text, hits) {
  for (const [code, rule] of RULES) if (rule.test(text) && !hits.includes(code)) hits.push(code)
}

// Returns the kinds of trick found, as short codes. Never echoes the text itself.
export function scanText(raw) {
  const hits = []
  const original = String(raw ?? '')
  if (HIDDEN.test(original)) hits.push('hidden-text')
  const text = cleanText(original).normalize('NFKC').replace(/\s+/g, ' ')
  rulesHit(text, hits)
  for (const blob of (text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []).slice(0, 20)) {
    const before = hits.length
    rulesHit(Buffer.from(blob, 'base64').toString('utf8').replace(/\s+/g, ' '), hits)
    if (hits.length > before) hits.push('encoded')
  }
  return hits
}

// Things the owner wrote themselves are full of prompts on purpose, so only outside text is scanned.
export const shouldScan = source => !OWN_WORDS.has(String(source))

// Names reach every session's briefing, so a name must look like a name, not an order.
const NAME_SHAPE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'\u2019&+/-]*$/u
const ORDER_WORDS = new Set('approve allow ignore disregard forget override bypass send forward reply delete remove run execute install click open must always never urgent instruction instructions password passwords'.split(' '))

export function safeName(raw) {
  const name = cleanText(raw).replace(/\s*<[^>]*>\s*$/, '').replace(/\s+/g, ' ').trim()
  if (!name || name.length > 60 || !NAME_SHAPE.test(name) || name.split(' ').length > 6 || scanText(name).length) return null
  return name.toLowerCase().split(/[^\p{L}]+/u).some(w => ORDER_WORDS.has(w)) ? null : name
}

// --- 2. The lock on the nightly run ---

const FIRST_LINES = 6
const WRAPPER = /^\s*<scheduled-task name="([^"]*)"(?: file="([^"]*)")?/

function firstPrompt(line) {
  let entry
  try { entry = JSON.parse(line) } catch {
    // A very long first line is cut off by the read below; its start is still there.
    const m = /^\{"type":"queue-operation".*?"content":"((?:\\.|[^"\\]){0,2000})/.exec(line)
    return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null
  }
  if (entry.type === 'queue-operation' && typeof entry.content === 'string') return entry.content
  if (entry.type !== 'user') return null
  const c = entry.message?.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.find(p => p.type === 'text')?.text ?? null : null
}

const isSubAgent = file => posix(file).includes('/subagents/')

function transcriptOf(input) {
  const given = String(input.transcript_path ?? '')
  const id = String(input.session_id ?? '')
  if (isSubAgent(given)) {
    const session = given.slice(0, posix(given).indexOf('/subagents/'))
    if (fs.existsSync(`${session}.jsonl`)) return `${session}.jsonl`
  }
  if (path.basename(given) === `${id}.jsonl`) return given
  let dir = path.dirname(given)
  for (let i = 0; i < 4 && id; i++) {
    const file = path.join(dir, `${id}.jsonl`)
    if (fs.existsSync(file)) return file
    dir = path.dirname(dir)
  }
  return given
}

function namesTheKeeper(prompt, root) {
  const m = WRAPPER.exec(prompt)
  if (!m) return false
  if (m[1].includes('brain-keeper')) return true
  const touchesBrain = text => ['BRAIN_KEEPER.md', 'kit/brain.mjs', 'organizer-nightly', ...(root ? [root, path.basename(root)] : [])].some(s => text.includes(s))
  if (touchesBrain(prompt)) return true
  // Any scheduled task that works on the brain gets the lock, whatever it is called.
  if (!m[2]) return false
  try { return touchesBrain(fs.readFileSync(m[2], 'utf8')) } catch { return true }
}

// The app writes the scheduled wrapper as the very first thing in the session, before anything
// has been read, and the keeper cannot write to the transcript. So text in an email can never
// switch this off, and nothing typed later in an ordinary session can switch it on.
export function isKeeper(input, root) {
  const fd = fs.openSync(transcriptOf(input), 'r')
  try {
    const buf = Buffer.alloc(65536)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, n).toString('utf8').split('\n').slice(0, FIRST_LINES)) {
      const prompt = firstPrompt(line)
      if (prompt !== null) return namesTheKeeper(prompt, root)
    }
    return false
  } finally { fs.closeSync(fd) }
}

const posix = p => String(p).split(path.sep).join('/')

function realish(p) {
  let cur = path.resolve(p)
  const rest = []
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest) } catch {}
    const up = path.dirname(cur)
    if (up === cur) return path.resolve(p)
    rest.unshift(path.basename(cur))
    cur = up
  }
}

const inside = (dir, file) => { const rel = path.relative(dir, file); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }

// Everything the keeper may do is listed here. Anything not listed is refused.
const TOOLS = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Agent', 'Task', 'TaskOutput', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TodoWrite', 'ToolSearch'])
const READ_TOOLS = new Set([
  'search_threads', 'get_thread', 'get_message', 'list_labels',
  'search_files', 'read_file_content', 'get_file_metadata', 'list_recent_files',
  'list_events', 'get_event', 'list_calendars', 'search_events',
  'search-designs', 'search-folders', 'list-folder-items', 'get-design', 'get-design-content',
  'notion-search', 'notion-fetch',
])
const NEVER_SERVER = /computer|browser|chrome|terminal|filesystem|shell|fetch|postgres|sql|scheduled|^ccd_/i
const WRITE_WORD = new Set('send reply forward delete trash remove create update edit write share post publish move archive label unlabel mark modify add set accept decline rsvp invite upload copy rename put patch draft cancel book pay charge submit apply merge comment schedule run execute start stop empty spam unspam untrash import export login logout save'.split(' '))
const WORK_FILE = /^\.brain\/work\/(?:[hnw][a-z0-9]{0,8}|(?:[a-z0-9-]{1,40}-)?items)\.json$/

// The owner's extra read-only tools, chosen during setup. The keeper cannot write this file.
function extraTools(root) {
  try {
    return fs.readFileSync(path.join(root, '.brain', 'approved-tools.txt'), 'utf8').split('\n').map(l => l.trim())
      .filter(l => /^[A-Za-z0-9_-]{1,80}$/.test(l) && !l.toLowerCase().split(/[-_]/).some(w => WRITE_WORD.has(w)))
  } catch { return [] }
}

function workFileProblem(root, target, cwd) {
  const rel = posix(path.relative(realish(root), realish(path.resolve(cwd || root, String(target ?? ''))))).toLowerCase()
  return WORK_FILE.test(rel) ? null : 'the keeper only writes its batch files in .brain/work (for example gmail-items.json or h1.json); everything else goes through a kit command'
}

// A deliberately small reading of a command: one plain word list, quotes allowed, and anything a
// shell could treat as special refused outright rather than interpreted.
export function plainWords(command) {
  const text = String(command).trim().replace(/\s+(?:2>&1|2>\/dev\/null)$/, '')
  const words = []
  let word = null
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '$' || c === '`' || c === '!' || (c === '\\' && process.platform !== 'win32')) return null
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue }
    if (c === ' ') { if (word !== null) words.push(word); word = null; continue }
    if (c === '&' && text[i + 1] === '&' && word === null) { words.push('&&'); i++; continue }
    if (!/[A-Za-z0-9_./:=,@%+-]/.test(c)) return null
    word = (word ?? '') + c
  }
  if (quote) return null
  if (word !== null) words.push(word)
  return words
}

const NUMBER = /^\d{1,7}$/
const WORKER = /^n[a-z0-9]{0,8}$/
const VERBS = {
  status: {}, refresh: {}, doctor: {}, repos: {}, frontdoor: {},
  'tools-update': { '--host': /^codex$/ },
  add: { '--file': 'file', '--connector': true },
  enrich: { '--worker': WORKER, '--file': 'file' },
  queue: { '--worker': WORKER, '--batch': NUMBER, positional: /^(?:next|status)$/ },
  find: { '--since': /^\d{4}-\d{2}-\d{2}$/, '--source': /^[a-z-]{1,20}$/, '--limit': NUMBER, '--json': true, positional: /^[^-]/ },
  update: { '--check': true },
  flag: { '--code': /^(?:login|decision|lock-off|new-kit)$/, '--source': /^(?:gmail|email|drive|dropbox|calendar|canva|notion|slack|other)$/ },
  log: { '--added': NUMBER, '--summarised': NUMBER, '--code': /^(?:ok|partial|stopped)$/ },
}

function kitProblem(args, root, here) {
  const [verb, ...rest] = args
  if (verb === 'guard' && rest[0] === 'canary') return 'Safety lock is on. That is correct: carry on with the next step.'
  const allowed = Object.hasOwn(VERBS, verb ?? '') ? VERBS[verb] : null
  if (verb === 'update' && !rest.includes('--check')) return 'the keeper only checks for updates'
  if (verb === 'add' && !rest.includes('--connector')) return 'the keeper saves app items with add --connector'
  if (verb === 'enrich' && !rest.includes('--worker')) return 'enrich needs --worker n1'
  if (!allowed) return `the keeper may not run ${verb ?? 'that'}`
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]
    if (word === '--brain') { if (realish(rest[++i] ?? '') !== realish(root)) return 'this is not the brain the keeper looks after'; continue }
    if (!word.startsWith('--')) { if (!(allowed.positional?.test(word))) return `${verb} does not take ${word}`; continue }
    const rule = allowed[word]
    if (rule === undefined || word === 'positional') return `${verb} does not take ${word}`
    if (rule === true) continue
    const value = rest[++i] ?? ''
    if (value.startsWith('-')) return `${word} needs a value`
    if (rule === 'file') { const why = workFileProblem(root, value, here); if (why) return why } else if (!rule.test(value)) return `${word} has a value the keeper may not use`
  }
  return null
}

function shellProblem(command, root, cwd) {
  const usage = 'the keeper only runs kit commands, in the exact form in BRAIN_KEEPER.md'
  const words = plainWords(command)
  if (!words?.length) return usage
  let rest = words
  let here = realish(cwd || root)
  if (words[0] === 'cd') {
    if (words[2] !== '&&' || realish(words[1] ?? '') !== realish(root)) return usage
    rest = words.slice(3)
    here = realish(root)
  }
  if (rest.includes('&&')) return usage
  const [node, script, ...args] = rest
  const runner = node === 'node' || (path.isAbsolute(node ?? '') && realish(node) === realish(process.execPath))
  if (!runner) return usage
  const kit = realish(path.join(root, 'kit', 'brain.mjs'))
  const ok = path.isAbsolute(script ?? '') ? realish(script) === kit : script === 'kit/brain.mjs' && here === realish(root)
  return ok ? kitProblem(args, root, here) : usage
}

function mcpProblem(tool, input, root) {
  const parts = tool.split('__')
  if (parts.length !== 3) return 'apps are read-only for the keeper'
  if (NEVER_SERVER.test(parts[1])) return 'the keeper does not use this tool'
  if (!READ_TOOLS.has(parts[2]) && !extraTools(root).includes(parts[2])) return 'apps are read-only for the keeper, and this is not a listed read tool'
  if (/:\/\//.test(JSON.stringify(input ?? {}))) return 'the keeper does not open links'
  return null
}

function readProblem(target, input, root) {
  const file = realish(path.resolve(input.cwd || root, String(target || input.cwd || '')))
  const own = transcriptOf(input).replace(/\.jsonl$/, '')
  const places = [root, path.join(os.homedir(), 'second-brain-kit'), path.join(os.homedir(), '.claude', 'scheduled-tasks'), own].filter(Boolean).map(realish)
  if (places.some(p => inside(p, file))) return null
  const uid = process.getuid?.() ?? 'x'
  return posix(file).match(new RegExp(`^(?:/private)?/tmp/claude-${uid}/`)) ? null : 'the keeper only reads inside the brain'
}

export function keeperProblem(input, root) {
  const tool = String(input.tool_name ?? '')
  const args = input.tool_input ?? {}
  if (tool.startsWith('mcp__')) return mcpProblem(tool, args, root)
  if (!TOOLS.has(tool)) return `the keeper may not use ${tool}`
  if (tool === 'Bash') return shellProblem(args.command, root, input.cwd)
  if (tool === 'Write' || tool === 'Edit') return workFileProblem(root, args.file_path, input.cwd)
  if (tool === 'Read') return readProblem(args.file_path, input, root)
  if (tool === 'Glob' || tool === 'Grep') {
    const patterns = [tool === 'Glob' ? args.pattern : '', args.glob].filter(Boolean).map(String)
    if (patterns.some(p => p.startsWith('/') || p.startsWith('~') || p.split(/[\\/]/).includes('..'))) return 'the keeper only reads inside the brain'
    return readProblem(args.path, input, root)
  }
  return null
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Second brain safety lock: ${reason}` } }) + '\n')
}

function logBlock(root, tool, reason) {
  if (process.env.SBK_GUARD_TEST) return
  try { fs.appendFileSync(path.join(root, '.brain', 'guard.log'), `${new Date().toISOString()} blocked ${tool}: ${reason}\n`) } catch {}
}

// An ordinary session always passes untouched, even if this code fails. Once a session is known
// to be the keeper, anything unexpected is refused. If the hook could not run at all, or could not
// read the transcript, `guard canary` shows it at the start of the run.
export function runGuard(root) {
  let input
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  let keeper = false
  try { keeper = isKeeper(input, root) } catch { keeper = isSubAgent(input.transcript_path ?? '') }
  if (!keeper) return
  let why
  try { why = keeperProblem(input, root) } catch { why = 'the check failed, so this is refused' }
  if (!why) return
  logBlock(root, String(input.tool_name), why)
  deny(why)
}
