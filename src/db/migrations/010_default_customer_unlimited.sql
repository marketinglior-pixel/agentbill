-- 010: a new account no longer caps its customers at 1,000 units for life.
--
-- register.ts inserted default_budget_units = 1000 on every account. preflight.ts
-- and events.ts copy that value onto each customer the account lazily creates,
-- including the customer named "default" that every call without a customer_id
-- draws on, and customers.used_units only ever increments. So a free account
-- that followed the quickstart was refused with budget_exhausted after 1,000
-- recorded units, whatever task_ceiling it passed, by a customer it never made.
-- Reproduced on production on 2026-09-09.
--
-- From this migration on, signup writes NULL (schema.sql already documents NULL
-- as "unlimited by default for new customers") and the only way a customer gets
-- a ceiling is PUT /budget. This file clears the ceilings that were inherited
-- rather than chosen.
--
-- The rule, and why it is this rule. A customer at exactly 1000 on an account
-- whose default is 1000 either inherited it or had it set by hand to the same
-- number, and nothing in the data tells those apart: PUT /budget, reserve and
-- settle all bump updated_at. The one hint available is the account's other
-- customers. An account that has set any ceiling by hand (a limit that is
-- neither NULL nor 1000) might have set this one too, so its 1000s are left
-- alone and listed by the SELECT below for a human to decide. Every other
-- 1000 is an inheritance and is cleared. Both statements are idempotent.
--
-- Run the SELECT first. It names what the UPDATE will skip.

SELECT a.id AS account_id, c.customer_ref, c.limit_units, c.used_units, c.reserved_units
FROM customers c
JOIN accounts a ON a.id = c.account_id
WHERE c.limit_units = 1000
  AND a.default_budget_units = 1000
  AND EXISTS (
    SELECT 1 FROM customers s
    WHERE s.account_id = c.account_id
      AND s.limit_units IS NOT NULL
      AND s.limit_units <> 1000
  );

BEGIN;

UPDATE customers c
SET limit_units = NULL,
    updated_at  = now()
FROM accounts a
WHERE a.id = c.account_id
  AND c.limit_units = 1000
  AND a.default_budget_units = 1000
  AND NOT EXISTS (
    SELECT 1 FROM customers s
    WHERE s.account_id = c.account_id
      AND s.limit_units IS NOT NULL
      AND s.limit_units <> 1000
  );

UPDATE accounts
SET default_budget_units = NULL
WHERE default_budget_units = 1000;

COMMIT;
