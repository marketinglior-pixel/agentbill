import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { docsShell } from '../ui/docs.js'
import { CONTENT_CSS } from '../ui/content.js'
import { publicRoute } from '../middleware/auth.js'
import { byPath, ORIGIN } from '../ui/site.js'
import { KEY_CTA } from '../ui/chrome.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { RESERVATION_TTL_MINUTES } from '../lib/reservations.js'
import { SDK_VERSIONS } from '../lib/llms.js'
import { cleanSource } from '../lib/source.js'
import { mcpConnectBody, MCP_CONNECT_CSS, MCP_SCRIPTS, MCP_URL } from '../ui/mcp-connect.js'

// /integrations and the pages under it, 2026-09-23.
//
// Before this file the one plugin we publish, @agentbill/openclaw on ClawHub,
// was mentioned nowhere on agentbill.dev, and the only LangChain and OpenAI
// pages taught the retired pattern (customer_id, a per-call ceiling, and an
// exception nothing has raised since 0.6.0). These pages replace those two
// (301s at the bottom) and add the plugin, the MCP server and two frameworks.
//
// What each page may claim, and how it was checked:
//
//   - The hub lists only what a registry serves today. Versions render from
//     SDK_VERSIONS, which is checked against the registries, not the repo.
//   - The OpenClaw install line, config block and log line are byte-identical
//     to plugins/openclaw/README.md, and an [integrations] gate compares them.
//   - Every framework sample (LangChain, the OpenAI Agents SDK, CrewAI) was run
//     end to end at the version in TESTED below, with a stub model and against
//     a local server, until preflight answered approved: false and the
//     framework handed the refusal back to the caller. The snippet harness
//     checks the agentbill half of each block against the SDK; it does not
//     install the frameworks, so the framework half is only as good as that
//     run. Change a sample and run it again.
//   - The mechanism is worded the same way everywhere: preflight answers, the
//     SDK raises on a ceiling refusal, and the caller's code decides. The two
//     rows without an SDK say what they do instead: the OpenClaw plugin hands
//     the refusal to OpenClaw, and the MCP server returns it as a value. Nothing
//     here says AgentBill ends a run, because nothing here can.
//
// n8n has no page: nothing we ship installs into it, so a page would be a
// claim. The [integrations] gate fails if it is named here. Claude Code was in
// the same sentence until 2026-09-25, when the remote MCP endpoint made it a
// client that connects to something we run; it is named on /integrations/mcp
// alone, beside a command checked against its current documentation.

const num = (n: number) => n.toLocaleString('en-US')

/** The framework versions each guide's sample was run against, end to end. */
const TESTED = { langchain: '1.4.2', openaiAgents: '0.22.3', crewai: '1.15.22' } as const

const CLAWHUB = 'https://clawhub.ai/agentbill/plugins/openclaw'
const REPO = 'https://github.com/marketinglior-pixel/agentbill'

/** A register link from these pages carries its own source label, so a signup
 *  that started here is not pooled with the homepage's in site_pulse. */
const cta = (src: string) => `<p class="end"><a href="/register?src=${src}" class="btn">${KEY_CTA}</a></p>`

const INTEGRATIONS_CSS = `
  /* A label bar inside a code frame, for output that is a sample and says so
     inside the frame a screenshot would carry. Typographic, not window chrome. */
  .code-h { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
            letter-spacing: .08em; text-transform: uppercase; margin-bottom: 10px; max-width: none; }
  /* The hub's install lines are longer than a name cell, so they wrap inside the
     cell instead of pushing the table past the column. */
  .hub td .inline { overflow-wrap: anywhere; }
  .hub td:first-child { white-space: normal; }
  ul.plain { padding-inline-start: 20px; margin-bottom: 16px; }
  /* A sentence the reader sees, not code: its end is the part that says what to
     do next, so it wraps instead of scrolling out of the frame. */
  .code.wrap pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  /* Stacked, the docs table runs a row's cells together on one line, which
     reads as one string on the hub. Name and kind, then the install line on its
     own, then the two links. */
  @media (max-width: 640px) {
    .hub td:nth-child(2) { color: var(--dim); }
    .hub td:nth-child(3) { display: block; margin-block: 6px; }
    .hub td:nth-child(4) { margin-inline-end: 10px; }
    .hub td:last-child { display: inline; margin-top: 0; }
  }
`

const RELATED: ReadonlyArray<readonly [path: string, label: string]> = [
  ['/integrations', 'Integrations, everything AgentBill publishes'],
  ['/integrations/openclaw', 'OpenClaw, one ceiling per session'],
  ['/integrations/langchain', 'LangChain, one ceiling per job in middleware'],
  ['/integrations/openai-agents-sdk', 'OpenAI Agents SDK, one ceiling per job in RunHooks'],
  ['/integrations/crewai', 'CrewAI, one ceiling per crew run in model-call hooks'],
  ['/integrations/mcp', 'MCP, connect Claude, ChatGPT, Cursor and more'],
  ['/docs/task-budgets', 'Task budgets, one ceiling for the whole job'],
]

function page(path: string, title: string, description: string, body: string,
              opts: { rail?: boolean; css?: string; current?: string; scripts?: Parameters<typeof docsShell>[0]['scripts'] } = {}) {
  const meta = byPath.get(path)
  return docsShell({
    title: `${title} · AgentBill`,
    description,
    path,
    rail: opts.rail,
    current: opts.current,
    scripts: opts.scripts,
    css: `${CONTENT_CSS}${INTEGRATIONS_CSS}${opts.css ?? ''}`,
    // The same TechArticle the guides emit, with dates from the registry, which
    // is also what the sitemap's lastmod reads.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      '@id': `${ORIGIN}${path}#techarticle`,
      headline: title,
      description,
      url: `${ORIGIN}${path}`,
      datePublished: meta?.published ?? meta?.updated,
      dateModified: meta?.updated,
      inLanguage: 'en-US',
      author: { '@id': `${ORIGIN}/#organization` },
      publisher: { '@id': `${ORIGIN}/#organization` },
      isPartOf: { '@id': `${ORIGIN}/#website` },
    },
    mainEntity: `${ORIGIN}${path}#techarticle`,
    body: `${body}
  <div class="also">
    <p>More integrations</p>
${RELATED.filter(([p]) => p !== path).map(([p, label]) => `    <a href="${p}">${label}</a>`).join('\n')}
  </div>`,
  })
}

