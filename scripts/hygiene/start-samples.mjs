// The start screen's prose says what one run does: job first-call, a ceiling
// of 20,000 tokens, wrap(). The two samples are literals in src/routes/app.ts
// (scripts/snippets/extract.mjs executes only a literal), so nothing ties them
// to that sentence but this check: both samples must open the job
// src/ui/steps.ts names, with its agent and its ceiling, through wrap(), and
// the sentence must carry the same name and number. Prints the number of
// mismatches; run.sh gates it at 0.
import { readFileSync } from 'node:fs'

const steps = readFileSync('src/ui/steps.ts', 'utf8')
const app = readFileSync('src/routes/app.ts', 'utf8')
const one = (re, src) => (src.match(re) ?? [])[1]
const job = one(/export const FIRST_JOB = '([^']*)'/, steps)
const agent = one(/export const FIRST_AGENT = '([^']*)'/, steps)
const ceil = one(/export const FIRST_CEILING = ([0-9_]+)/, steps)
const runs = one(/export const WHAT_RUNS =\s*'([^']*)'/, steps) ?? ''
const py = one(/function pythonSample\(\)[\s\S]*?<pre class="snip">([\s\S]*?)<\/pre>/, app) ?? ''
const nd = one(/function nodeSample\(\)[\s\S]*?<pre class="snip">([\s\S]*?)<\/pre>/, app) ?? ''
const bad = []
if (!job || !agent || !ceil) bad.push('FIRST_JOB / FIRST_AGENT / FIRST_CEILING not found in src/ui/steps.ts')
else {
  if (!(py.includes('agentbill.wrap(') && py.includes(`task_ref="${job}"`) && py.includes(`agent_id="${agent}"`) && py.includes(`task_ceiling=${ceil}`)))
    bad.push(`the python sample does not open ${job} / ${agent} / ${ceil} through wrap()`)
  if (!(nd.includes('wrap(new OpenAI()') && nd.includes(`taskRef: '${job}'`) && nd.includes(`agentId: '${agent}'`) && nd.includes(`taskCeiling: ${ceil}`)))
    bad.push(`the node sample does not open ${job} / ${agent} / ${ceil} through wrap()`)
  const human = Number(ceil.replace(/_/g, '')).toLocaleString('en-US')
  if (!(runs.includes(`<code>${job}</code>`) && runs.includes(`${human} tokens`))) bad.push(`WHAT_RUNS does not name ${job} and ${human} tokens`)
}
if (bad.length) process.stderr.write('    ' + bad.join('\n    ') + '\n')
process.stdout.write(String(bad.length))
