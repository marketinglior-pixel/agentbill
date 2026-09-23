// Dollars to units, and units to dollars, at a rate the developer declares.
//
// AgentBill stores and reserves integer units only. This file is the arithmetic
// a developer who thinks in dollars would otherwise do by hand: a job budget of
// $5 at their own dollars_per_unit becomes a whole number of units, and a unit
// count becomes dollars at that same rate. Nothing here reads a provider bill
// or knows any price. The rate is the caller's own number, and an invoice from
// a provider may differ from rate times units.
//
// The rounding rule is floor. unitsFromDollars returns the largest whole number
// of units whose worth at the rate is at most the dollar amount, so a $5 budget
// never becomes more than $5 of units at that rate: $5 at 0.003 is 1666 units
// ($4.998), never 1667 ($5.001).
//
// Exact decimal arithmetic on BigInt, never floating point. 0.29 / 0.01 in
// floating point is 28.999999999999996, and a floor on that is 28, one unit
// short of what the reader typed.
//
// This file exists twice, byte for byte: src/lib/dollar-rate.ts (the console)
// and sdk/node/src/rate.ts (the Node SDK). scripts/hygiene/run.sh holds the two
// identical, and sdk/rate-cases.json holds both of them, and the Python SDK's
// agentbill/rate.py, to one table of cases.

/** A decimal as a string ("5", "0.01", "1e-7") or a finite number. */
export type Decimalish = string | number

/** value = n / 10^scale, both non-negative. */
type Dec = { n: bigint; scale: number }

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/
// Bounds on what a caller may pass, so a typo cannot ask BigInt for a number
// with a hundred thousand digits. Far past any real budget or rate.
const MAX_DIGITS = 40
const MAX_EXPONENT = 40

function parse(value: Decimalish, name: string): Dec {
  let s: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`)
    s = String(value)
  } else if (typeof value === 'string') {
    s = value.trim()
  } else {
    throw new TypeError(`${name} must be a decimal string or a number`)
  }
  const m = DECIMAL.exec(s)
  if (!m) throw new RangeError(`${name} must be a decimal of 0 or more, like 5 or 0.01; got ${JSON.stringify(s)}`)
  const whole = m[1]
  const frac = m[2] ?? ''
  const exponent = Number(m[3] ?? '0')
  if (whole.length + frac.length > MAX_DIGITS || Math.abs(exponent) > MAX_EXPONENT) {
    throw new RangeError(`${name} carries more digits than this helper accepts`)
  }
  let n = BigInt(whole + frac)
  let scale = frac.length - exponent
  if (scale < 0) {
    n *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { n, scale }
}

function rate(value: Decimalish): Dec {
  const r = parse(value, 'dollarsPerUnit')
  if (r.n === 0n) throw new RangeError('dollarsPerUnit must be greater than zero')
  return r
}

/**
 * The whole number of units that `dollars` buys at `dollarsPerUnit`, rounded
 * down. 0 when the amount is worth less than one unit; a ceiling must be 1 or
 * more, so check the result before sending it.
 */
export function unitsFromDollars(dollars: Decimalish, dollarsPerUnit: Decimalish): number {
  const d = parse(dollars, 'dollars')
  const r = rate(dollarsPerUnit)
  // (d.n / 10^d.scale) / (r.n / 10^r.scale). Both sides are non-negative, so
  // BigInt division, which truncates, is the floor.
  const units = (d.n * 10n ** BigInt(r.scale)) / (r.n * 10n ** BigInt(d.scale))
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('that many units is past what a JavaScript number holds exactly')
  return Number(units)
}

/**
 * What `units` are worth at `dollarsPerUnit`, exactly, as a plain decimal
 * string with no trailing zeros: 1666 at 0.003 is "4.998", 500 at 0.01 is "5".
 */
export function dollarsFromUnits(units: number, dollarsPerUnit: Decimalish): string {
  if (!Number.isSafeInteger(units) || units < 0) throw new RangeError('units must be a whole number, 0 or more')
  const r = rate(dollarsPerUnit)
  const digits = (BigInt(units) * r.n).toString().padStart(r.scale + 1, '0')
  const whole = digits.slice(0, digits.length - r.scale)
  const frac = digits.slice(digits.length - r.scale).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}
