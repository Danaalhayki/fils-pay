package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

func TestChildShares_LargestRemainderSumsExactly(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
		want       []money.Fils
	}{
		{"thirds of 100", 100, []int64{3333, 3333, 3334}, []money.Fils{33, 33, 34}},
		{"thirds of 10", 10, []int64{3333, 3333, 3334}, []money.Fils{3, 3, 4}},
		{"half-fil ties", 1001, []int64{5000, 5000}, []money.Fils{501, 500}},
		{"odd net 7 ways", 1_000_003, []int64{1428, 1428, 1428, 1429, 1429, 1429, 1429}, nil},
		{"weights under 100%", 999, []int64{2500, 2500}, []money.Fils{500, 499}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			shares := ChildShares(tc.netPayout, children)
			var total money.Fils
			for _, s := range shares {
				if s < 0 {
					t.Fatalf("negative share %d", s)
				}
				total += s
			}
			if total != tc.netPayout {
				t.Errorf("sum of shares %d != net payout %d (%v)", total, tc.netPayout, shares)
			}
			for i := range tc.want {
				if shares[i] != tc.want[i] {
					t.Errorf("share[%d] = %d, want %d (%v)", i, shares[i], tc.want[i], shares)
				}
			}
		})
	}
}

func TestChildShares_ZeroOrNegativeNetAllocatesNothing(t *testing.T) {
	for _, net := range []money.Fils{0, -500} {
		for _, s := range ChildShares(net, []ChildWeight{{5000}, {5000}}) {
			if s != 0 {
				t.Errorf("net %d: got share %d, want 0", net, s)
			}
		}
	}
}
