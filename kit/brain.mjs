#!/usr/bin/env node
// Second brain kit: one command with a few verbs. `node kit/brain.mjs help`.
import fs from 'node:fs'
import path from 'node:path'
import { UserError, localTime, requireBrain, readJson } from './lib/notes.mjs'

const HELP = `Second brain kit

  setup [--target ~/second-brain]   Create or repair your brain (safe to re-run)
  import <zip-or-folder>           Turn a ChatGPT or Claude export into notes
  refresh                          Import new exports in inbox/, rebuild the index and
                                   the graph, save a checkpoint (the nightly routine)
  find "words" [--since YYYY-MM-DD] [--source gmail] [--limit 10] [--json]
                                   Search everything; shows where each match is
  add --json '<item>' | --file items.json
                                   Save connector items or a note (see kit/prompts/connectors.md)
  queue next --worker h1 [--batch 20] | queue status
                                   Hand a helper its next notes to summarise
  enrich --worker h1 --file results.json
                                   Write a helper's summaries and tags into the notes
  status                           Counts and what is waiting
  map [--people]                   Open the night-sky map of everything; --people opens
                                   the relationship map of your people and projects
  wire [--host codex] [--check]    Put the brain into every session (briefing, hook, skill)
  unwire [--host codex]            Remove that again
  doctor                           Check the setup and say how to fix problems
  update [--check | --apply]       Keep Atelier up to date: check, test a new release
                                   on your brain, then switch (rolls back on failure)
  mnstry [--readiness]             What MNSTRY is, and a local checklist (sends nothing)

Add --brain <folder> when running from outside the brain.`

function parse(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s)
      if (v !== undefined) out[k] = v
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
      else out[k] = true
    } else out._.push(a)
  }
  return out
}

function readInput(opts) {
  if (typeof opts.file === 'string') return fs.readFileSync(path.resolve(opts.file), 'utf8')
  if (typeof opts.json === 'string') return opts.json
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8')
  throw new UserError('Pass --file results.json, --json \'…\', or pipe JSON in.')
}

