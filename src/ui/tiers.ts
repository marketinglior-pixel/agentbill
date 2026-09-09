import { PLAN_LIMITS, PLAN_PRICES, PLAN_ORDER } from '../integrations/polar.js'

// The four tiers as cards, once.
//
// The homepage used to render the tiers as a three-column strip and /pricing as
// a four-column spec sheet, two layouts reading the same three tables. This is
// the one renderer both pages call, so the numbers, the order, the recommended
// tier and the service lines cannot disagree between the page that sells and
// the page that closes.
//
// Every number comes from polar.ts: PLAN_LIMITS, PLAN_PRICES and PLAN_ORDER are
// the tables preflight enforces. Nothing in the codebase gates a feature by
// plan, only PLAN_LIMITS is read, so every card says every feature is included
// and the only per-tier lines are calls, price and a service promise, labelled
// as service. (design.md: tiers sell headroom, not capability.)

const num = (n: number) => n.toLocaleString('en-US')
const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`

/** The tier the pages mark. Weight and a chip, never a second green button. */
export const RECOMMENDED = 'team'

/**
 * What a paid tier adds that is not code. These are the only per-tier lines a
 * card may carry besides calls and price.
 */
export const SERVICE: Record<string, string> = {
  team: 'priority support',
  scale: 'direct line to the founder',
}

/** The one sentence under the cards, on both pages. */
export const SAME_FEATURES =
  'Every plan has every feature. The tiers differ in how many preflight calls a month they include, and in who answers when you write in.'

export const TIERS_CSS = `
    /* Four cards on the panel frame. One primary per fold: the tier a stranger
       can act on now (Free) carries the green fill, the three they cannot buy
       without an account carry the outlined chip. Team is marked by weight and
       a chip, which design.md allows, and never by a second fill. */
    .tiers-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s4);
                  margin-top: var(--s6); }
    .tier-card { min-width: 0; display: flex; flex-direction: column; gap: var(--s3);
                 background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
                 border-radius: var(--r-frame); box-shadow: var(--edge), var(--lift); padding: var(--s5); }
    .tier-card.rec { border-color: var(--border-strong); border-top-color: var(--border-strong); }
    .tier-top { display: flex; justify-content: space-between; align-items: center; gap: var(--s2); min-height: 22px; }
    .tier-name { font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .14em;
                 text-transform: uppercase; color: var(--muted); }
    .tier-card.rec .tier-name { color: var(--text); font-weight: 700; }
    .tier-tag { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .08em; text-transform: uppercase;
                color: var(--green); border: 1px solid var(--held-line); background: var(--held-bg);
                border-radius: var(--r-chip); padding: 2px 8px; white-space: nowrap; }
    .tier-price { font-family: var(--display); font-size: var(--fs-h2); font-weight: 800; letter-spacing: -0.02em;
                  line-height: 1; color: var(--white); font-variant-numeric: tabular-nums; }
    .tier-price .per { font-family: var(--sans); font-size: var(--fs-small); font-weight: 500; letter-spacing: 0;
                       color: var(--dim); margin-left: 4px; }
    /* Number over label, not one line: "2,000,000 preflight calls / mo" is 30
       characters and a card at the 1080 shell holds about 24, so a single line
       broke at the slash in every card. Two lines by design cannot rag. */
    .tier-calls { display: grid; gap: 2px; font-family: var(--mono); font-size: var(--fs-body); color: var(--text);
                  font-variant-numeric: tabular-nums; }
    .tier-calls span { font-family: var(--sans); font-size: var(--fs-micro); color: var(--dim); }
    .tier-svc { font-size: var(--fs-small); color: var(--muted); line-height: 1.5; flex: 1; }
    /* A full-width button inside a card is the one place a centred label is
       allowed (design.md, CTA voice, mobile). */
    .tier-card .btn, .tier-card .btn-ghost { display: block; text-align: center; margin-top: var(--s2); }
    .tiers-note { margin-top: var(--s4); font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
                  max-width: 70ch; line-height: 1.6; }
    @media (max-width: 960px) { .tiers-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 640px) { .tiers-grid { grid-template-columns: minmax(0, 1fr); } }
`

/**
 * The cards. `cta(tier)` gives the href of a paid tier's button; the free
 * tier always goes to /register. Paid buttons carry data-tier so /pricing's
 * "already have a key" panel can point them at a real checkout session.
 */
export function tierCards(cta: (tier: string) => string): string {
  return `<div class="tiers-grid">${PLAN_ORDER.map((tier) => {
    const free = tier === 'free'
    const rec = tier === RECOMMENDED
    const svc = SERVICE[tier]
    const line = free ? 'Every feature. No card, no expiry.' : svc ? `Every feature. ${cap(svc)}.` : 'Every feature.'
    const button = free
      ? `<a class="btn" href="/register">Start free</a>`
      : `<a class="btn-ghost" data-tier="${tier}" href="${cta(tier)}">Get ${cap(tier)}</a>`
    return `
        <div class="tier-card${rec ? ' rec' : ''}">
          <div class="tier-top"><span class="tier-name">${tier}</span>${rec ? '<span class="tier-tag">recommended</span>' : ''}</div>
          <div class="tier-price">$${PLAN_PRICES[tier]}<span class="per">${free ? 'forever' : '/ mo'}</span></div>
          <div class="tier-calls">${num(PLAN_LIMITS[tier])}<span>preflight calls a month</span></div>
          <p class="tier-svc">${line}</p>
          ${button}
        </div>`
  }).join('')}
      </div>`
}
