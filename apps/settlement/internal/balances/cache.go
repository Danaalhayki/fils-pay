// Package balances records batch bookkeeping on merchant_balances.
//
// cached_payable_fils itself is maintained by the database: every
// merchant_payable leg inserted into ledger_entries moves it by its own
// signed amount (migration 0081), so the cache always equals the ledger walk
// ledger.RebuildAllBalances performs — everything owed and not yet paid.
// Nothing here adds or subtracts money from it; doing so would count the
// same legs twice.
package balances

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RecordBatchClose notes the merchant's latest closed batch, inside
// CloseBatch's own transaction.
func RecordBatchClose(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		VALUES ($1, 0, $2, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET last_settlement_batch_id = $2, updated_at = now()
	`, merchantID, batchID)
	return err
}
