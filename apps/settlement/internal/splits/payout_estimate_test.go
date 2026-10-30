package splits

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func mustPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test (run against a real, migrated Postgres)")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("failed to connect to DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func insertMerchant(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'active', false)
		RETURNING id
	`, "split-test-"+uuid.New().String()).Scan(&id)
	if err != nil {
		t.Fatalf("insertMerchant: %v", err)
	}
	return id
}

// A split payout adds to the parent's lifetime payout estimate exactly as a
// single payout (PayoutBatch) does.
func TestPayoutSplitBatch_UpdatesLifetimeEstimate(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	parent := insertMerchant(t, pool)
	childA := insertMerchant(t, pool)
	childB := insertMerchant(t, pool)

	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
		VALUES ($1, $2, 6000), ($1, $3, 4000)
	`, parent, childA, childB); err != nil {
		t.Fatalf("insert split children: %v", err)
	}

	const net = int64(9_750)
	var batchID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils)
		VALUES ($1, $2, 'closed', 10000, 250, $3)
		RETURNING id
	`, parent, time.Date(2026, 5, 12, 0, 0, 0, 0, time.UTC), net).Scan(&batchID); err != nil {
		t.Fatalf("insert batch: %v", err)
	}

	if _, err := PayoutSplitBatch(ctx, pool, batchID); err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}

	var estimate int64
	if err := pool.QueryRow(ctx, `
		SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1
	`, parent).Scan(&estimate); err != nil {
		t.Fatalf("read estimate: %v", err)
	}
	if estimate != net {
		t.Errorf("lifetime_net_payout_monitoring_estimate = %d, want %d", estimate, net)
	}
}