type Row = { name: string; version?: string; kind: string; install: string; registry?: readonly [href: string, label: string]; page: readonly [href: string, label: string] }

// One table, and the kind column is the point of it: a guide is the plain SDK
// placed in a hook the framework already has. It is not an adapter package, and
// the table must never let "integration" read as one.
const HUB_ROWS: readonly Row[] = [
  { name: '@agentbill/openclaw', version: SDK_VERSIONS.openclaw, kind: 'Plugin', install: 'openclaw plugins install clawhub:@agentbill/openclaw',
    registry: [CLAWHUB, 'ClawHub'], page: ['/integrations/openclaw', 'OpenClaw'] },
  { name: 'AgentBill MCP', kind: 'Remote MCP server', install: MCP_URL, page: ['/integrations/mcp', 'Connect'] },
  { name: 'agentbill-mcp', version: SDK_VERSIONS.mcp, kind: 'Package, local MCP server', install: 'uvx agentbill-mcp',
    registry: ['https://pypi.org/project/agentbill-mcp/', 'PyPI'], page: ['/integrations/mcp#other', 'Run it locally'] },
  { name: 'agentbill-sdk', version: SDK_VERSIONS.python, kind: 'Package, Python SDK', install: 'pip install agentbill-sdk',
    registry: ['https://pypi.org/project/agentbill-sdk/', 'PyPI'], page: ['/docs', 'Quick start'] },
  { name: 'agentbill', version: SDK_VERSIONS.node, kind: 'Package, Node SDK', install: 'npm install agentbill',
    registry: ['https://www.npmjs.com/package/agentbill', 'npm'], page: ['/docs#node-js', 'Node.js'] },
  { name: 'HTTP API', kind: 'API', install: 'POST /preflight with a Bearer key',
    page: ['/docs#api-reference', 'API reference'] },
  { name: 'LangChain', kind: 'Guide', install: `pip install agentbill-sdk "langchain==${TESTED.langchain}"`,
    page: ['/integrations/langchain', 'LangChain'] },
  { name: 'OpenAI Agents SDK', kind: 'Guide', install: `pip install agentbill-sdk "openai-agents==${TESTED.openaiAgents}"`,
    page: ['/integrations/openai-agents-sdk', 'OpenAI Agents SDK'] },
  { name: 'CrewAI', kind: 'Guide', install: `pip install agentbill-sdk "crewai==${TESTED.crewai}"`,
    page: ['/integrations/crewai', 'CrewAI'] },
]

const hubRow = (r: Row) => `      <tr><td>${r.name}${r.version ? ` <span class="tag">${r.version}</span>` : ''}</td><td>${r.kind}</td>`
  + `<td><span class="inline">${r.install}</span></td>`
  + `<td>${r.registry ? `<a href="${r.registry[0]}" rel="noopener">${r.registry[1]}</a>` : r.kind === 'Guide' ? 'uses agentbill-sdk' : 'none'}</td>`
  + `<td><a href="${r.page[0]}">${r.page[1]}</a></td></tr>`

