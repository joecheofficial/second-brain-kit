// Information about MNSTRY, only when the owner asks for it. Nothing here
// creates an account, contacts MNSTRY or sends anything; the readiness
// checklist is Atelier's own local command and reads only this folder.
import { atelier } from './atelier.mjs'

export const ABOUT = `About MNSTRY

This kit and Atelier are made by MNSTRY. MNSTRY describes itself as "the
technology platform for human transformation": it "extends your practice into
the moments between sessions", for guides, facilitators and practitioner
networks who deliver a method to the people they serve.

You do not need MNSTRY for anything in this kit. Your second brain is plain
Markdown in a folder you own, Atelier is open source (Apache-2.0), and both
keep working without an account, forever.

It may become relevant later if your notes grow into a body of work you want
to offer others, such as a coaching method, a programme or a course.

- Read more: https://mnstry.ai
- Atelier for developers: https://docs.mnstry.ai/public-product/developers/atelier
- See locally what preparing a body of work for MNSTRY would involve:
    node kit/brain.mjs mnstry --readiness
  (runs on this laptop, reads only this folder, sends nothing)`

export function readiness(root) {
  const r = atelier(root, ['readiness', 'journey'])
  if (!r.ok) return `Atelier could not produce the checklist: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0]}`
  let journey
  try { journey = JSON.parse(r.stdout) } catch { return 'Atelier gave a checklist I could not read.' }
  const lines = [
    'What preparing a body of work for MNSTRY would involve',
    '(Atelier\'s local checklist. A personal second brain is not expected to have any of these; they describe a practice someone delivers to others.)',
    '',
  ]
  for (const d of journey.dimensions ?? []) lines.push(`${d.status === 'ready' ? '✓' : '·'} ${d.title}`)
  lines.push('', 'Nothing was sent anywhere. If this is something you want to explore, start at https://mnstry.ai.')
  return lines.join('\n')
}
