import { ORIGIN } from './site.js'
import { SDK_VERSIONS } from '../lib/llms.js'
import { PLAN_ORDER, PLAN_PRICES, PLAN_LIMITS } from '../integrations/polar.js'

// The product entity, in one place.
//
// It was typed twice, in home.ts and in upgrade.ts, under one @id, and the two
// copies had already drifted: the homepage carried a description and /pricing
// did not. Two nodes with one @id and different bodies is the merge conflict
// this file exists to prevent, and it is the same rule polar.ts states about a
// price typed twice.
//
// The voice rule from lib/llms.ts applies here and is easier to break, because
// a featureList reads like a feature list: preflight ANSWERS, the SDK RAISES,
// and the caller's code decides. Nothing here may say AgentBill stops, blocks
// or kills a run, because it cannot; nothing here may claim to be first, only,
// or better than a named competitor. Every line below is checkable against a
// file in src/ or sdk/, and the ones that were checked name what they came from.

/** The one-sentence description, shared by every node that needs one. */
const DESCRIPTION =
  'A per-task spend ceiling for AI agents. Your code calls preflight before it calls a provider; ' +
  'preflight reserves the integer units you estimate against a ceiling bound to a task_ref you ' +
  'choose, answers approved:false or raises when the reservation would cross it, and your code ' +
  'decides what happens next. Units are developer-defined and never converted to money.'

/**
 * SoftwareApplication for / and /pricing. Both emit it under one @id so the two
 * pages describe one product rather than competing as two.
 *
 * Offers render from PLAN_ORDER / PLAN_PRICES / PLAN_LIMITS, never from typed
 * numbers, so the structured data cannot disagree with the table beside it.
 *
 * No aggregateRating and no interactionStatistic: there are no ratings, and the
 * download figure that would go in the second one is a publish-day spike rather
 * than a monthly rate. Both would be the highest-value additions for a rich
 * result and neither is true, which is why none of this is a rich-result play.
 *
 * No softwareVersion either. The hosted API has no version and the three
 * packages have three, so a single number would be a fourth copy that drifts
 * within a release. Versions live on the SoftwareSourceCode nodes instead.
 */
export function softwareLd(): unknown {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    '@id': `${ORIGIN}/#software`,
    name: 'AgentBill',
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'Spend governance for AI agents',
    operatingSystem: 'Any',
    url: ORIGIN,
    description: DESCRIPTION,
    image: `${ORIGIN}/og.png`,
    provider: { '@id': `${ORIGIN}/#organization` },
    publisher: { '@id': `${ORIGIN}/#organization` },
    isAccessibleForFree: true,
    license: 'https://spdx.org/licenses/MIT.html',
    audience: { '@type': 'Audience', audienceType: 'Developers building AI agents' },
    // sdk/python/pyproject.toml and mcp/pyproject.toml both declare
    // requires-python >=3.9. sdk/node/package.json declares no engines field,
    // so no Node version is asserted here.
    softwareRequirements: 'Python 3.9 or newer for agentbill-sdk; Node.js for the agentbill package; any MCP client for agentbill-mcp',
    downloadUrl: [
      'https://pypi.org/project/agentbill-sdk/',
      'https://www.npmjs.com/package/agentbill',
      'https://pypi.org/project/agentbill-mcp/',
    ],
    installUrl: `${ORIGIN}/docs`,
    // No softwareHelp pointing at /docs#techarticle. Every {'@id': ...} on a
    // page has to resolve to a node ON that page: a reference that only
    // resolves on another URL is a dangling pointer to any consumer that reads
    // one document at a time, which is most of them. That rule is why
    // softwareLd() is emitted on /docs and /faq too, rather than referenced
    // from them.
    featureList: [
      'POST /preflight reserves the units your code estimates and answers before your provider call goes out. An approved answer carries remaining_units and reservation_expires_at.',
      'One ceiling per task_ref: every call passing the same task_ref is checked against the same task budget, from any process, any machine and any provider.',
      'The ceiling is fixed by the first preflight that opens a task_ref. A task_ceiling sent on a later call for that same task_ref is ignored, so a retry cannot raise the number it was meant to respect.',
      'When used plus reserved plus this estimate would cross the task ceiling, preflight answers approved:false with reason task_ceiling_exceeded and the numbers it decided on; the SDK raises TaskCeilingExceededError and the calling code decides what happens next.',
      'Units are integers the developer defines and passes. AgentBill compares units to a ceiling and never converts them to currency or reads a provider invoice.',
      'The check and the reservation are one conditional UPDATE, so two preflights arriving together cannot both be approved against the same remaining units.',
      'idempotency_key replays a stored decision, so a retried preflight holds one reservation instead of two.',
      'POST /events settles a reservation: success true records the units, success false releases them and records nothing.',
      'Reservations carry an expiry, 60 minutes by default, and a sweeper returns expired ones to the budget every five minutes, so an abandoned run tightens the ceiling rather than loosening it.',
      'Per-customer ceilings through PUT /budget, where limit_units is an integer or null for no limit and may be set below what is already used without rewriting a counter.',
      'Per-call ceiling: when estimated_units exceeds it, preflight answers approved:false with reason ceiling_exceeded, having reserved nothing.',
      'agent_id is an attribution label carried on tasks, steps and refusals and filterable on GET /tasks and GET /decisions. No budget is bound to it.',
      'GET /decisions returns the decision log: every refusal, and every record that landed past a ceiling, each row holding the literal response body the SDK received.',
      'POST /step records a named step and flags it when its units exceed twice the baseline of the last thirty samples, once at least five exist.',
      'API keys can be rotated, which issues a new key and keeps the old one working for 24 hours, and revoked, which stops it authenticating on the next request.',
      'Python and Node SDKs plus an MCP server exposing preflight and record_event. Your code calls the API next to your provider call; there is no proxy or gateway endpoint for provider traffic to route through.',
    ],
    offers: PLAN_ORDER.map((tier) => ({
      '@type': 'Offer',
      '@id': `${ORIGIN}/pricing#offer-${tier}`,
      name: tier[0].toUpperCase() + tier.slice(1),
      price: String(PLAN_PRICES[tier]),
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      category: PLAN_PRICES[tier] === 0 ? 'Free' : 'Subscription',
      // Free is claimed at /register; a paid tier is bought from /pricing,
      // which mints the Polar checkout session. /checkout/:tier is not a valid
      // public link on its own, it needs an account_id.
      url: PLAN_PRICES[tier] === 0 ? `${ORIGIN}/register` : `${ORIGIN}/pricing`,
      description: `${PLAN_LIMITS[tier].toLocaleString('en-US')} preflight calls/month`,
      seller: { '@id': `${ORIGIN}/#organization` },
    })),
  }
}