export async function integrationsRoute(app: FastifyInstance) {

  app.get('/integrations', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/integrations',
      'Integrations: OpenClaw plugin, MCP server, SDKs and guides',
      'What AgentBill publishes and where to install it: the OpenClaw plugin on ClawHub, the MCP server and the Python SDK on PyPI, the Node SDK on npm, the HTTP API, and guides for LangChain, the OpenAI Agents SDK and CrewAI that use the plain SDK.',
      `
  <h1>Integrations</h1>
  <p class="lede">Every package below is published from one repository,
  <a href="${REPO}" rel="noopener">github.com/marketinglior-pixel/agentbill</a>. The rows marked
  Guide are not packages: each is the plain Python SDK placed in a hook that framework already has.
  Any code that can make one HTTP call before its provider call can use the API directly.</p>

  <div class="hub">
  <table>
    <thead><tr><th>Name</th><th>Kind</th><th>Install</th><th>Registry</th><th>Our page</th></tr></thead>
    <tbody>
${HUB_ROWS.map(hubRow).join('\n')}
    </tbody>
  </table>
  </div>
  <p>Each version is what its registry serves, not what the repository holds.</p>

  <h2>Which one fits</h2>
  <p><b>Your agent runs inside OpenClaw.</b> Install the plugin. It asks one ceiling before every
  tool call in a session, and before every model turn on OpenClaw's embedded and CLI runners.
  OpenClaw does not run a tool or send a turn the ceiling refused. On the Codex and Copilot
  harnesses only tool calls are asked; the <a href="/integrations/openclaw">OpenClaw page</a> says
  why.</p>
  <p><b>Your agent is code you own.</b> Put preflight and record where your code, or your
  framework, calls the model. The guides show where that is in LangChain, the OpenAI Agents SDK and
  CrewAI, with samples that were run against the framework versions in the table.</p>
  <p><b>Your agent host speaks MCP.</b> Connect it to <span class="inline">${MCP_URL}</span>: Claude and
  ChatGPT with a sign-in, Cursor and VS Code in one click, the rest with one command or a few lines
  of config, on the <a href="/integrations/mcp">MCP page</a>. The model gets a preflight tool it can
  consult and read tools for where the units went. The model decides whether to call preflight, and it
  does not limit the host's own model calls.</p>
  <p><b>Anything else.</b> <span class="inline">POST /preflight</span> with a Bearer key, before
  the call; <span class="inline">POST /events</span> after it. The whole contract is in the
  <a href="/docs#api-reference">API reference</a>.</p>

  <h2>What every row has in common</h2>
  <p>The ceiling is bound to a <span class="inline">task_ref</span>, the name you give a job, and
  every call that passes it draws on the same number, whichever process, agent or provider made it.
  Before a call, preflight answers, and when the call would pass the ceiling it answers
  <span class="inline">approved: false</span>. <a href="/docs/task-budgets">Task budgets</a>
  explains the mechanism.</p>
  <p>What reaches you then depends on the row. With the Python and Node SDKs, and the guides built
  on them, the SDK raises <span class="inline">TaskCeilingExceededError</span> and your code
  decides what the job does next. The OpenClaw plugin hands the refusal to OpenClaw, and the MCP
  server returns it to the model as a value. Over the HTTP API, the answer is the JSON body.</p>
  <p>Units are integers you assign to each call, except in the OpenClaw plugin's tokens mode, which
  counts the token totals OpenClaw reports. AgentBill never reads your provider bill.</p>

  ${cta('integrations')}
`,
      { rail: false },
    ))
  })

  // Priority one: the plugin we publish. The claims here are the plugin's code
  // (plugins/openclaw/src/ceiling.ts), not its README's first paragraph, which
  // says the run "stops": the host is what declines to send the turn, and the
  // plugin is what hands it the refusal. { outcome: 'block' } is OpenClaw's
  // field name and stays in OpenClaw's code, not in this page's sentences.
  //
  // Two limits of the host, from openclaw 2026.9.4, that every sentence here
  // keeps. before_agent_run runs once per turn, before the agent loop, and only
  // on the embedded and CLI runners (docs/plugins/hooks.md: not a Codex or
  // Copilot input gate). llm_output reports once per run attempt with the
  // attempt's usage summed, so the model calls inside a turn are recorded
  // together after they run and are never asked one by one.
  app.get('/integrations/openclaw', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/integrations/openclaw',
      'OpenClaw spend limit: one ceiling per session, as a ClawHub plugin',
      'Install @agentbill/openclaw from ClawHub and every tool call in an OpenClaw session asks one ceiling before it runs, and so does every model turn on the embedded and CLI runners. OpenClaw does not run a refused tool call or send a refused turn.',
      `
  <h1>OpenClaw spend limit, one ceiling per session</h1>
  <span class="badge">OpenClaw plugin</span><span class="badge">ClawHub ${SDK_VERSIONS.openclaw}</span>
  <p class="lede">One ceiling per OpenClaw session. Before every tool call, and before every model
  turn on OpenClaw's embedded and CLI runners, the plugin asks AgentBill whether the session's
  running total plus an estimate of what comes next would pass it. When it would, preflight answers
  <span class="inline">approved: false</span>, the plugin hands that refusal to OpenClaw's gate
  hook, and OpenClaw does not run the tool or send the turn. On the Codex and Copilot harnesses
  OpenClaw does not run <span class="inline">before_agent_run</span>, so only tool calls are
  asked.</p>

  <h2>Install</h2>
  <div class="code"><pre>openclaw plugins install clawhub:@agentbill/openclaw</pre></div>
  <p>The package is <span class="inline">@agentbill/openclaw</span> on ClawHub. Its plugin id, and
  the key under <span class="inline">plugins.entries</span> in your OpenClaw config, is
  <span class="inline">agentbill</span>.</p>
  <p>Then give it a key. <a href="/register?src=integrations-openclaw">Create a free one</a>
  (${num(PLAN_LIMITS.free)} preflight calls a month, no card) and put it in the plugin config, or set
  <span class="inline">AGENTBILL_API_KEY</span> in the Gateway's environment and leave
  <span class="inline">apiKey</span> out.</p>
  <div class="code"><pre>{
  "plugins": {
    "entries": {
      "agentbill": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "apiKey": "agb_...",
          "ceilingUnits": 500000
        }
      }
    }
  }
}</pre></div>
  <p><span class="inline">agb_...</span> stands for your key.
  <span class="inline">ceilingUnits</span> is each session's ceiling, in the unit described
  below.</p>

  <h2>Set allowConversationAccess, or model turns go unasked</h2>
  <p>The <span class="inline">hooks.allowConversationAccess</span> line is not optional. Unless the
  operator sets it, OpenClaw does not register <span class="inline">before_agent_run</span> or
  <span class="inline">llm_output</span> for a plugin it does not bundle, and it registers the other
  five hooks without saying so. Tool calls are then asked about and model turns are not, and in
  tokens mode nothing is recorded, so the ceiling never moves. The plugin checks the flag when it
  loads, and when it is missing it logs an error naming the command to run:</p>
  <div class="code"><pre>openclaw config set plugins.entries.agentbill.hooks.allowConversationAccess true</pre></div>
  <p>Restart the Gateway, then list the typed hooks the host accepted:</p>
  <div class="code"><pre>openclaw plugins inspect agentbill --runtime</pre></div>
  <p>The Gateway log line
  <span class="inline">[agentbill] ceiling 500000 tokens per session, ... conversation hooks allowed</span>
  means it is on. Uninstalling the plugin removes its whole
  <span class="inline">plugins.entries.agentbill</span> entry, the flag with it, so set it again
  after a reinstall.</p>
  <p>With the flag set, model turns are asked only where OpenClaw runs
  <span class="inline">before_agent_run</span>, which is its embedded and CLI runners. On the Codex
  and Copilot harnesses OpenClaw does not run that hook, so only tool calls are asked and each
  model turn goes to the model unasked.</p>

  <h2>What one unit is</h2>
  <p><span class="inline">units: "tokens"</span> is the default. After a model turn runs, the plugin
  records the usage total OpenClaw reports for it in its <span class="inline">llm_output</span>
  hook, which covers every model call in the turn, so what counts against the ceiling is the host's
  own number, not an estimate you write. Before a call it reserves an estimate:
  <span class="inline">estimateUnits</span> for a session's opening call, then the session's running
  average of what those reports came to. Tool calls record nothing in tokens mode; the model calls
  around them are what cost.</p>
  <p><span class="inline">units: "calls"</span> counts one unit for each
  <span class="inline">llm_output</span> report and one for each tool call. OpenClaw's embedded
  runner makes that report once per model turn (once per attempt, if it retries one), however many
  model calls the turn made, so a ceiling of 40 is forty turns and tool calls together, not forty
  provider requests.</p>
  <p>The plugin measures no provider and no tool. It records what OpenClaw already counts.</p>

  <h2>What a refusal looks like</h2>
  <p>Before a model turn, preflight answers <span class="inline">approved: false</span> with
  <span class="inline">task_ceiling_exceeded</span>. The plugin returns its sentence from OpenClaw's
  <span class="inline">before_agent_run</span> gate, OpenClaw does not send the prompt to the model,
  and the session shows the sentence inside a label of OpenClaw's own:</p>
  <div class="code wrap"><p class="code-h">Sample, a session past its ceiling</p><pre><span class="out-dim">AgentBill refused (task_ceiling_exceeded): openclaw:agent:main:discord:1234 is at 501200/500000 tokens. Raise the ceiling at https://agentbill.dev/app or start a new session.</span></pre></div>
  <p>Before a tool call, the plugin returns the same sentence from
  <span class="inline">before_tool_call</span>, OpenClaw does not run the tool, and the model
  receives the sentence as the tool's result.</p>
  <p>The session itself stays open. The next inbound message starts a new turn, and that turn asks
  again: raise the ceiling in the console and it goes through, or start a new session, which has a
  ceiling of its own.</p>

  <h2>Loops, subagents and fan-out</h2>
  <p>A tool loop inside one session is one task_ref already. Every tool call asks before it runs,
  and on the embedded and CLI runners every new model turn asks before the model sees it. The
  model calls inside a turn are not asked one by one: their usage is recorded after they run, from
  the total OpenClaw reports, so a turn can end past the ceiling, as the session in the sample above
  did. A refused tool call goes back to the model as the tool's result, and that model call runs
  too. Once the total is past the ceiling, the next tool call is refused, and so is the next turn
  wherever turns are asked. The ceiling has no clock. It does not refill at the top of an hour or a
  month, so a session that has spent it is refused until you raise it.</p>
  <p>A subagent draws on its parent's ceiling when OpenClaw reports which session spawned it: the
  plugin reads <span class="inline">requesterSessionKey</span> from the
  <span class="inline">subagent_spawned</span> context and links the child to the parent's
  task_ref, so a fan-out consults one number. When OpenClaw does not report it, the child session
  gets a ceiling of its own rather than none.</p>

  <h2>How it maps onto OpenClaw's hooks</h2>
  <table>
    <thead><tr><th>Hook</th><th>Kind</th><th>What the plugin does</th></tr></thead>
    <tbody>
      <tr><td>session_start</td><td>observe</td><td>Opens the session's task_ref, <span class="inline">openclaw:</span> plus the session key.</td></tr>
      <tr><td>subagent_spawned</td><td>observe</td><td>Links the child session to the parent's task_ref.</td></tr>
      <tr><td>before_agent_run</td><td>gate</td><td>Calls preflight. On a refusal, returns the refusal sentence to OpenClaw. Run by the embedded and CLI runners only.</td></tr>
      <tr><td>before_tool_call</td><td>gate</td><td>Calls preflight. On a refusal, returns the refusal sentence to OpenClaw.</td></tr>
      <tr><td>llm_output</td><td>observe</td><td>Records the usage total OpenClaw reports.</td></tr>
      <tr><td>after_tool_call</td><td>observe</td><td>Records <span class="inline">toolCallUnits</span>, when above zero.</td></tr>
      <tr><td>session_end</td><td>observe</td><td>Forgets the session.</td></tr>
    </tbody>
  </table>
  <p>Hook names and kinds are OpenClaw's, from its hook reference for openclaw 2026.9.4.</p>

  <h2>When AgentBill cannot be reached, or its own quota is spent</h2>
  <p><span class="inline">failMode</span> is <span class="inline">closed</span> by default: if
  AgentBill cannot be reached, the plugin refuses the call and says why. Set it to
  <span class="inline">open</span> to let calls run, with a log line, while AgentBill is
  unreachable. <span class="inline">timeoutMs</span> caps each request, and the plugin keeps it
  under the 15 seconds OpenClaw allows a gate hook, so a refusal arrives with a reason rather than
  as a timeout.</p>
  <p>AgentBill's own monthly quota is a different thing from your ceiling. When it is spent,
  preflight answers <span class="inline">free_tier_exceeded</span> or
  <span class="inline">plan_limit_exceeded</span>, and the plugin lets the call run and logs one
  warning per session with the upgrade link. Our billing state is never the reason a turn of yours
  is refused.</p>

  <h2>Raising or lowering one session's ceiling</h2>
  <p><span class="inline">ceilingUnits</span> applies when a session's task is opened. After that
  the ceiling is the server's, and a later value in the plugin config is not applied to a session
  that already has one. Change it in the <a href="/app">console</a>, or with
  <span class="inline">PUT /tasks/:task_ref/ceiling</span>, where the task_ref is
  <span class="inline">openclaw:</span> followed by the session key:</p>
  <div class="code"><pre>curl -X PUT "https://agentbill.dev/tasks/openclaw:agent:main:discord:1234/ceiling" \\
  -H "Authorization: Bearer $AGENTBILL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"ceiling_units":800000}'</pre></div>
  <p>A ceiling below what the session has already used and reserved is answered with
  <span class="inline">409 ceiling_below_committed</span>, which carries the smallest value that
  would be accepted.</p>

  <h2>What it does not do</h2>
  <ul class="plain">
    <li>It measures no provider and reads no bill. In tokens mode it records the usage OpenClaw
    reports; in calls mode it counts calls.</li>
    <li>It cannot reach into a turn that is already running. It asks before the next one.</li>
  </ul>

  <h2>Source and listing</h2>
  <p>The listing is on ClawHub at
  <a href="${CLAWHUB}" rel="noopener">clawhub.ai/agentbill/plugins/openclaw</a>. The source is in
  <a href="${REPO}/tree/main/plugins/openclaw" rel="noopener">plugins/openclaw</a> in the AgentBill
  repository, and its README carries the full options table.</p>

  ${cta('integrations-openclaw')}
`,
    ))
  })

  // The samples below were run as written, with a stub chat model in place of
  // model and tools, against a local server, until the middleware's preflight
  // raised and agent.invoke raised it to the caller.
  app.get('/integrations/langchain', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/integrations/langchain',
      'LangChain agent budget limit: one ceiling per job, checked in middleware',
      'A LangChain v1 wrap_model_call middleware that asks AgentBill before each model call, with the task_ref taken from the job. ModelCallLimitMiddleware counts calls; this ceiling counts the units you assign, across every process working on the job.',
      `
  <h1>LangChain agent budget limit, checked in middleware</h1>
  <span class="badge">Python</span><span class="badge">LangChain ${TESTED.langchain}</span>
  <p class="lede">A <span class="inline">wrap_model_call</span> middleware that asks AgentBill
  before each model call your LangChain agent makes, with the job's
  <span class="inline">task_ref</span>. When the call would pass the job's ceiling, the SDK raises,
  the model call does not go out, and your code decides what the job does next.</p>

  <h2>Use the call limits LangChain ships</h2>
  <p>LangChain v1 ships <span class="inline">ModelCallLimitMiddleware</span> and
  <span class="inline">ToolCallLimitMiddleware</span>. Each takes a
  <span class="inline">thread_limit</span> and a <span class="inline">run_limit</span>, and each
  counts calls: model calls or tool calls. LangGraph's <span class="inline">recursion_limit</span>
  caps the steps one invocation may take. Use them.</p>
  <p>They are bound to a thread or to one invocation, and they count calls. The ceiling below is
  bound to a task_ref, the name of the job, in units you assign to each call. Every process,
  worker and agent that passes the same task_ref draws on the same number.</p>

  <h2>Install</h2>
  <div class="code"><pre>pip install agentbill-sdk "langchain==${TESTED.langchain}"</pre></div>
  <p>Give the job its ceiling before the agent runs, in the <a href="/app">console</a> or with
  <span class="inline">PUT /tasks/:task_ref/ceiling</span>, so the code below carries no budget.
  The samples on this page were run end to end against langchain ${TESTED.langchain} and
  agentbill-sdk ${SDK_VERSIONS.python}, with a stub model in place of a provider.</p>

  <h2>The middleware</h2>
  <p>Before each model call it asks with the job's task_ref and what one call is worth to you. A
  refusal raises <span class="inline">TaskCeilingExceededError</span> inside the middleware, so
  <span class="inline">handler(request)</span> is never called and that model call does not go
  out. After the call, <span class="inline">record</span> settles the units preflight reserved.</p>
  <div class="code"><pre>import os
from dataclasses import dataclass
from agentbill import AgentBillClient
from langchain.agents import create_agent
from langchain.agents.middleware import wrap_model_call

client = AgentBillClient(api_key=os.environ["AGENTBILL_API_KEY"])
UNITS = 12  <span class="comment"># what one model call is worth to you, in your own units</span>


@dataclass
class Job:
    task_ref: str  <span class="comment"># the job's name, e.g. "job-142"</span>


@wrap_model_call
def agentbill_ceiling(request, handler):
    job = request.runtime.context.task_ref
    <span class="comment"># Raises TaskCeilingExceededError when this call would pass the job's</span>
    <span class="comment"># ceiling, so handler(request) never runs and no model request goes out.</span>
    client.preflight(agent_id="researcher", task_ref=job, estimated_units=UNITS)
    try:
        response = handler(request)
    except Exception:
        <span class="comment"># The model call failed: release the reservation, spend nothing.</span>
        client.record(agent_id="researcher", task_ref=job, units=UNITS, success=False)
        raise
    client.record(agent_id="researcher", task_ref=job, units=UNITS)
    return response


agent = create_agent(model, tools=tools, middleware=[agentbill_ceiling], context_schema=Job)</pre></div>
  <p><span class="inline">model</span> is any LangChain chat model and
  <span class="inline">tools</span> your tool list. <span class="inline">UNITS</span> is your own
  estimate for one model call.</p>

  <h2>Run a job, and decide what a refusal means</h2>
  <div class="code"><pre>from agentbill import TaskCeilingExceededError

try:
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "Research the topic"}]},
        context=Job(task_ref="job-142"),
    )
except TaskCeilingExceededError as e:
    <span class="comment"># Your code decides: keep what the agent had, retry smaller, or tell a person.</span>
    print(f"{e.task_ref} was refused at {e.task_used_units}/{e.task_ceiling} units")</pre></div>
  <p>The exception carries <span class="inline">task_ref</span>,
  <span class="inline">task_ceiling</span>, <span class="inline">task_used_units</span> and
  <span class="inline">task_remaining_units</span>, so the handler can say what happened without a
  second call.</p>

  <h2>Or let the run finish with an answer</h2>
  <p>If you would rather the agent end normally, catch the refusal inside the middleware and return
  a message instead of calling the model. A reply with no tool calls ends the agent's loop, and
  <span class="inline">invoke</span> returns everything the run had until then.</p>
  <div class="code"><pre>from langchain.messages import AIMessage
from agentbill import TaskCeilingExceededError


@wrap_model_call
def agentbill_ceiling_or_finish(request, handler):
    job = request.runtime.context.task_ref
    try:
        client.preflight(agent_id="researcher", task_ref=job, estimated_units=UNITS)
    except TaskCeilingExceededError as e:
        <span class="comment"># No model call. This reply ends the loop with the messages so far.</span>
        return AIMessage(content=f"Refused at {e.task_used_units}/{e.task_ceiling} units for {e.task_ref}.")
    try:
        response = handler(request)
    except Exception:
        client.record(agent_id="researcher", task_ref=job, units=UNITS, success=False)
        raise
    client.record(agent_id="researcher", task_ref=job, units=UNITS)
    return response</pre></div>

  <h2>Two workers, one job</h2>
  <p>Run the same job from two processes and pass the same task_ref from both. Each reservation is
  one conditional UPDATE on the job's row, so when the last units remain and both ask, one is
  approved and the other is refused. There is no lock to write in your code.</p>

  <h2>Async agents</h2>
  <p>The client is synchronous. In an async agent, write the middleware as
  <span class="inline">async def</span> and run the two calls in a thread, so the event loop keeps
  going while AgentBill answers. Then call <span class="inline">agent.ainvoke</span>.</p>
  <div class="code"><pre>import asyncio


@wrap_model_call
async def agentbill_ceiling_async(request, handler):
    job = request.runtime.context.task_ref
    await asyncio.to_thread(lambda: client.preflight(
        agent_id="researcher", task_ref=job, estimated_units=UNITS))
    try:
        response = await handler(request)
    except Exception:
        await asyncio.to_thread(lambda: client.record(
            agent_id="researcher", task_ref=job, units=UNITS, success=False))
        raise
    await asyncio.to_thread(lambda: client.record(
        agent_id="researcher", task_ref=job, units=UNITS))
    return response</pre></div>
  <p>Do not put <span class="inline">@client.gate</span> on an
  <span class="inline">async def</span>: the decorator is synchronous, so it would settle before the
  coroutine runs.</p>

  <h2>LangGraph</h2>
  <p>In a graph you build yourself, put the same pair inside the node that calls the model, and read
  the task_ref from the run's config.</p>
  <div class="code"><pre>from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, MessagesState, StateGraph


def call_model(state: MessagesState, config: RunnableConfig):
    job = config["configurable"]["task_ref"]
    client.preflight(agent_id="researcher", task_ref=job, estimated_units=UNITS)
    try:
        reply = model.invoke(state["messages"])
    except Exception:
        client.record(agent_id="researcher", task_ref=job, units=UNITS, success=False)
        raise
    client.record(agent_id="researcher", task_ref=job, units=UNITS)
    return {"messages": [reply]}


graph = (StateGraph(MessagesState).add_node("model", call_model)
         .add_edge(START, "model").add_edge("model", END).compile())
graph.invoke({"messages": [{"role": "user", "content": "Research the topic"}]},
             config={"configurable": {"task_ref": "job-142"}})</pre></div>

  <h2>Settling, and what a crash does</h2>
  <p><span class="inline">record</span> settles the units preflight reserved for that task_ref, in
  the order they were reserved, so record the number you reserved. A smaller number leaves the rest held
  until the reservation expires, ${RESERVATION_TTL_MINUTES} minutes by default. If the model call
  raises, the middleware releases the reservation with <span class="inline">success=False</span>.
  If the process dies between the two calls, the reservation expires on its own and its units come
  back. Until then the job's ceiling is tighter, never looser.</p>

  <h2>What it does not do</h2>
  <ul class="plain">
    <li>It does not count tokens. <span class="inline">UNITS</span> is the number you assign to one
    call.</li>
    <li>It does not meter the provider or read its bill.</li>
    <li>It does not end the run. Preflight answers, the SDK raises, and your code decides.</li>
    <li>A refusal from AgentBill's own monthly quota is returned, not raised, so this middleware
    lets that call run. Check <span class="inline">approved</span> on what preflight returns if you
    want a different rule.</li>
  </ul>

  ${cta('integrations-langchain')}
`,
    ))
  })

  // RunHooks.on_llm_start is awaited before the model request in Runner.run
  // (openai-agents 0.22.3, run_internal/run_loop.py), and the run above shows a
  // TaskCeilingExceededError raised there reaching the caller of Runner.run.
  app.get('/integrations/openai-agents-sdk', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/integrations/openai-agents-sdk',
      'OpenAI Agents SDK spending limit per job, checked before each model call',
      'A RunHooks class that asks AgentBill in on_llm_start, before each model request Runner.run makes, with one task_ref for the whole job. Keep OpenAI\'s spend limits and max_turns; this ceiling is bound to the job.',
      `
  <h1>OpenAI Agents SDK spending limit, one ceiling per job</h1>
  <span class="badge">Python</span><span class="badge">openai-agents ${TESTED.openaiAgents}</span>
  <p class="lede">A <span class="inline">RunHooks</span> class that asks AgentBill before each
  model request <span class="inline">Runner.run</span> makes, with the job's
  <span class="inline">task_ref</span>. When the request would pass the job's ceiling, the SDK
  raises inside the hook, the request does not go out, and the error comes out of
  <span class="inline">Runner.run</span> to your code.</p>

  <h2>Keep OpenAI's spend limits and max_turns</h2>
  <p>OpenAI's hard spend limits are monthly amounts set for the organization or for a project, and a
  request past one is answered with a 429. Their documentation is plain about the timing:</p>
  <blockquote><p>&ldquo;Enforcement is not instantaneous, so recorded spend can slightly exceed the configured amount.&rdquo;</p></blockquote>
  <p class="meta">OpenAI, Spend limits, developer documentation, read 2026-09-23. <a href="https://developers.openai.com/api/docs/guides/spend-limits" rel="nofollow noopener">developers.openai.com/api/docs/guides/spend-limits</a></p>
  <p>Turn them on. <span class="inline">Runner.run</span> also takes
  <span class="inline">max_turns</span>, which caps how many turns one run may take. Both are bound
  to something real: an organization or project over a month, or one run's turn count. The ceiling
  below is bound to a task_ref, the name of the job, across every run, agent and process that
  passes it, in units you assign.</p>

  <h2>Install</h2>
  <div class="code"><pre>pip install agentbill-sdk "openai-agents==${TESTED.openaiAgents}"</pre></div>
  <p>Give the job its ceiling before it runs, in the <a href="/app">console</a> or with
  <span class="inline">PUT /tasks/:task_ref/ceiling</span>. The samples on this page were run end
  to end against openai-agents ${TESTED.openaiAgents} and agentbill-sdk ${SDK_VERSIONS.python},
  with a stub model in place of a provider.</p>

  <h2>The hooks</h2>
  <p><span class="inline">on_llm_start</span> is awaited before each model request, so a refusal
  raised there is raised before the request is made. <span class="inline">on_llm_end</span> settles
  the units once the response is back.</p>
  <div class="code"><pre>import asyncio
import os
from agents import RunHooks
from agentbill import AgentBillClient

client = AgentBillClient(api_key=os.environ["AGENTBILL_API_KEY"])
UNITS = 12  <span class="comment"># what one model call is worth to you, in your own units</span>


class AgentBillCeiling(RunHooks):
    def __init__(self, task_ref: str):
        self.task_ref = task_ref  <span class="comment"># the job's name, e.g. "job-142"</span>

    async def on_llm_start(self, context, agent, system_prompt, input_items):
        <span class="comment"># Raises TaskCeilingExceededError when this request would pass the</span>
        <span class="comment"># job's ceiling, and Runner.run raises it to your code.</span>
        await asyncio.to_thread(lambda: client.preflight(
            agent_id=agent.name, task_ref=self.task_ref, estimated_units=UNITS))

    async def on_llm_end(self, context, agent, response):
        await asyncio.to_thread(lambda: client.record(
            agent_id=agent.name, task_ref=self.task_ref, units=UNITS))</pre></div>
  <p>The client is synchronous, so each call runs in a thread and the event loop keeps going while
  AgentBill answers.</p>

  <h2>Run a job, and decide what a refusal means</h2>
  <div class="code"><pre>from agents import Agent, Runner
from agentbill import TaskCeilingExceededError

agent = Agent(name="researcher", instructions="Research the topic you are given.", tools=tools)


async def main():
    try:
        result = await Runner.run(agent, "Research the topic", hooks=AgentBillCeiling("job-142"))
        print(result.final_output)
    except TaskCeilingExceededError as e:
        <span class="comment"># Your code decides: keep what you have, retry smaller, or tell a person.</span>
        print(f"{e.task_ref} was refused at {e.task_used_units}/{e.task_ceiling} units")


asyncio.run(main())</pre></div>
  <p><span class="inline">tools</span> is your tool list. The exception carries
  <span class="inline">task_ref</span>, <span class="inline">task_ceiling</span>,
  <span class="inline">task_used_units</span> and <span class="inline">task_remaining_units</span>,
  so the handler can say what happened without a second call.</p>

  <h2>Handoffs and several agents</h2>
  <p>Hooks passed to <span class="inline">Runner.run</span> apply to the whole run, so an agent the
  run hands off to asks the same ceiling. <span class="inline">agent.name</span> goes to AgentBill as
  the <span class="inline">agent_id</span>, which the console groups spend and refusals by; it
  carries no budget of its own. The ceiling is the job's.</p>

  <h2>Parallel runs and several workers</h2>
  <p>Pass the same task_ref from every run and every process on the job. Each reservation is one
  conditional UPDATE on the job's row, so when the last units remain and two requests ask at once,
  one is approved and the other is refused.</p>

  <h2>If a model request fails</h2>
  <p><span class="inline">on_llm_end</span> runs when a response comes back. When the request raises
  instead, the reservation is not settled and is held until it expires,
  ${RESERVATION_TTL_MINUTES} minutes by default, and then its units come back. In that window the
  job's ceiling is tighter, never looser.</p>

  <h2>Without the Agents SDK</h2>
  <p>Calling the Responses API or Chat Completions directly, the same pair goes around the call:
  preflight before it with the job's task_ref, record after it.
  <a href="/docs/limit-cost-per-agent-run">How to cap what one agent run can spend</a> has that
  version, in Python and Node.</p>

  <h2>What it does not do</h2>
  <ul class="plain">
    <li>It does not count tokens. <span class="inline">UNITS</span> is the number you assign to one
    model request.</li>
    <li>It does not read your OpenAI bill.</li>
    <li>It does not end the run. Preflight answers, the SDK raises, and your code decides.</li>
    <li>A refusal from AgentBill's own monthly quota is returned, not raised, so these hooks let that
    request run.</li>
  </ul>

  ${cta('integrations-openai')}
`,
    ))
  })

  // CrewAI runs model-call hooks fail-open (crewai 1.15.22, hooks/dispatch.py
  // _invoke_hook): any exception other than HookAborted is caught, printed when
  // verbose, and the model call goes ahead. Measured, not read: a hook that let
  // TaskCeilingExceededError escape was ignored and every later call reached the
  // model. So the sample converts the refusal, and an unset job, to HookAborted.
  app.get('/integrations/crewai', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/integrations/crewai',
      'CrewAI spending limit: one ceiling per crew run, checked before each model call',
      'Two CrewAI hooks, PRE_MODEL_CALL and POST_MODEL_CALL, that ask AgentBill before each model call and settle after it, with one task_ref for the job. max_iter and max_rpm count iterations and requests; this ceiling counts the units you assign.',
      `
  <h1>CrewAI spending limit, one ceiling per crew run</h1>
  <span class="badge">Python</span><span class="badge">crewai ${TESTED.crewai}</span>
  <p class="lede">Two hooks that ask AgentBill before each model call your crew makes and settle
  after it, with the job's <span class="inline">task_ref</span>. When the call would pass the
  job's ceiling, the hook raises <span class="inline">HookAborted</span>, CrewAI does not make the
  call, and <span class="inline">kickoff()</span> raises to your code.</p>

  <h2>Use the limits CrewAI ships</h2>
  <p>A CrewAI agent takes <span class="inline">max_iter</span>,
  <span class="inline">max_rpm</span> and <span class="inline">max_execution_time</span>, and a
  crew takes <span class="inline">max_rpm</span>. They count iterations, requests per minute and
  seconds. Use them.</p>
  <p>The ceiling below counts something else: the units you assign to each model call, for one job.
  Crew-wide means one task_ref, passed by every agent in the crew and by every other crew or
  process working on the same job. Nothing groups the calls for you. The task_ref you pass is the
  grouping.</p>

  <h2>Install</h2>
  <div class="code"><pre>pip install agentbill-sdk "crewai==${TESTED.crewai}"</pre></div>
  <p>Give the job its ceiling before the crew runs, in the <a href="/app">console</a> or with
  <span class="inline">PUT /tasks/:task_ref/ceiling</span>. The samples on this page were run end
  to end against crewai ${TESTED.crewai} and agentbill-sdk ${SDK_VERSIONS.python}, with a stub LLM
  in place of a provider.</p>

  <h2>The hooks</h2>
  <div class="code"><pre>import contextvars
import os
from agentbill import AgentBillClient, TaskCeilingExceededError
from crewai.hooks import HookAborted, InterceptionPoint, on

client = AgentBillClient(api_key=os.environ["AGENTBILL_API_KEY"])
UNITS = 12  <span class="comment"># what one model call is worth to you, in your own units</span>
JOB = contextvars.ContextVar("agentbill_task_ref", default=None)  <span class="comment"># the job's name</span>


@on(InterceptionPoint.PRE_MODEL_CALL)
def ask_agentbill(ctx):
    job = JOB.get()
    if job is None:
        raise HookAborted(reason="no AgentBill task_ref is set", source="agentbill")
    role = getattr(ctx.agent, "role", None) or "crewai"
    try:
        client.preflight(agent_id=role, task_ref=job, estimated_units=UNITS)
    except TaskCeilingExceededError as e:
        raise HookAborted(reason=str(e), source="agentbill") from e


@on(InterceptionPoint.POST_MODEL_CALL)
def settle_agentbill(ctx):
    role = getattr(ctx.agent, "role", None) or "crewai"
    client.record(agent_id=role, task_ref=JOB.get(), units=UNITS)</pre></div>

  <h2>Why the hook raises HookAborted</h2>
  <p>CrewAI runs these hooks fail-open. An exception other than
  <span class="inline">HookAborted</span> raised in a hook is caught, printed when the crew is
  verbose, and the model call goes ahead (<span class="inline">crewai/hooks/dispatch.py</span> in
  crewai ${TESTED.crewai}). So a <span class="inline">TaskCeilingExceededError</span> left to
  escape the hook would change nothing: in a run with that version of the hook, every call after the
  ceiling was spent still reached the model. The hook turns the refusal into
  <span class="inline">HookAborted</span>, which CrewAI does raise to the caller, and it does the
  same when no job is set, rather than let a call through unasked.</p>
  <p>The same rule covers AgentBill being unreachable. A network error inside the hook is an ordinary
  exception, so CrewAI prints it and makes the call. If you want the call refused instead, catch it
  in the hook and raise <span class="inline">HookAborted</span>.</p>

  <h2>Run a crew, and decide what a refusal means</h2>
  <div class="code"><pre>JOB.set("job-142")
try:
    result = crew.kickoff()
except HookAborted as e:
    <span class="comment"># Your code decides. e.reason is AgentBill's sentence, and on a ceiling</span>
    <span class="comment"># refusal e.__cause__ is the TaskCeilingExceededError with the numbers.</span>
    print(e.reason)</pre></div>
  <p><span class="inline">crew</span> is your crew. Set <span class="inline">JOB</span> in the code
  that calls <span class="inline">kickoff()</span>; the hooks read it where the model call runs.</p>

  <h2>Several crews or processes on one job</h2>
  <p>The job's budget is one row, keyed on your account and the task_ref, with no clock on it. Every
  reservation is one conditional UPDATE on that row, so crews running at once, in one process or in
  several, cannot both be approved against the last units. Set the same
  <span class="inline">JOB</span> in each.</p>

  <h2>Settling, and what a crash does</h2>
  <p>The <span class="inline">POST_MODEL_CALL</span> hook settles the units preflight reserved, once
  the model has answered. When a model call raises instead, nothing settles it, and the reservation
  is held until it expires, ${RESERVATION_TTL_MINUTES} minutes by default, and then its units come
  back. The same happens when the process dies between the two hooks. In that window the job's
  ceiling is tighter, never looser.</p>

  <h2>What it does not do</h2>
  <ul class="plain">
    <li>It does not count tokens. <span class="inline">UNITS</span> is the number you assign to one
    model call.</li>
    <li>It does not meter the provider or read its bill.</li>
    <li>It does not end the crew. Preflight answers, the hook raises, and your code decides.</li>
    <li>A refusal from AgentBill's own monthly quota is returned, not raised, so these hooks let that
    call run.</li>
  </ul>

  ${cta('integrations-crewai')}
`,
    ))
  })

  // The MCP connect page, 2026-09-25: the remote endpoint at /mcp, one tab per
  // client, each snippet checked against that client's current docs (the
  // sources are beside each one in src/ui/mcp-connect.ts). The local stdio
  // package keeps its README blocks under Other, byte for byte.
  app.get('/integrations/mcp', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/integrations/mcp',
      'Connect AgentBill over MCP: Claude, ChatGPT, Claude Code, Codex, Cursor, Antigravity',
      'One URL, https://agentbill.dev/mcp. Connect Claude and ChatGPT with a sign-in, Cursor and VS Code in one click, Claude Code and Codex with one command. Tools for preflight, recording usage, and where the units went.',
      `${mcpConnectBody()}
  ${cta('integrations-mcp')}
`,
      { rail: false, css: MCP_CONNECT_CSS, current: '/integrations/mcp', scripts: MCP_SCRIPTS },
    ))
  })

  // The two guides these pages replace. Both taught the pre-pivot pattern
  // (customer_id, a per-call ceiling, and FreeTierExceededError, which nothing
  // has raised since 0.6.0), and the OpenAI one described a task ceiling its
  // code never passed. A 301 keeps whatever links and rankings they earned.
  // A tagged link to an old path keeps its site_pulse label through the
  // redirect. Only ?src= travels, and only in the one shape cleanSource()
  // accepts, so the Location is always our own path plus our own label.
  const moved = (to: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    const src = cleanSource((request.query as Record<string, unknown>).src)
    return reply.redirect(src ? `${to}?src=${src}` : to, 301)
  }
  app.get('/docs/langchain-billing', publicRoute(), moved('/integrations/langchain'))
  app.get('/docs/openai-agent-spend-ceiling', publicRoute(), moved('/integrations/openai-agents-sdk'))
}
