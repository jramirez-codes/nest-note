package dashboard

import (
	"fmt"
	"strings"
	"time"

	"nestnote/server/internal/store"
)

// logTaskDismissal appends one entry to the owning notebook's "Task Log" page
// recording that a task was deleted: whether it was completed or dropped, and how
// long it lived (created_at -> the moment it was dismissed). See taskLogLine for
// the entry's format.
func logTaskDismissal(mcpDir, slug string, c store.Card) {
	if slug == "" || c.Kind != "task" {
		return
	}
	_ = store.UpsertPage(mcpDir, slug, taskLogTargetTitle(mcpDir, slug), []string{taskLogLine(c)})
}

// taskLogPageCap is the most entries kept on one "Task Log" page before a dismissal
// rolls onto a new one ("Task Log 2", "Task Log 3", ...), so a long-lived notebook's
// log stays a series of bounded pages instead of one ever-growing file.
const taskLogPageCap = 100

// taskLogTargetTitle picks which "Task Log" page the next dismissal entry belongs
// on: the highest-numbered existing one if it still has room, otherwise the next
// one in the sequence.
func taskLogTargetTitle(mcpDir, slug string) string {
	n, body := latestTaskLogPage(store.ListPages(mcpDir, slug))
	if n > 0 && countTaskLogEntries(body) >= taskLogPageCap {
		n++
	}
	if n <= 1 {
		return "Task Log"
	}
	return fmt.Sprintf("Task Log %d", n)
}

// latestTaskLogPage returns the sequence number (1 for bare "Task Log", 2+ for
// "Task Log N") and body of the highest-numbered Task Log page present, or (0, "")
// if the notebook doesn't have one yet.
func latestTaskLogPage(pages []store.NotePage) (int, string) {
	best, body := 0, ""
	for _, p := range pages {
		if n, ok := store.TaskLogSeq(p.Title); ok && n > best {
			best, body = n, p.Body
		}
	}
	return best, body
}

// countTaskLogEntries counts task-log entries in a page body by counting "## "
// headings (one per entry — see taskLogLine). A manually edited page that loses a
// heading just undercounts by that much; the cap is a soft target, not a guarantee,
// so that's fine.
func countTaskLogEntries(body string) int {
	n := 0
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "## ") {
			n++
		}
	}
	return n
}

// taskLogLine renders one dismissal as its own "## " heading (just the task title)
// followed by plain bullets for the details — readable directly in the notebook, no
// machine-only tag. No source field: the entry already lives on the owning
// subject's own Task Log page.
func taskLogLine(c store.Card) string {
	now := time.Now().UTC()
	verb := "Dropped"
	if c.Done {
		verb = "Completed"
	}
	created, err := time.Parse(time.RFC3339, c.CreatedAt)
	if err != nil {
		created = now
	}
	dur := now.Sub(created)
	return strings.Join([]string{
		fmt.Sprintf("## %s", c.Title),
		fmt.Sprintf("- %s after %s", verb, humanDuration(dur)),
		fmt.Sprintf("- Filed %s → Closed %s", created.Format("2006-01-02 15:04 MST"), now.Format("2006-01-02 15:04 MST")),
		fmt.Sprintf("- id: `%s`", c.ID),
	}, "\n")
}

// humanDuration renders a duration as its two most significant units (days+hours,
// hours+minutes, minutes+seconds, or bare seconds) for a short, readable "took X" note.
func humanDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	mins := int(d.Minutes()) % 60
	secs := int(d.Seconds()) % 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case hours > 0:
		return fmt.Sprintf("%dh %dm", hours, mins)
	case mins > 0:
		return fmt.Sprintf("%dm %ds", mins, secs)
	default:
		return fmt.Sprintf("%ds", secs)
	}
}
