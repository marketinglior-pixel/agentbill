/**
 * The start screen's words, in one place, because the console renders them and
 * the harness and the hygiene gate check them.
 *
 * History, kept short because it decided the shape.
 *   - 2026-09-11: one surface owns the sequence, the console's start screen
 *     (startScreen in src/routes/app.ts). Dogfood run 3 had ended on
 *     /register#done with "I do not understand what I need to do".
 *   - 2026-09-11 to 09-25: three steps, a job and its ceiling in units, a
 *     Python sample that called record(units=1), and the refusal it produced.
 *   - 2026-09-25: the founder, as a user, found it "not clear at all" with "a
 *     quite complicated" install, and the first call a new account made could
 *     never show a dollar figure: record(units=1) names no model, so there is
 *     nothing to price. Claude, reading that account over MCP, said so in as
 *     many words ("None of its calls were recorded with a model name").
 *
 * So the screen now asks one question, how will you connect, and each answer
 * is one short path ending on the account's first recorded model call, shown
 * back with its tokens, its model and its list-price estimate. The ceiling and
 * the refusal are the next thing, on the Task budgets view, not the first.
 *
 * The two code samples are literals in src/routes/app.ts, not built here: the
 * snippet harness (scripts/snippets/extract.mjs) executes only a literal code
 * block under src/routes, and records an interpolated one as "dynamic" with no
 * code, which drops it from CI in silence. Neither sample carries anything of
 * the reader's, so neither needs a builder.
 */

/** The three ways in, in the order the screen offers them. */
export const VIAS = ['mcp', 'python', 'node'] as const
export type Via = (typeof VIAS)[number]
export const asVia = (v: unknown): Via | null => (VIAS as readonly unknown[]).includes(v) ? v as Via : null

/** The question, and the promise every answer keeps. */
export const CONNECT_Q = 'How will you connect?'
export const CONNECT_LEDE =
  'Pick one. Each path is a few lines and ends on your first recorded call, with its tokens, its model and what it cost at list price.'

/** The three choices, as the cards read. */
export const VIA_TITLE: Record<Via, string> = {
  mcp: 'Claude, Cursor, Codex or another MCP client',
  python: 'Python',
  node: 'Node',
}
export const VIA_SUB: Record<Via, string> = {
  mcp: 'Ask about your jobs and spend from the assistant you already use.',
  python: 'Wrap your OpenAI or Anthropic client once. Every call is metered.',
  node: 'The same, with the agentbill package from npm.',
}

/** The job the SDK samples open. One name, so a reader who runs both lands on one job. */
export const FIRST_JOB = 'first-call'
/** The label the samples carry. */
export const FIRST_AGENT = 'start'
/** The ceiling the samples open the job with, in tokens: far above one short call. */
export const FIRST_CEILING = 20_000

// ---------------------------------------------------------------- MCP

/**
 * The first prompt. It records one TEST call, named as one, with the token
 * counts in the prompt itself, so the reader sees a priced record land on this
 * screen without writing code. The numbers are the reader's words, not a
 * measurement, and the prompt says so ("a test call"); the screen repeats the
 * step name it was recorded under. It names the provider because the server
 * prices a record only when the metadata says whose list price applies.
 */
export const MCP_PROMPT =
  'Use AgentBill to record one test call: agent "mcp-test", job "first-call", metadata provider "anthropic", model "claude-sonnet-4-5", tokens 1200 input and 300 output, step "test". Then tell me what that job has cost so far.'

/** What the assistant can do over MCP. Every clause is a tool in src/lib/mcp-tools.ts. */
export const MCP_DOES =
  'The assistant can read your jobs, what each one used and what it cost at list price (<code>task_status</code>, <code>top_jobs</code>), read your refusals, ask <code>preflight</code> for an agent before it runs, and record a call for an agent (<code>record_event</code>).'
/** And what it cannot. Said plainly, because it is the question a reader asks next. */
export const MCP_DOES_NOT =
  'It does not meter the tokens of your chat with it. Nothing records the conversation you are having with the assistant unless it calls <code>record_event</code>. To meter an agent that runs on its own, use the Python or Node path.'

// ---------------------------------------------------------------- SDKs

/** -U, not a bare install: on 2026-09-25 a quiet pip install left the founder on 0.6.2, which calls a retired address. */
export const INSTALL_PY_WRAP = 'pip install -U agentbill-sdk openai'
export const INSTALL_NODE_WRAP = 'npm install agentbill openai'

/**
 * Where the keys come from. The sample reads both keys from the environment,
 * so it runs as pasted once they are set. Prose, never a runnable block: a gap
 * in a copyable line is how a key became agb_agb_... and a 401 on a first run
 * (2026-09-09), and the console has no key to fill a line with.
 */
export const KEYS_LINE =
  'Set two keys in the terminal you run it from: <code>AGENTBILL_API_KEY</code> (the <code>export</code> line you were given with the key; <a href="/recover">/recover</a> shows it again) and <code>OPENAI_API_KEY</code>, your own. This console never shows your key.'

/** What one run does, in the order it happens. Every clause is wrap()'s documented behaviour. */
export const WHAT_RUNS =
  'Before the call, <code>wrap()</code> asks AgentBill whether job <code>first-call</code> has room, opening it with a ceiling of 20,000 tokens. The call then goes from your process straight to OpenAI, and after it <code>wrap()</code> records the model and the tokens OpenAI reported. AgentBill prices them at public list price. Your prompt and the answer are never sent to AgentBill.'

/** Anthropic, in one line, with the method wrap() measures on it. */
export const ANTHROPIC_LINE =
  'Anthropic works the same way: wrap an Anthropic client and call <code>messages.create</code>. So does a Google Gen AI client.'

/** Where the path ends when nothing has arrived yet. */
export const WAITING_LINE = 'Nothing recorded yet. Run it, then reload this page: your first call appears here.'
