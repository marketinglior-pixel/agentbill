"""Dollars to units, and units to dollars, at a rate you declare.

AgentBill stores and reserves integer units only. These two functions are the
arithmetic you would otherwise do by hand when you think in dollars: a job
budget of $5 at your own ``dollars_per_unit`` becomes a whole number of units to
send as a ceiling, and a unit count becomes dollars at that same rate. Nothing
here reads a provider bill or knows any price. The rate is your own number, and
an invoice from a provider may differ from rate times units.

The rounding rule is floor. ``units_from_dollars`` returns the largest whole
number of units whose worth at the rate is at most the dollar amount, so a $5
budget never becomes more than $5 of units at that rate: $5 at 0.003 is 1666
units ($4.998), never 1667 ($5.001).

Exact decimal arithmetic, never floating point: 0.29 / 0.01 in floating point
is 28.999999999999996, and a floor on that is 28, one unit short of what you
typed. A float argument is read as the shortest decimal that prints as it
(``repr``), which is the number you wrote.

The Node SDK (sdk/node/src/rate.ts) and the console (src/lib/dollar-rate.ts)
carry the same rule, and sdk/rate-cases.json holds all three to one table.
"""

import math
import re
from decimal import Decimal
from typing import Tuple, Union

Decimalish = Union[str, int, float, Decimal]

_DECIMAL = re.compile(r"([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?")
# Bounds on what a caller may pass, so a typo cannot ask for a number with a
# hundred thousand digits. Far past any real budget or rate.
_MAX_DIGITS = 40
_MAX_EXPONENT = 40
# The largest whole number a JavaScript number holds exactly. The Node SDK
# refuses past it, so this one does too, and the two agree on every input.
_MAX_UNITS = 2 ** 53 - 1


def _text(value: Decimalish, name: str) -> str:
    # bool is an int in Python; True dollars is a bug, not 1.
    if isinstance(value, bool):
        raise TypeError(f"{name} must be a decimal string or a number")
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number")
        return repr(value)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"{name} must be a finite number")
        return format(value, "f")
    raise TypeError(f"{name} must be a decimal string or a number")


def _parse(value: Decimalish, name: str) -> Tuple[int, int]:
    """(n, scale) with value == n / 10**scale, both non-negative."""
    s = _text(value, name)
    m = _DECIMAL.fullmatch(s)
    if not m:
        raise ValueError(f"{name} must be a decimal of 0 or more, like 5 or 0.01; got {s!r}")
    whole, frac, exponent = m.group(1), m.group(2) or "", int(m.group(3) or "0")
    if len(whole) + len(frac) > _MAX_DIGITS or abs(exponent) > _MAX_EXPONENT:
        raise ValueError(f"{name} carries more digits than this helper accepts")
    n = int(whole + frac)
    scale = len(frac) - exponent
    if scale < 0:
        n *= 10 ** -scale
        scale = 0
    return n, scale


def _rate(value: Decimalish) -> Tuple[int, int]:
    n, scale = _parse(value, "dollars_per_unit")
    if n == 0:
        raise ValueError("dollars_per_unit must be greater than zero")
    return n, scale


def units_from_dollars(dollars: Decimalish, dollars_per_unit: Decimalish) -> int:
    """The whole number of units ``dollars`` buys at ``dollars_per_unit``, rounded down.

    0 when the amount is worth less than one unit; a ceiling must be 1 or more,
    so check the result before sending it.

        units_from_dollars("5", "0.01")    # 500
        units_from_dollars("5", "0.003")   # 1666, never 1667
    """
    dn, ds = _parse(dollars, "dollars")
    rn, rs = _rate(dollars_per_unit)
    units = (dn * 10 ** rs) // (rn * 10 ** ds)
    if units > _MAX_UNITS:
        raise ValueError("that many units is past what the Node SDK holds exactly, so this refuses it too")
    return units


def dollars_from_units(units: int, dollars_per_unit: Decimalish) -> Decimal:
    """What ``units`` are worth at ``dollars_per_unit``, exactly.

        dollars_from_units(1666, "0.003")  # Decimal('4.998')
    """
    if isinstance(units, bool) or not isinstance(units, int) or units < 0 or units > _MAX_UNITS:
        raise ValueError("units must be a whole number, 0 or more")
    rn, rs = _rate(dollars_per_unit)
    digits = str(units * rn).rjust(rs + 1, "0")
    whole, frac = digits[: len(digits) - rs], digits[len(digits) - rs:].rstrip("0")
    return Decimal(f"{whole}.{frac}" if frac else whole)
