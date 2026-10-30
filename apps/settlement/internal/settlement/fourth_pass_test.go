package settlement

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// Closing a business day that has not ended yet would settle half of it and
// strand every capture made after the close.
func TestRunDailyBatch_RefusesDayThatHasNotEnded(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)

	today := InBusinessDayZone(time.Now())
	todayDate := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	_, err := RunDailyBatch(context.Background(), pool, todayDate, &merchantID)
	if !errors.Is(err, ErrBusinessDayNotOver) {
		t.Fatalf("RunDailyBatch(today) err = %v, want ErrBusinessDayNotOver", err)
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM settlement_batches WHERE merchant_id = $1`, merchantID); n != 0 {
		t.Errorf("a batch was created for a day that has not ended")
	}
}

// A capture stamped inside a day whose batch is already closed (it committed
// after the close) is picked up by the next close instead of never settling.
// Captures from a day that has no closed batch are still left alone.
func TestCloseBatch_SweepsStragglersFromClosedDays(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	day0 := time.Date(2026, 5, 3, 0, 0, 0, 0, time.UTC)
	day1 := day0.AddDate(0, 0, 1)
	start0, _ := BusinessDayWindow(day0)
	start1, _ := BusinessDayWindow(day1)

	if _, err := CloseBatch(ctx, pool, merchantID, day0); err != nil {
		t.Fatalf("CloseBatch day0: %v", err)
	}
	straggler, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 3_000, start0.Add(23*time.Hour))
	unclosedDay, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 7_000, start0.AddDate(0, 0, -3))
	insertCaptureEvent(t, pool, merchantID, mdrBps, 1_000, start1.Add(time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if result.GrossFils != 4_000 {
		t.Errorf("day1 GrossFils = %d, want 4000 (own capture + straggler from closed day0)", result.GrossFils)
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM transaction_events WHERE transaction_id = $1 AND settlement_batch_id = $2`, straggler, result.BatchID); n != 1 {
		t.Errorf("straggler from closed day0 was not swept into day1")
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM transaction_events WHERE transaction_id = $1 AND settlement_batch_id IS NULL`, unclosedDay); n != 1 {
		t.Errorf("capture from a day with no closed batch was swept early")
	}
}

// The batch fee is the fee capture journaled, so a rate change between
// capture and close cannot make the payout disagree with the ledger.
func TestCloseBatch_UsesJournaledCaptureFee(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 5, 6, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))
	const journaledFee = 180
	if _, err := pool.Exec(ctx, `
		UPDATE transaction_events SET metadata = jsonb_build_object('feeFils', $2::bigint) WHERE transaction_id = $1
	`, txnID, journaledFee); err != nil {
		t.Fatalf("set journaled fee: %v", err)
	}

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if result.FeeFils != journaledFee {
		t.Errorf("FeeFils = %d, want the journaled %d (not a fresh 250 bps = 250)", result.FeeFils, journaledFee)
	}
	if want := money.Fils(10_000 - journaledFee); result.NetPayoutFils != want {
		t.Errorf("NetPayoutFils = %d, want %d", result.NetPayoutFils, want)
	}
}

// One refund too large for the batch must not hold back an earlier smaller
// one; netting is oldest-first for as long as the payout stays non-negative.
func TestCloseBatch_NetsOldestRefundsThatFit(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	day0 := time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC)
	day1 := day0.AddDate(0, 0, 1)
	start0, _ := BusinessDayWindow(day0)
	start1, _ := BusinessDayWindow(day1)

	sale, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 20_000, start0.Add(time.Hour))
	if _, err := CloseBatch(ctx, pool, merchantID, day0); err != nil {
		t.Fatalf("CloseBatch day0: %v", err)
	}

	small := insertRefund(t, pool, merchantID, sale, 1_000, 25, start1.Add(time.Hour))
	large := insertRefund(t, pool, merchantID, sale, 15_000, 375, start1.Add(2*time.Hour))
	_, fee := insertCaptureEvent(t, pool, merchantID, mdrBps, 5_000, start1.Add(3*time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if want := money.Fils(5_000) - fee - 1_000 + 25; result.NetPayoutFils != want {
		t.Errorf("NetPayoutFils = %d, want %d (small refund netted, large carried)", result.NetPayoutFils, want)
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM refunds WHERE id = $1 AND settlement_batch_id = $2`, small, result.BatchID); n != 1 {
		t.Errorf("small refund that fits was not netted")
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM refunds WHERE id = $1 AND settlement_batch_id IS NULL`, large); n != 1 {
		t.Errorf("refund that does not fit was netted into a negative payout")
	}
}

// "Current terms" for an MDR recalculation is the scheduled rate in force
// now, not the merchants.mdr_bps fallback.
func TestRecalculateMDR_UsesCurrentScheduledRate(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	insertFeeSchedule(t, pool, merchantID, 150, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))

	businessDate := time.Date(2026, 5, 10, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 150, 10_000, start.Add(time.Hour))
	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.FeeFils != 150 {
		t.Fatalf("FeeFils = %d, want 150 at the scheduled rate", closed.FeeFils)
	}

	result, err := RecalculateMDR(ctx, pool, merchantID, businessDate, businessDate.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 1 {
		t.Fatalf("BatchesConsidered = %d, want 1", result.BatchesConsidered)
	}
	if len(result.Adjusted) != 0 {
		t.Errorf("RecalculateMDR adjusted %+v; the batch is already at the current scheduled 150 bps", result.Adjusted)
	}
}

// Two schedule rows with the same effective_from resolve to the one created
// last, the same tie-break apps/api's getEffectiveMdrBps uses.
func TestLoadFeeSchedules_TieBreaksOnCreatedAt(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	effective := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at)
		VALUES ($1, 175, $2, now()), ($1, 190, $2, now() - interval '1 day')
	`, merchantID, effective)
	if err != nil {
		t.Fatalf("insert schedules: %v", err)
	}

	schedules := loadSchedules(t, pool, merchantID)
	if got := EffectiveMdrBpsAt(schedules, effective.AddDate(0, 1, 0), 250); got != 175 {
		t.Errorf("EffectiveMdrBpsAt = %d, want 175 (the later-created row)", got)
	}
}
