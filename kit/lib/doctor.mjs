// Plain-language health check. Each problem comes with what to do about it.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ATELIER_VERSION, atelier, installedVersion, nodeSupported } from './atelier.mjs'
import { INBOX, NOTES, STATE, readJson } from './notes.mjs'
import { queueStatus } from './queue.mjs'

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

export function doctor(root) {
  const checks = []
  const add = (ok, what, fix) => checks.push({ ok, what, fix: ok ? null : fix })

  add(nodeSupported(), `Node.js ${process.version}`, 'Install Node 24 LTS from https://nodejs.org (22.18 or newer also works), open a new terminal, then run this again.')
  add(git(root, ['--version']).ok, 'Git installed', 'On a Mac run `xcode-select --install`; on Windows install Git from https://git-scm.com.')
  const v = installedVersion(root)
  add(Boolean(v), `Atelier ${v ?? 'not installed'}`, 'Run `npm install` inside the brain folder.')
  if (v) {
    const lc = atelier(root, ['lock', 'check'])
    add(lc.ok, 'Atelier lock matches the installed version', 'Run `npm install` in the brain folder; if that does not fix it, `node kit/brain.mjs update` or ask your facilitator.')
  }
  add(fs.existsSync(path.join(root, STATE, 'brain.json')), 'Brain set up', 'Run `node kit/brain.mjs setup --target <this folder>`.')
  add(fs.existsSync(path.join(root, '.git')), 'Local history (Git) switched on', 'Run setup again; it creates the local history.')
  const remotes = git(root, ['remote']).out
  add(!remotes, 'No online copy configured (private)', `This brain has a Git remote (${remotes.split('\n').join(', ')}). Remove it with \`git remote remove <name>\` unless you are certain it is private and intended.`)
  const gi = fs.existsSync(path.join(root, '.gitignore')) ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8') : ''
  add(/^inbox\/$/m.test(gi) && /^node_modules\/$/m.test(gi) && /^\.atelier-local\/$/m.test(gi), 'Raw exports and tool files kept out of history', 'Run setup again; it repairs .gitignore.')
  const tracked = git(root, ['ls-files', '--', INBOX, '.atelier-local']).out
  add(!tracked, 'Nothing private-raw recorded in history', `These raw files are recorded in history: ${tracked.split('\n').slice(0, 3).join(', ')}. Ask your facilitator before removing them.`)

  let notes = 0
  if (fs.existsSync(path.join(root, NOTES))) {
    const q = queueStatus(root)
    notes = q.notes
    add(true, `${q.notes} notes, ${q.done} summarised, ${q.pending} waiting`, null)
  }
  add(notes > 0, 'Some notes imported', 'Put your ChatGPT or Claude export zip in inbox/ and run `node kit/brain.mjs refresh`.')

  const last = readJson(path.join(root, STATE, 'work', 'last-refresh.json'), null)
  const hours = last ? (Date.now() - Date.parse(last.at)) / 3_600_000 : null
  add(last !== null && hours < 36, last ? `Last refresh ${Math.round(hours)} hours ago` : 'Never refreshed', 'Run `node kit/brain.mjs refresh` (and check the nightly organizer is scheduled).')
  if (last?.problems?.length) add(false, `Last refresh reported ${last.problems.length} problem(s)`, last.problems.join(' | '))

  // Updates: information only, from the last check. Doctor never goes online.
  const upd = readJson(path.join(root, STATE, 'work', 'update-check.json'), null)
  const days = upd ? (Date.now() - Date.parse(upd.checkedAt)) / 86_400_000 : null
  if (upd?.newest && upd.current === v) checks.push({ ok: true, info: true, what: `Atelier ${upd.newest} is available. To test it on your brain first: node kit/brain.mjs update`, fix: null })
  else if (days === null || days > 14) checks.push({ ok: true, info: true, what: 'Updates not checked in the last two weeks: node kit/brain.mjs update --check', fix: null })

  if (v) {
    const k = atelier(root, ['knowledge', 'check'])
    add(k.ok, 'Atelier knowledge check', `Atelier reported: ${(k.stderr || k.stdout).trim().split('\n').slice(-2).join(' ')}`)
  }
  return checks
}

export function formatDoctor(checks) {
  const lines = checks.map(c => `${c.info ? 'ℹ' : c.ok ? '✓' : '✗'} ${c.what}${c.fix ? `\n    → ${c.fix}` : ''}`)
  const bad = checks.filter(c => !c.ok).length
  lines.push('', bad ? `${bad} thing(s) to fix.` : 'All good.')
  return lines.join('\n')
}
