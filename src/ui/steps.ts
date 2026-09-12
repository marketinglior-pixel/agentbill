/**
 * The onboarding path, in one place, because the console's start screen
 * renders it and the hygiene gate checks the literal copy of its sample
 * against it.
 *
 * History, kept short because it decided the shape. Until 2026-09-11 two
 * surfaces rendered these words: /register#done as instructions the moment
 * the key appeared, and the console as the form the reader fills in. Dogfood
 * run 3 (2026-09-11) ended on /register#done with the founder saying "I do not
 * understand what I need to do". The content was all there. The SEQUENCE was
 * not: five actions in two panels, numbering starting on the third, terminal
 * work first and the console link last.
 *
 * So ONE surface owns the sequence: the console's start screen
 * (startScreen in src/routes/app.ts). /register hands over the key and signs
 * the reader into that screen. The cold-path ticket of 2026-09-11 fixed the
 * count at three and named the three: a job and its ceiling, the lines to
 * run, the refusal they produce.
 *
 *   1. Name this job, say what it is worth   -> the form, no terminal
 *   2. Install, then ask                     -> pip install, then the sample
 *                                               that names the job and nothing
 *                                               about its budget
 *   3. See the refusal                       -> the real approved: false on
 *                                               this account, on this screen
 *
 * Step 1 needs no terminal and happens on the screen the reader is already
 * on; the first terminal command comes after the reader already has a job
 * with a ceiling. That order is the point, and it is the one thing here that
 * must not drift. (The 2026-09-11 night deploy numbered name and units as 1
 * and 2 and the install as 3; the ticket that followed made the refusal the
 * third step, so name and units share the first. The order did not move.)
 *
 * Step 2 is only true because the ceiling is set before the code runs. A
 * preflight naming a job that does not exist, with no `task_ceiling`, is a 422
 * `task_ceiling_required` (preflight.ts) which carries no `approved` field at
 * all, so "yes or refused" would not describe it. That is what REQUIRED_LINE
 * is for; it is not optional decoration.
 */

/** The sentence above the numbered steps on the start screen. */
export const SEQUENCE_INTRO =
  'Three steps to your first refusal on this account. The first is the form below and needs no terminal.'

/** Step 1, first field. "One job is one budget" lands before the word task_ref, deliberately. */
export const STEP_NAME =
  'Name this job. One job is one budget: every call carrying the name you choose is checked against that one budget, whatever agent or tool made the call. In code that name is <code>task_ref</code>.'

/**
 * Step 1, second field. A unit is whatever the reader decides. We never look
 * at a provider bill. The last sentence is what makes step 3 reachable in one
 * run: a ceiling of 500 on a first job means 501 calls before anything is
 * refused, which is a screen that never fills.
 */
export const STEP_UNITS =
  'Say what the job is worth, in units. You decide what a unit is: a call, a page, a thousand tokens, one overnight run. Your code says what each call is worth, and a call that says nothing counts as one unit. Keep this first ceiling small: at 3, the fourth call is refused, and that refusal is what step 3 shows.'

/**
 * Step 2 opens with the install, placed AFTER the step that needs no
 * terminal. Before 2026-09-11 this line sat on /register#done as an
 * unnumbered bullet above the numbered steps, which is how "by numbers, step
 * one do this" became a request made while looking at a screen that had
 * numbers.
 */
export const STEP_INSTALL =
  'Install the SDK, once, in the environment your code runs in.'

/**
 * Step 2, second paragraph. The refusal sentence lives here rather than in a
 * paragraph further up the page, so a reader meets `approved: false` at the
 * moment they are about to run the call that could produce it.
 *
 * "Your code decides what the job does next" is the load-bearing clause. We do
 * not sit in the request path and nothing of ours reaches into a running job;
 * the SDK raises and the caller catches.
 *
 * Named STEP_ASK rather than by ordinal, so the name survives renumbering:
 * it has rendered under a 3, then a 4, then a 3, then a 2 in one week.
 */
export const STEP_ASK =
  'Ask before each call. Your code sends the job\u2019s name and nothing about the budget, because the ceiling is already on the job. The answer is yes, and your call goes ahead. Out of units, and the answer is <code>approved: false</code>, which the Python SDK raises as <code>Refused (task_ceiling_exceeded)</code>. Your code decides what the job does next.'

/**
 * Step 3. The sample runs one call more than the ceiling allows, so its last
 * call is the refusal, and this screen shows that refusal from the account's
 * own rows: the same table the refusals view lists.
 */
export const STEP_REFUSE =
  'See the refusal. The lines above make one call more than the ceiling allows, so the last one is refused. Every refusal is written down with the body your code received, and yours appears here.'

