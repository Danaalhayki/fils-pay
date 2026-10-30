package scheduler

import (
	"testing"
	"time"
)

func TestEstimateNextRunAt_MidDayPointsAtTonightsClose(t *testing.T) {
	// 12:40 Bahrain on 30 October (09:40 UTC): the next close is 00:15
	// Bahrain on 31 October = 21:15 UTC on the 30th, not 24h from now.
	now := time.Date(2026, 10, 30, 9, 40, 0, 0, time.UTC)
	want := time.Date(2026, 10, 30, 21, 15, 0, 0, time.UTC)
	if got := estimateNextRunAt(now, 15); !got.Equal(want) {
		t.Fatalf("estimateNextRunAt = %s, want %s", got.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}

func TestEstimateNextRunAt_DuringGracePeriodPointsAtTodaysClose(t *testing.T) {
	// 00:05 Bahrain on 15 March: due at 00:15 the same Bahrain day.
	now := time.Date(2026, 3, 14, 21, 5, 0, 0, time.UTC)
	want := time.Date(2026, 3, 14, 21, 15, 0, 0, time.UTC)
	if got := estimateNextRunAt(now, 15); !got.Equal(want) {
		t.Fatalf("estimateNextRunAt = %s, want %s", got.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}
