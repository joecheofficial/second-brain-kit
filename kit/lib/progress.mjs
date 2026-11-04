// A live progress panel for the first build. It reads the checklist the agent
// already keeps in _progress.md and the brain's own counts, so it uses no model.
// Local only: it listens on 127.0.0.1, and stops by itself.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { readJson } from './notes.mjs'
import { queueStatus } from './queue.mjs'

const FIRST_PORT = 4178
const MAX_HOURS = 4
const AFTER_DONE_MINUTES = 15
const COUNTS_EVERY_MS = 15_000

// "- [x] STEP 3 Chat exports: 120 ChatGPT" -> { done: true, label: "STEP 3 Chat exports" }
export function parseProgress(text) {
  const steps = []
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*-\s*\[( |x|X|>)\]\s*(.+)$/)
    if (!m) continue
    const label = m[2].split(/:\s/)[0].trim().slice(0, 70)
    steps.push({ label, done: m[1].toLowerCase() === 'x', active: m[1] === '>' })
  }
  if (!steps.some(s => s.active)) {
    const next = steps.find(s => !s.done)
    if (next) next.active = true
  }
  const done = steps.filter(s => s.done).length
  return { steps, done, total: steps.length, percent: steps.length ? Math.round(done / steps.length * 100) : 0, finished: steps.length > 0 && done === steps.length }
}

function readProgress(root) {
  try { return parseProgress(fs.readFileSync(path.join(root, '_progress.md'), 'utf8')) } catch { return parseProgress('') }
}

let counts = { at: 0, notes: 0, done: 0, pending: 0, people: 0, projects: 0, links: 0 }
function readCounts(root) {
  if (Date.now() - counts.at < COUNTS_EVERY_MS) return counts
  try {
    const q = queueStatus(root)
    const hubs = readJson(path.join(root, 'index', 'hubs.json'), [])
    counts = {
      at: Date.now(), notes: q.notes, done: q.done, pending: q.pending,
      people: hubs.filter(h => h.kind === 'people').length,
      projects: hubs.filter(h => h.kind === 'projects').length,
      links: hubs.reduce((n, h) => n + h.links.length, 0) / 2,
    }
  } catch { counts = { ...counts, at: Date.now() } }
  return counts
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Building your second brain</title>
<style>
:root { --gold:#e9c68d; --cream:#f5efdf; --muted:#c6cbd5; --line:#e4c59030; }
* { box-sizing:border-box; margin:0 }
body { min-height:100vh; padding:22px 20px; background:radial-gradient(ellipse at 50% 0%, #18233a, #080d19 70%); color:var(--cream); font:15px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif }
h1 { font:500 25px/1.15 Georgia,serif; margin-bottom:4px }
#now { color:var(--muted); font-size:14px; min-height:21px; display:flex; gap:9px; align-items:center }
.bar { height:12px; border-radius:99px; background:#0d1724; border:1px solid var(--line); overflow:hidden; margin:16px 0 6px }
.fill { height:100%; width:0; border-radius:99px; background:linear-gradient(90deg,#b98f55,var(--gold)); transition:width .8s ease; position:relative; overflow:hidden }
.fill::after { content:''; position:absolute; inset:0; background:linear-gradient(90deg,transparent,#fff6,transparent); animation:sheen 1.8s linear infinite }
#pct { color:var(--gold); font-size:13px; text-align:right; margin-bottom:16px }
.stats { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; margin-bottom:18px }
.stat { border:1px solid var(--line); border-radius:12px; padding:9px 12px; background:#0d172480 }
.stat b { display:block; font:500 22px/1.1 Georgia,serif; color:var(--gold) }
.stat span { color:var(--muted); font-size:12px }
ul { list-style:none; padding:0 }
li { display:flex; gap:10px; align-items:center; padding:6px 0; color:var(--muted); border-top:1px solid #e4c5901a; font-size:14px }
li.done { color:#9aa3b2 } li.active { color:var(--cream); font-weight:600 }
.dot { width:16px; height:16px; flex:none; border-radius:50%; border:1.5px solid #e4c59055; display:grid; place-items:center; font-size:11px; color:#171b23 }
li.done .dot { background:var(--gold); border-color:var(--gold) }
.spin { width:16px; height:16px; flex:none; border-radius:50%; border:2px solid #e4c59040; border-top-color:var(--gold); animation:turn .8s linear infinite }
@keyframes turn { to { transform:rotate(360deg) } } @keyframes sheen { from { transform:translateX(-100%) } to { transform:translateX(100%) } }
@media (prefers-reduced-motion: reduce) { .spin,.fill::after { animation:none } }
</style></head><body>
<h1 id="title">Building your second brain</h1>
<div id="now"></div>
<div class="bar"><div class="fill" id="fill"></div></div><div id="pct"></div>
<div class="stats"><div class="stat"><b id="notes">0</b><span>notes</span></div><div class="stat"><b id="done">0</b><span>summarised</span></div><div class="stat"><b id="people">0</b><span>people</span></div><div class="stat"><b id="projects">0</b><span>projects</span></div></div>
<ul id="steps"></ul>
<script>
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]))
const n = v => Number(v || 0).toLocaleString()
async function tick() {
  try {
    const s = await (await fetch('status', { cache: 'no-store' })).json()
    const active = s.steps.find(x => x.active)
    document.getElementById('fill').style.width = s.percent + '%'
    document.getElementById('pct').textContent = s.total ? s.percent + '% (' + s.done + ' of ' + s.total + ' steps)' : ''
    document.getElementById('title').textContent = s.finished ? 'Your second brain is ready' : 'Building your second brain'
    document.getElementById('now').innerHTML = s.finished ? 'All done. Start a new session to switch it on.' : active ? '<span class="spin"></span><span>' + esc(active.label) + '</span>' : '<span class="spin"></span><span>Getting started</span>'
    for (const k of ['notes', 'done', 'people', 'projects']) document.getElementById(k).textContent = n(s.counts[k])
    document.getElementById('steps').innerHTML = s.steps.map(x => '<li class="' + (x.done ? 'done' : x.active ? 'active' : '') + '">' + (x.active ? '<span class="spin"></span>' : '<span class="dot">' + (x.done ? '&#10003;' : '') + '</span>') + '<span>' + esc(x.label) + '</span></li>').join('')
  } catch {}
}
tick(); setInterval(tick, 2000)
</script></body></html>`

export function handler(root) {
  return (req, res) => {
    if (req.url.startsWith('/status')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ...readProgress(root), counts: readCounts(root) }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  }
}

export function serveProgress(root, { log = console.log } = {}) {
  const server = http.createServer(handler(root))
  const started = Date.now()
  let finishedAt = null
  let port = FIRST_PORT
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && port < FIRST_PORT + 10) { port += 1; server.listen(port, '127.0.0.1') }
    else { log(`The progress panel could not start: ${e.message}`); process.exitCode = 1 }
  })
  server.on('listening', () => log(`Progress panel: http://127.0.0.1:${port}`))
  server.listen(port, '127.0.0.1')
  setInterval(() => {
    if (readProgress(root).finished) finishedAt ??= Date.now()
    const over = Date.now() - started > MAX_HOURS * 3_600_000
    if (over || (finishedAt && Date.now() - finishedAt > AFTER_DONE_MINUTES * 60_000)) process.exit(0)
  }, 30_000).unref?.()
}