/**
 * Where the key comes from, and the one sentence on this screen that has to
 * work for a reader who does not have a terminal.
 *
 * Until 2026-09-12 this read "the export line on the screen that showed your
 * key, run in the same shell", and that pointer was dead: /register#done is a
 * client-side replaceState over /register, so a reload renders the empty form
 * and the prefilled line cannot be reached again by URL, reload or bookmark.
 * Dogfood run 4 stood on that screen asking where the key goes, which is the
 * reader this sentence was written for and the one it sent to a screen that no
 * longer exists. /recover now prints the same prefilled line, so the pointer
 * names a place instead of a memory.
 *
 * It also stops insisting on the shell. The console's sample reads the key from
 * the environment, but the Python client takes it as an argument and the API
 * takes it as a bearer header, and either is the only way in for a reader whose
 * agent lives in a browser tool. Both are true of the code: see
 * AgentBillClient's signature and the auth hook.
 *
 * Prose, never a runnable block: a gap in a copyable line is how a key became
 * agb_agb_... and a 401 on a first run (2026-09-09), and the console has no
 * key to fill a line with, because it masks every key it renders.
 */
export const KEY_ENV_LINE =
  'These lines read the key from <code>AGENTBILL_API_KEY</code>. Set it in the terminal you run them from: that is the <code>export</code> line you were given with the key, and <a href="/recover">/recover</a> shows both again. No terminal at all? Pass the key straight to <code>AgentBillClient(api_key=...)</code>, or send it yourself as an <code>Authorization: Bearer</code> header. This console never shows your key.'

/**
 * The third answer, and the reason step 2 cannot stand alone. Step 1 skipped
 * produces this, and it is neither a yes nor a refusal: HTTP 422 with an
 * `error` key and no `approved` field.
 */
export const REQUIRED_LINE =
  'Run this before the job has a ceiling and the SDK raises <code>TaskCeilingRequiredError</code>: there is nothing yet to check the call against. Do step one, then run it again.'

/** Field labels. Plain English is the label; the wire name is the hint under it. */
export const LABEL_REF = 'Name this job'
export const HINT_REF = 'your code passes this as <code>task_ref</code>'
export const LABEL_CEIL = 'How many units is this job worth'
export const HINT_CEIL = 'a whole number, and the job\u2019s ceiling'

/** The job name the start screen suggests before the reader has typed one. */
export const SAMPLE_REF = 'job-1'
/** The agent label the samples carry when the reader has not chosen one. */
export const SAMPLE_AGENT = 'researcher'
/**
 * The ceiling the start screen suggests and the static sample is written for.
 * Three, so the sample's fourth call is the refusal and a first run ends on
 * the thing this screen exists to show.
 */
export const SAMPLE_CEILING = 3

/**
 * Can this job name sit inside a Python double-quoted string in rendered HTML?
 *
 * `isId` (src/lib/ids.ts) permits everything except C0 controls and DEL, and
 * the console escapes the name for HTML on the way out. HTML escaping is not
 * Python escaping: `&quot;` renders in the browser as a literal `"`, which
 * closes the string, and a backslash passes through untouched and starts an
 * escape sequence. A name carrying either gets the sample name instead, with a
 * line saying so, rather than a code block that does not parse.
 */
export const inlineSafeRef = (ref: string): boolean => !/["\\]/.test(ref)

/**
 * The one sample, built once, so the start screen's literal copy (the one CI
 * executes) and the copy carrying the reader's own job cannot drift apart.
 *
 * It loops one call past the ceiling on purpose. Before 2026-09-12 the sample
 * made one call and the fine print said "run it N times and the one after is
 * refused": a refusal the reader had to go and produce by hand, N+1 times, on
 * a screen whose whole job is to show one. Now one paste is one run is one
 * refusal, and the ceiling is what ends the loop, which is the product's
 * sentence in four lines.
 *
 * Three calls inside the loop, and all three are load-bearing:
 *   - the client reads the key from the environment, never a literal
 *   - preflight names the job and NOTHING about the budget: the ceiling is
 *     already set, and a `task_ceiling` here would not be applied anyway
 *   - record settles the reservation. Without it the reserve is held for the
 *     reservation TTL, the row shows a burn the reader did not spend, and
 *     lowering the ceiling under used + reserved is refused. It is not
 *     padding, and trimming it to reach a smaller line count breaks the job.
 *
 * It prints `task_remaining_units`, not `remaining_units`: a fresh account
 * leaves `accounts.default_budget_units` NULL, so the customer balance is
 * unlimited and `remaining_units` is None on every first run.
 *
 * `range`, never `while True`: scripts/snippets/check_python.py executes this
 * block with the network stubbed to answer approved forever, and a loop the
 * ceiling ends is a loop the stub never ends.
 */
export function taskSnippet(taskRef: string = SAMPLE_REF, agentId: string = SAMPLE_AGENT, ceiling: number = SAMPLE_CEILING): string {
  return `import os
from agentbill import AgentBillClient, TaskCeilingExceededError

key = os.environ["AGENTBILL_API_KEY"]
client = AgentBillClient(api_key=key)

try:
    # one call more than the ceiling of ${ceiling}
    for _ in range(${ceiling + 1}):
        result = client.preflight(
            agent_id="${agentId}",
            task_ref="${taskRef}",
        )
        print("approved:", result.approved,
              "units left:", result.task_remaining_units)
        # your model call runs here
        client.record(
            agent_id="${agentId}",
            task_ref="${taskRef}",
            units=1,
        )
except TaskCeilingExceededError as refused:
    print(refused)`
}
