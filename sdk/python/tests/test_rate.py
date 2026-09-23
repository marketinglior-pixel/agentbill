"""The dollars-to-units rule, held to the table the TypeScript copies share.

sdk/rate-cases.json is the one list of cases for all three copies of the rule
(this SDK, the Node SDK and the console). The property test below checks the
rule itself rather than a list someone wrote down: for any amount and rate, the
result is the floor, so it is never worth more than the amount at that rate.
"""

import json
import random
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest

from agentbill import dollars_from_units, units_from_dollars

CASES = json.loads((Path(__file__).resolve().parents[2] / "rate-cases.json").read_text())


@pytest.mark.parametrize("case", CASES["units_from_dollars"], ids=lambda c: c["why"])
def test_units_from_dollars_matches_the_shared_table(case):
    if case.get("error"):
        with pytest.raises((ValueError, TypeError)):
            units_from_dollars(case["dollars"], case["rate"])
    else:
        assert units_from_dollars(case["dollars"], case["rate"]) == case["units"]


@pytest.mark.parametrize("case", CASES["dollars_from_units"], ids=lambda c: f"{c['units']}@{c['rate']}")
def test_dollars_from_units_matches_the_shared_table(case):
    if case.get("error"):
        with pytest.raises((ValueError, TypeError)):
            dollars_from_units(case["units"], case["rate"])
    else:
        assert dollars_from_units(case["units"], case["rate"]) == Decimal(case["dollars"])


def test_the_floor_is_never_worth_more_than_the_amount():
    rng = random.Random(20260923)
    for _ in range(3000):
        dollars = f"{rng.randint(0, 99999)}.{rng.randint(0, 99):02d}"
        rate = f"0.{rng.randint(1, 999999):06d}"
        units = units_from_dollars(dollars, rate)
        d, r = Fraction(dollars), Fraction(rate)
        assert units * r <= d < (units + 1) * r, (dollars, rate, units)


def test_a_bool_is_not_a_number_of_dollars():
    with pytest.raises(TypeError):
        units_from_dollars(True, "0.01")
