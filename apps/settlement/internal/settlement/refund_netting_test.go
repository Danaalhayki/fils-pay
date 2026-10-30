package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// insertRefund writes a succeeded refund plus the ledger legs processRefund.ts
// posts for it (gross reversal, and the MDR share reversed).
func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amountFils, feeReversedFils int64, occurredAt time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var refundID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', $5, 'test', 'merchant_api_key', $6, $7)
		RETURNING id
	`, txnID, merchantID, amountFils, feeReversedFils, "acq-refund-"+uuid.New().String(), uuid.New(), occurredAt).Scan(&refundID)
	if err != nil {
		t.Fatalf("insertRefund: %v", err)
	}

	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $5, 'refund: gross'),
		  ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $5, 'refund: gross')
	`, groupID, merchantID, txnID, amountFils, occurredAt)
	if err != nil {
		t.Fatalf("insertRefund: gross legs: %v", err)
	}
	if feeReversedFils > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, $5, 'refund: MDR fee reversal'),
			  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'refund: MDR fee reversal')
		`, groupID, merchantID, txnID, feeReversedFils, occurredAt)
		if err != nil {
			t.Fatalf("insertRefund: fee legs: %v", err)
		}
	}
	return refundID
}

func merchantPayableLedgerBalance(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int64 {
	t.Helper()
	var balance int64
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&balance)
	if err != nil {
		t.Fatalf("merchantPayableLedgerBalance: %v", err)
	}
	return balance
}

// A same-day refund reduces that day's payout by the refunded gross less
// the fee share it reversed, and once paid the merchant's payable position
// in the ledger is exactly zero.
func TestCloseBatch_NetsRefundsAndLedgerTiesOut(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 4, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, fee := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(1*time.Hour))
	refundID := insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	wantNet := money.Fils(10_000) - fee - 4_000 + 100
	if result.NetPayoutFils != wantNet {
		t.Fatalf("NetPayoutFils = %d, want %d (gross - fee - refunds + fee reversed)", result.NetPayoutFils, wantNet)
	}

	var refunded, feeReversed int64
	err = pool.QueryRow(ctx, `
		SELECT refunded_fils, refund_fee_reversed_fils FROM settlement_batches WHERE id = $1
	`, result.BatchID).Scan(&refunded, &feeReversed)
	if err != nil {
		t.Fatalf("read batch refund totals: %v", err)
	}
	if refunded != 4_000 || feeReversed != 100 {
		t.Errorf("batch refunded_fils/refund_fee_reversed_fils = %d/%d, want 4000/100", refunded, feeReversed)
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM refunds WHERE id = $1 AND settlement_batch_id = $2`, refundID, result.BatchID); n != 1 {
		t.Errorf("refund not marked with the batch that netted it")
	}

	if _, err := PayoutBatch(ctx, pool, result.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if got := merchantPayableLedgerBalance(t, pool, merchantID); got != 0 {
		t.Errorf("merchant_payable after payout = %d, want 0 (every fils captured, refunded and paid is accounted for)", got)
	}
}

// Refunds larger than what a batch owes are not netted into it (no negative
// payout); they wait, unbatched, for the next batch that can absorb them.
func TestCloseBatch_CarriesForwardRefundsThatWouldGoNegative(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	day0 := time.Date(2026, 4, 21, 0, 0, 0, 0, time.UTC)
	day1 := day0.AddDate(0, 0, 1)
	day2 := day0.AddDate(0, 0, 2)
	start0, _ := BusinessDayWindow(day0)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)

	// Day 0: a 5.000 BD sale, settled on its own.
	saleTxn, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 5_000, start0.Add(1*time.Hour))
	settled, err := CloseBatch(ctx, pool, merchantID, day0)
	if err != nil {
		t.Fatalf("CloseBatch day0: %v", err)
	}

	// Day 1: the sale is refunded in full, but the day only has 0.200 BD of
	// new captures — netting would make the payout negative.
	refundID := insertRefund(t, pool, merchantID, saleTxn, 5_000, 125, start1.Add(2*time.Hour))
	_, fee1 := insertCaptureEvent(t, pool, merchantID, mdrBps, 200, start1.Add(3*time.Hour))

	first, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if want := money.Fils(200) - fee1; first.NetPayoutFils != want {
		t.Errorf("day1 NetPayoutFils = %d, want %d (refund carried forward, not netted)", first.NetPayoutFils, want)
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM refunds WHERE id = $1 AND settlement_batch_id IS NULL`, refundID); n != 1 {
		t.Fatalf("refund was netted into a batch that could not absorb it")
	}

	// Day 2: enough volume, so the carried refund lands here.
	_, fee2 := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start2.Add(1*time.Hour))
	second, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if want := money.Fils(10_000) - fee2 - 5_000 + 125; second.NetPayoutFils != want {
		t.Errorf("day2 NetPayoutFils = %d, want %d (carried-forward refund netted here)", second.NetPayoutFils, want)
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM refunds WHERE id = $1 AND settlement_batch_id = $2`, refundID, second.BatchID); n != 1 {
		t.Errorf("carried refund not marked with the day2 batch")
	}

	for _, b := range []uuid.UUID{settled.BatchID, first.BatchID, second.BatchID} {
		if _, err := PayoutBatch(ctx, pool, b); err != nil {
			t.Fatalf("PayoutBatch: %v", err)
		}
	}
	if got := merchantPayableLedgerBalance(t, pool, merchantID); got != 0 {
		t.Errorf("merchant_payable after both payouts = %d, want 0", got)
	}
}
