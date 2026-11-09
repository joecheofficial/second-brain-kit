// A stand-in for npm in tests (BRAIN_NPM). It serves dist-tags from FAKE_TAGS
// and "installs" packages from FAKE_PKGS/<version>, linking the other
// dependencies from FAKE_DEPS. FAKE_FAIL_INSTALL=<version> makes that install fail.
import fs from 'node:fs'
import path from 'node:path'

const [cmd, ...args] = process.argv.slice(2)
// The test glob also discovers this CLI fixture without arguments.
if (!cmd && process.env.NODE_TEST_CONTEXT) process.exit(0)
if (cmd === 'view') {
  process.stdout.write(process.env.FAKE_TAGS ?? '{}')
  process.exit(0)
}
if (cmd !== 'install') { process.stderr.write(`fake npm: unsupported ${cmd}\n`); process.exit(1) }
const cwd = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
const version = pkg.devDependencies?.['@mnstry/atelier']
if (process.env.FAKE_FAIL_INSTALL === version) { process.stderr.write('fake npm: network error\n'); process.exit(1) }
const from = path.join(process.env.FAKE_PKGS, version)
if (!fs.existsSync(from)) { process.stderr.write(`fake npm: no such version ${version}\n`); process.exit(1) }
const nm = path.join(cwd, 'node_modules')
fs.rmSync(nm, { recursive: true, force: true })
fs.mkdirSync(path.join(nm, '@mnstry'), { recursive: true })
fs.cpSync(from, path.join(nm, '@mnstry', 'atelier'), { recursive: true })
for (const dep of fs.readdirSync(process.env.FAKE_DEPS)) {
  if (dep === '@mnstry' || dep.startsWith('.')) continue
  fs.symlinkSync(path.join(process.env.FAKE_DEPS, dep), path.join(nm, dep), 'dir')
}
fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@mnstry/atelier': { version, integrity: `sha512-fake-${version}` } } }, null, 2))
process.exit(0)