/**
 * The three published packages. `version` is SoftwareSourceCode's property and
 * renders from SDK_VERSIONS, the one copy of those numbers on the site.
 *
 * The descriptions are written here rather than lifted from package metadata:
 * sdk/node/package.json says "Preflight blocks the call before it runs", which
 * is us claiming to end the run. That string must not reach structured data.
 */
export function sourceLd(): unknown[] {
  // url, not downloadUrl: schema.org defines downloadUrl with domainIncludes
  // SoftwareApplication only, so on a SoftwareSourceCode node a validator drops
  // it and the registry pointer disappears. Checked against
  // schemaorg-current-https.jsonld on 2026-09-08.
  const base = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    codeRepository: 'https://github.com/marketinglior-pixel/agentbill',
    license: 'https://spdx.org/licenses/MIT.html',
    targetProduct: { '@id': `${ORIGIN}/#software` },
    author: { '@id': `${ORIGIN}/#organization` },
  }
  return [
    {
      ...base,
      '@id': `${ORIGIN}/#python-sdk`,
      name: 'agentbill-sdk',
      description: 'Python SDK. preflight() reserves the units you estimate and raises when a spend rule refuses; record() settles what the run used, or releases the reservation when it failed.',
      programmingLanguage: 'Python',
      runtimePlatform: 'Python 3.9+',
      version: SDK_VERSIONS.python,
      url: 'https://pypi.org/project/agentbill-sdk/',
    },
    {
      ...base,
      '@id': `${ORIGIN}/#node-sdk`,
      name: 'agentbill',
      description: 'Node SDK, ESM. preflight() reserves before the call and throws when a spend rule refuses; record() settles after it. Reads AGENTBILL_API_KEY from the environment.',
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js',
      version: SDK_VERSIONS.node,
      url: 'https://www.npmjs.com/package/agentbill',
    },
    {
      ...base,
      '@id': `${ORIGIN}/#mcp-server`,
      name: 'agentbill-mcp',
      description: 'MCP server exposing two tools, preflight and record_event, to an agent host. Runs with uvx agentbill-mcp.',
      programmingLanguage: 'Python',
      runtimePlatform: 'Python 3.9+',
      version: SDK_VERSIONS.mcp,
      url: 'https://pypi.org/project/agentbill-mcp/',
    },
  ]
}
