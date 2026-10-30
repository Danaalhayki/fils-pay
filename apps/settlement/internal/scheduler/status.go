// Package scheduler — status.go. Lightweight operational logging only:
// tells an operator tailing the daemon's logs when the next daily close is
// due. It has no bearing on runIfDue's decision (dueBusinessDate is the
// authority), but it uses the same Asia/Bahrain rule so the two agree.
package scheduler

import (
	"log"
	"time"

	"github.com/filspay/settlement/internal/settlement"
)

// estimateNextRunAt returns the next instant a daily close becomes due:
// Asia/Bahrain midnight plus the run delay, today's if it is still ahead of
// now, otherwise tomorrow's. Rendered in UTC so the log is unambiguous
// whatever TZ the container has.
func estimateNextRunAt(now time.Time, runDelayMinutes int) time.Time {
	todayStart, _ := settlement.BusinessDayWindow(settlement.InBusinessDayZone(now))
	delay := time.Duration(runDelayMinutes) * time.Minute
	next := todayStart.Add(delay)
	if !now.Before(next) {
		next = todayStart.AddDate(0, 0, 1).Add(delay)
	}
	return next.UTC()
}

// logNextRunEstimate writes the estimate to the daemon's log, alongside
// the outcome of the check that just ran.
func logNextRunEstimate(now time.Time, runDelayMinutes int) {
	log.Printf("settlement daemon: next daily close due ~%s", estimateNextRunAt(now, runDelayMinutes).Format(time.RFC3339))
}
