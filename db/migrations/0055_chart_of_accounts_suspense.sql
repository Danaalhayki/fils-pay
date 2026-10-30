-- Additional suspense accounts for future reconciliation lanes.
-- 0007's chart is (id, name, kind) with kind IN ('asset','liability','revenue');
-- suspense balances are carried as assets, like scheme_rounding_residue.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX rounding difference (suspense)', 'asset'),
  ('chargeback_suspense', 'Chargeback suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
