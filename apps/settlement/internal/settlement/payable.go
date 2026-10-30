package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
// Integer fils only: a float32 carries ~7 significant digits, so any batch
// above ~16,777 BD would lose fils on the way through.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
