package ledger

import (
	"context"
	"testing"
)

// `rebuild-balances --merchant` must write the repaired figure, not only
// report it: the operator runs it to fix a drifted cache.
func TestRepairMerchantBalance_WritesRebuiltCache(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)

	postLedgerLeg(t, pool, merchantID, "credit", 8000)
	postLedgerLeg(t, pool, merchantID, "debit", 200)
	const want = int64(8000 - 200)

	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 123456, now())
		ON CONFLICT (merchant_id) DO UPDATE SET cached_payable_fils = 123456
	`, merchantID); err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	diff, err := RepairMerchantBalance(ctx, pool, merchantID)
	if err != nil {
		t.Fatalf("RepairMerchantBalance: %v", err)
	}
	if diff.CachedBefore != 123456 || int64(diff.Rebuilt) != want {
		t.Errorf("diff = %+v, want CachedBefore 123456, Rebuilt %d", diff, want)
	}

	var persisted int64
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted); err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if persisted != want {
		t.Errorf("cached_payable_fils = %d, want %d", persisted, want)
	}
}
