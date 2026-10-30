package settlement

import (
	"context"
	"sync"
	"testing"
	"time"
)

// The daemon and `run-batch` scanning at the same moment must still enqueue
// exactly one settlement.paid event per batch.
func TestEnqueuePayoutNotifications_ConcurrentScansEnqueueOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	paidBatch := insertBatch(t, pool, merchantID, time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC), "paid", 33_000)

	const scanners = 8
	var wg sync.WaitGroup
	errs := make(chan error, scanners)
	start := make(chan struct{})
	for i := 0; i < scanners; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				errs <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("EnqueuePayoutNotifications: %v", err)
	}

	if got := countPaidEvents(t, pool, paidBatch); got != 1 {
		t.Fatalf("concurrent scans enqueued %d settlement.paid events, want 1", got)
	}
}

// PayoutBatch records exactly one disbursement in its own transaction —
// independent of whether the merchant has webhook endpoints — and a re-pay
// doesn't add another.
func TestPayoutBatch_RecordsOneDisbursement(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 4, 12, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 20_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
			t.Fatalf("PayoutBatch #%d: %v", i+1, err)
		}
	}

	var n int
	var amount int64
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(amount_fils), 0) FROM settlement_payout_disbursements WHERE settlement_batch_id = $1
	`, closed.BatchID).Scan(&n, &amount); err != nil {
		t.Fatalf("read disbursements: %v", err)
	}
	if n != 1 || amount != int64(closed.NetPayoutFils) {
		t.Errorf("disbursements = %d (amount %d), want exactly 1 for %d", n, amount, closed.NetPayoutFils)
	}
}
