package settlement

import (
	"context"
	"testing"
	"time"
)

func TestRecalculateMDR_PaidBatchUntouched(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 9, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 0 || len(result.Adjusted) != 0 {
		t.Fatalf("paid batch was considered/adjusted: %+v", result)
	}

	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).
		Scan(&fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
		t.Errorf("paid batch rewritten: fee %d net %d, want fee %d net %d", fee, net, closed.FeeFils, closed.NetPayoutFils)
	}
}

func TestRecalculateMDR_KeepsRefundNetting(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, 2_000, 50, start.Add(2*time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 1 {
		t.Fatalf("len(Adjusted) = %d, want 1", len(result.Adjusted))
	}

	var net int64
	if err := pool.QueryRow(ctx, `SELECT net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	want := int64(closed.NetPayoutFils) - int64(result.Adjusted[0].DiffFils)
	if net != want {
		t.Errorf("net_payout_fils = %d, want %d (refund netting lost)", net, want)
	}
}
