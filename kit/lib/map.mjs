// Write the data file for the night-sky map and open it in the browser. The
// map is a local file: nothing is served or uploaded.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { atelier } from './atelier.mjs'
import { UserError, readJson, writeAtomic } from './notes.mjs'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function safeScript(value) {
  // JSON inside a <script>: escape what could end the script or the line.
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export function buildMap(root, { rebuild = true } = {}) {
  if (rebuild) {
    const g = atelier(root, ['graph'])
    if (!g.ok) throw new UserError(`Atelier could not build the graph: ${(g.stderr || g.stdout).trim().split('\n').slice(-2).join(' ')}`)
  }
  const graphFile = path.join(root, 'atelier-output', 'knowledge.graph.json')
  const graph = readJson(graphFile, null)
  if (!graph) throw new UserError('There is no graph yet. Run `node kit/brain.mjs refresh` first.')
  const plan = readJson(path.join(root, 'knowledge-plan.json'), null)
  // The distribution layer: what the person running the programme adds.
  const distribution = {
    recipes: readJson(path.join(KIT, 'map', 'distribution-recipes.json'), []),
    theme: readJson(path.join(KIT, 'map', 'distribution-theme.json'), null),
    profile: readJson(path.join(KIT, 'map', 'distribution-profile.json'), {}),
  }
  const owner = readJson(path.join(root, 'my-map.json'), {})
  // Dates for the 3D "through time" view, from the catalog.
  const dates = {}
  const catalog = path.join(root, 'index', 'notes.jsonl')
  if (fs.existsSync(catalog)) for (const line of fs.readFileSync(catalog, 'utf8').split('\n')) {
    if (!line) continue
    try { const e = JSON.parse(line); if (e.id && e.date) dates[e.id] = e.date } catch {}
  }
  const dir = path.join(root, 'map')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['index.html', 'viewer.js', 'depth.js']) fs.copyFileSync(path.join(KIT, 'map', f), path.join(dir, f))
  writeAtomic(path.join(dir, 'brain-data.js'), `window.BRAIN=${safeScript({ graph, plan, distribution, owner, dates, builtAt: new Date().toISOString() })};\n`)
  // The relationship map: only people and projects, and how they connect.
  const hubs = readJson(path.join(root, 'index', 'hubs.json'), [])
  const page = fs.readFileSync(path.join(KIT, 'map', 'relationships.template.html'), 'utf8').replace('__HUBS__', () => safeScript(hubs))
  writeAtomic(path.join(dir, 'relationships.html'), page)
  return { file: path.join(dir, 'index.html'), relationships: path.join(dir, 'relationships.html'), hubs: hubs.length, hubLinks: hubs.reduce((n, h) => n + h.links.length, 0) / 2, nodes: graph.nodes?.length ?? 0, edges: graph.edges?.length ?? 0 }
}

export function openFile(file) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : ['xdg-open', [file]]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true } catch { return false }
}
