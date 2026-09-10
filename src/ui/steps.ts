/**
 * The onboarding path, in one place, because it is rendered on two surfaces.
 *
 * /register#done shows it as instructions the moment the key appears, and the
 * console shows it as a form the reader fills in. Before this module the two
 * surfaces disagreed: /register told a reader to pass `task_ceiling` from
 * Python, and the console's first run told them to paste a curl that asks for
 * 5 units against a per-request ceiling of 1, which manufactures a refusal on
 * a job the reader never created and teaches the opposite order.
 *
 * The order is the point, and it is the one thing here that must not drift
 * (ticket 2026-09-10, "onboarding to a first understandable preflight"):
 *
 *   1. Name this job          -> plain English first, `task_ref` second
 *   2. Say what it is worth   -> units the reader chooses
 *   3. Ask before each call   -> the ceiling already exists, so the call
 *                                carries the job's name and nothing else
 *                                about the budget
 *
 * Step 3 is only true because the ceiling is set before the code runs. A
 * preflight naming a job that does not exist, with no `task_ceiling`, is a 422
 * `task_ceiling_required` (preflight.ts) which carries no `approved` field at
 * all, so "yes or refused" would not describe it. That is what REQUIRED_LINE
 * is for; it is not optional decoration.
 */

/** Step 1. "One job is one budget" lands before the word task_ref, deliberately. */
export const STEP_1 =
  'Name this job. One job is one budget: every call carrying the name you choose is checked against that one budget, whatever agent or tool made the call. In code that name is <code>task_ref</code>.'

/** Step 2. A unit is whatever the reader decides. We never look at a provider bill. */
export const STEP_2 =
  'Say what the job is worth, in units. You decide what a unit is: a call, a page, a thousand tokens, one overnight run. Your code says what each call is worth, and a call that says nothing counts as one unit.'

/**
 * Step 3. The refusal sentence lives here rather than in a paragraph further
 * up the page, so a reader meets `approved: false` at the moment they are
 * about to run the call that could produce it.
 *
 * "Your code decides what the job does next" is the load-bearing clause. We do
 * not sit in the request path and nothing of ours reaches into a running job;
 * the SDK raises and the caller catches.
 */
export const STEP_3 =
  'Ask before each call. Your code sends the job\u2019s name and nothing about the budget, because the ceiling is already on the job. The answer is yes, and your call goes ahead. Out of units, and the answer is <code>approved: false</code>, which the Python SDK raises as <code>Refused (task_ceiling_exceeded)</code>. Your code decides what the job does next.'

/**
 * The third answer, and the reason step 3 cannot stand alone. Steps 1 and 2
 * out of order produce this, and it is neither a yes nor a refusal: HTTP 422
 * with an `error` key and no `approved` field.
 */
export const REQUIRED_LINE =
  'Run this before the job has a ceiling and the SDK raises <code>TaskCeilingRequiredError</code>: there is nothing yet to check the call against. Do steps one and two, then run it again.'

/** Field labels. Plain English is the label; the wire name is the hint under it. */
export const LABEL_REF = 'Name this job'
export const HINT_REF = 'your code passes this as <code>task_ref</code>'
export const LABEL_CEIL = 'How many units is this job worth'
export const HINT_CEIL = 'a whole number, and the job\u2019s ceiling'

/** The job name the console suggests and the static sample on /register uses. */
export const SAMPLE_REF = 'job-1'
/** The agent label the samples carry when the reader has not chosen one. */
export const SAMPLE_AGENT = 'researcher'

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
 * The one sample, built once, so /register's static copy and the console's
 * copy carrying the reader's own job cannot drift apart.
 *
 * Three calls, and all three are load-bearing:
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
 */
export function taskSnippet(taskRef: string = SAMPLE_REF, agentId: string = SAMPLE_AGENT): string {
  return `import os
from agentbill import AgentBillClient, TaskCeilingExceededError

key = os.environ["AGENTBILL_API_KEY"]
client = AgentBillClient(api_key=key)

try:
    result = client.preflight(
        agent_id="${agentId}",
        task_ref="${taskRef}",
    )
    print("approved:", result.approved)
    print("units left:", result.task_remaining_units)
    # your model call runs here
    client.record(
        agent_id="${agentId}",
        task_ref="${taskRef}",
        units=1,
    )
except TaskCeilingExceededError as refused:
    print(refused)`
}

/** What a reader does to see the refusal on purpose, once the first call worked.
 *  Verified against setTaskCeiling: a ceiling equal to used + reserved saves,
 *  and the next call then has no room to reserve. */
export const REFUSAL_RECIPE =
  'Want to see the refusal now? Set this job\u2019s ceiling to the number of units it has already used and run the lines again.'
