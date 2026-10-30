package splits

import (
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children in proportion to their
// weights using the largest-remainder method, so the shares always sum to
// exactly netPayout — rounding each share independently leaks or invents
// fils whenever the weights don't divide the payout evenly.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	var totalWeight int64
	for _, c := range children {
		totalWeight += c.WeightBps
	}
	if totalWeight <= 0 || netPayout <= 0 {
		return out
	}

	remainders := make([]int64, len(children))
	var allocated money.Fils
	for i, c := range children {
		product := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(product / totalWeight)
		remainders[i] = product % totalWeight
		allocated += out[i]
	}

	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	for k := 0; allocated < netPayout; k++ {
		out[order[k%len(order)]]++
		allocated++
	}
	return out
}
