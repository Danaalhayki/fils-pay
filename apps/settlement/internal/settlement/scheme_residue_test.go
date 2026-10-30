package settlement

import (
	"context"
	"testing"
	"time"
)

// ADR-0002: the file carries the truncated amount, and the 0–9 fils that
// never reach the scheme are journaled per line so card_scheme_clearing for
// the transaction ties to exactly what the scheme was sent.
func TestCloseBatch_SchemeAmountTruncatedAndResidueJournaled(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 93_275, start.Add(time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	lines, err := LoadSchemeExportLines(ctx, pool, result.BatchID)
	if err != nil {
		t.Fatalf("LoadSchemeExportLines: %v", err)
	}
	if len(lines) != 1 || lines[0].Amount != "93.27" {
		t.Fatalf("scheme amount = %+v, want a single line of 93.27 (truncated, not rounded to 93.28)", lines)
	}

	var residue int64
	err = pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries
		 WHERE transaction_id = $1 AND account_id = 'scheme_rounding_residue' AND direction = 'debit'
	`, txnID).Scan(&residue)
	if err != nil {
		t.Fatalf("read residue: %v", err)
	}
	if residue != 5 {
		t.Errorf("residue journaled = %d, want 5", residue)
	}

	var clearing int64
	err = pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'card_scheme_clearing'
	`, txnID).Scan(&clearing)
	if err != nil {
		t.Fatalf("read clearing: %v", err)
	}
	if clearing != 93_270 {
		t.Errorf("card_scheme_clearing for the transaction = %d, want 93270 (what the scheme was sent)", clearing)
	}
}