async function main() {
  const opts = parse(process.argv.slice(2))
  const [cmd, sub] = opts._
  const print = s => process.stdout.write(`${s}\n`)
  switch (cmd) {
    case undefined: case 'help': case '--help': print(HELP); return
    case 'setup': {
      const { setup, defaultTarget } = await import('./lib/setup.mjs')
      const target = typeof opts.target === 'string' ? opts.target : defaultTarget()
      const r = setup({ target, log: print })
      const { refresh } = await import('./lib/refresh.mjs')
      const rep = refresh(r.target, { log: print })
      print(`\nYour second brain is ready at ${r.target}`)
      if (rep.problems.length) print(`Problems:\n- ${rep.problems.join('\n- ')}`)
      print(`Next: put your ChatGPT and Claude export zips in ${path.join(r.target, 'inbox')} and run:\n  cd "${r.target}" && node kit/brain.mjs refresh`)
      return
    }
    case 'import': {
      const root = requireBrain(opts)
      if (!sub) throw new UserError('Which export? For example: node kit/brain.mjs import ~/Downloads/chatgpt-export.zip')
      const { importExports } = await import('./lib/import-chats.mjs')
      const r = importExports(root, sub, { force: Boolean(opts.force), log: print })
      print(`Done: ${r.created} new notes, ${r.updated} updated, ${r.unchanged} unchanged.${r.unknownFiles.length ? ` Not recognised: ${r.unknownFiles.join(', ')}.` : ''} Run refresh to update the index.`)
      return
    }
    case 'refresh': {
      const root = requireBrain(opts)
      const { refresh } = await import('./lib/refresh.mjs')
      const r = refresh(root, { log: print, commit: !opts['no-commit'] })
      const cp = r.checkpoint === 'no changes' ? 'Nothing changed, so no new checkpoint.' : r.checkpoint ? `Checkpoint ${r.checkpoint} saved: you can undo back to this point.` : 'No checkpoint saved.'
      print(`Refreshed in ${r.seconds}s. ${r.index.notes} notes, ${r.index.pending} waiting for a summary. ${cp}`)
      if (r.problems.length) { print(`Problems:\n- ${r.problems.join('\n- ')}`); process.exitCode = 1 }
      return
    }
    case 'find': {
      const root = requireBrain(opts)
      const query = opts._.slice(1).join(' ')
      const { find, formatFind } = await import('./lib/find.mjs')
      const out = find(root, query, {
        limit: Number(opts.limit) || 10,
        since: typeof opts.since === 'string' ? opts.since : undefined,
        source: typeof opts.source === 'string' ? opts.source : undefined,
        bodies: !opts.fast,
      })
      print(opts.json ? JSON.stringify(out, null, 2) : formatFind(out))
      return
    }
    case 'add': {
      const root = requireBrain(opts)
      const { addItems, parseItems } = await import('./lib/add.mjs')
      const r = addItems(root, parseItems(readInput(opts)))
      const { updateCatalog } = await import('./lib/catalog.mjs')
      updateCatalog(root, r.paths)
      print(`Saved: ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged. Searchable now.${r.skipped.length ? `\nSkipped:\n${r.skipped.map(s => `- item ${s.item}: ${s.why}`).join('\n')}` : ''}`)
      if (r.skipped.length) process.exitCode = 1
      return
    }
    case 'queue': {
      const root = requireBrain(opts)
      const q = await import('./lib/queue.mjs')
      if (sub === 'status' || !sub) { print(JSON.stringify(q.queueStatus(root), null, 2)); return }
      if (sub === 'next') {
        const batch = q.nextBatch(root, { worker: opts.worker, batch: Number(opts.batch) || 20 })
        print(JSON.stringify({ worker: opts.worker, notes: batch, done: batch.length === 0 }, null, 2))
        return
      }
      throw new UserError('Use: queue next --worker h1   or   queue status')
    }
    case 'enrich': {
      const root = requireBrain(opts)
      const { applyEnrichment } = await import('./lib/queue.mjs')
      const r = applyEnrichment(root, JSON.parse(readInput(opts)), { worker: typeof opts.worker === 'string' ? opts.worker : undefined })
      const { updateCatalog } = await import('./lib/catalog.mjs')
      updateCatalog(root, r.paths)
      print(`Applied ${r.applied}.${r.skipped.length ? ` Skipped ${r.skipped.length}:\n${r.skipped.map(s => `- ${s.path}: ${s.why}`).join('\n')}` : ''}`)
      if (r.skipped.length) process.exitCode = 1
      return
    }
    case 'status': {
      const root = requireBrain(opts)
      const { queueStatus } = await import('./lib/queue.mjs')
      const s = queueStatus(root)
      const last = readJson(path.join(root, '.brain', 'work', 'last-refresh.json'), null)
      print(`${s.notes} notes · ${s.done} summarised · ${s.pending} waiting · ${s.claimed} being worked on\nLast refresh: ${last ? localTime(last.at) : 'never'}`)
      return
    }
    case 'map': {
      const root = requireBrain(opts)
      const { buildMap, openFile } = await import('./lib/map.mjs')
      const r = buildMap(root, { rebuild: !opts['no-rebuild'] })
      print(`Map of ${r.nodes} notes: ${r.file}`)
      print(`Relationship map (${r.hubs} people and projects, ${r.hubLinks} connections): ${r.relationships}`)
      if (!opts['no-open']) openFile(opts.people ? r.relationships : r.file)
      return
    }
    case 'hook': {
      const { runHook } = await import('./lib/wiring.mjs')
      runHook(sub, typeof opts.root === 'string' ? opts.root : null)
      return
    }
    case 'wire': {
      const root = requireBrain(opts)
      const w = await import('./lib/wiring.mjs')
      const host = opts.host === 'codex' ? 'codex' : 'claude'
      const r = opts.check ? w.checkWiring({ root, host }) : w.wire({ root, host })
      print(JSON.stringify(r, null, 2))
      if (!r.ok) process.exitCode = 1
      return
    }
    case 'unwire': {
      const { unwire } = await import('./lib/wiring.mjs')
      print(JSON.stringify(unwire({ host: opts.host === 'codex' ? 'codex' : 'claude' }), null, 2))
      return
    }
    case 'doctor': {
      const root = requireBrain(opts)
      const { doctor, formatDoctor } = await import('./lib/doctor.mjs')
      const checks = doctor(root)
      print(formatDoctor(checks))
      if (checks.some(c => !c.ok)) process.exitCode = 1
      return
    }
    case 'update': {
      const root = requireBrain(opts)
      const u = await import('./lib/update.mjs')
      if (opts.check) {
        const c = u.checkForUpdate(root)
        print(c.newest
          ? `Atelier ${c.newest} is available (you have ${c.current}).${c.testedWithThisKit ? '' : ' This kit has not been tested with it yet.'}\nTo test it on your brain without changing anything: node kit/brain.mjs update`
          : `Atelier ${c.current} is the newest release.`)
        return
      }
      if (opts.apply) {
        const { refresh } = await import('./lib/refresh.mjs')
        const r = u.applyUpdate(root, { log: print, refreshFn: rt => refresh(rt, { commit: false }) })
        print(`Updated Atelier ${r.from} → ${r.to}. Your notes were not touched.${r.announcements.length ? `\n\nNew announcements from MNSTRY in this release (signed, shipped with the package):\n${r.announcements.map(a => `- ${a}`).join('\n')}` : ''}`)
        return
      }
      const r = u.prepareUpdate(root, { to: typeof opts.to === 'string' ? opts.to : undefined })
      print(u.formatPrepared(r))
      if (r.status === 'failed-checks') process.exitCode = 1
      return
    }
    case 'mnstry': {
      const root = requireBrain(opts)
      const m = await import('./lib/mnstry.mjs')
      print(opts.readiness ? m.readiness(root) : m.ABOUT)
      return
    }
    default:
      throw new UserError(`Unknown command "${cmd}".\n\n${HELP}`)
  }
}

main().catch(e => {
  if (e instanceof UserError) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; return }
  if (e instanceof SyntaxError) { process.stderr.write(`That is not valid JSON: ${e.message}\n`); process.exitCode = 2; return }
  process.stderr.write(`Something went wrong: ${e.stack ?? e}\nCopy this message to your facilitator.\n`)
  process.exitCode = 3
})
