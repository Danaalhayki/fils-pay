package scheduler

import (
	"testing"
	"time"
)

func TestDueBusinessDate_ClosesShortlyAfterBahrainMidnight(t *testing.T) {
	// 00:20 Bahrain on 15 March = 21:20 UTC on 14 March.
	now := time.Date(2026, 3, 14, 21, 20, 0, 0, time.UTC)

	date, due := dueBusinessDate(now, 15)
	if !due {
		t.Fatalf("not due at 00:20 Bahrain with a 15-minute delay; the close must not wait for UTC midnight")
	}
	if got := date.Format("2006-01-02"); got != "2026-03-14" {
		t.Errorf("business date = %s, want 2026-03-14 (the Bahrain day that just ended)", got)
	}
}

func TestDueBusinessDate_HoldsDuringGracePeriod(t *testing.T) {
	// 00:05 Bahrain on 15 March.
	now := time.Date(2026, 3, 14, 21, 5, 0, 0, time.UTC)
	if _, due := dueBusinessDate(now, 15); due {
		t.Errorf("due at 00:05 Bahrain with a 15-minute delay; want held")
	}
}

func TestDueBusinessDate_LateEveningBahrainIsStillTheSameDay(t *testing.T) {
	// 23:50 Bahrain on 14 March = 20:50 UTC: the most recent completed day is 13 March.
	now := time.Date(2026, 3, 14, 20, 50, 0, 0, time.UTC)
	date, due := dueBusinessDate(now, 15)
	if !due {
		t.Fatalf("not due late in the Bahrain day")
	}
	if got := date.Format("2006-01-02"); got != "2026-03-13" {
		t.Errorf("business date = %s, want 2026-03-13", got)
	}
}
