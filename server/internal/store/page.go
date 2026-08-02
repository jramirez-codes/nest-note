package store

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Notes are a folder of pages, not a single file. Each page is "#<num> (<title>).md";
// page #0 is the auto-generated Appendix (an index of [[#N (Title)]] links), and
// content pages are 1-based. Within-notebook links are [[#N (Title)]]; cross-notebook
// links are [[slug::#N (Title)]].
const (
	AppendixNum   = 0
	AppendixTitle = "Appendix"
)

// NotePage is one markdown page in a notebook's notes/ folder. Num is the page
// number (0 = the Appendix), Title is the parenthesized name, File is the on-disk
// "#N (Title).md" filename, and Body is the raw markdown.
type NotePage struct {
	Num   int    `json:"num"`
	Title string `json:"title"`
	File  string `json:"file"`
	Body  string `json:"body"`
}

// pageFileRe matches a page filename "#<num> (<title>).md" and captures the two parts.
var pageFileRe = regexp.MustCompile(`^#(\d+) \((.+)\)\.md$`)

// SanitizePageTitle strips characters that would break the "#N (title).md" grammar
// (parens and slashes), collapses whitespace, and caps the length so a title always
// yields a valid, tidy filename.
func SanitizePageTitle(title string) string {
	title = strings.NewReplacer("(", " ", ")", " ", "/", " ", "\n", " ", "\r", " ").Replace(title)
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		title = "Untitled"
	}
	if len(title) > 60 {
		title = strings.TrimSpace(title[:60])
	}
	return title
}

func PageFileName(num int, title string) string {
	return fmt.Sprintf("#%d (%s).md", num, SanitizePageTitle(title))
}

// ParsePageFile pulls the number and title out of a "#N (Title).md" filename. ok is
// false for anything that isn't a page (so stray files are ignored).
func ParsePageFile(name string) (num int, title string, ok bool) {
	m := pageFileRe.FindStringSubmatch(name)
	if m == nil {
		return 0, "", false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, "", false
	}
	return n, m[2], true
}

// ListPages reads a notebook's notes/ folder into the ordered pages (Appendix first),
// each with its body. Returns nil when the folder is absent.
func ListPages(mcpDir, slug string) []NotePage {
	dir := NotesDirFor(mcpDir, slug)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var pages []NotePage
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		num, title, ok := ParsePageFile(e.Name())
		if !ok {
			continue
		}
		body, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		pages = append(pages, NotePage{Num: num, Title: title, File: e.Name(), Body: string(body)})
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Num < pages[j].Num })
	return pages
}

// ListPageStubs is ListPages without reading bodies: it parses num/title/file from the
// notes/ folder's names alone, so building a notebook's page index stays cheap even when
// its pages are large. Bodies are then fetched one page at a time via ReadPage — the
// backbone of the phone's page virtualization.
func ListPageStubs(mcpDir, slug string) []NotePage {
	dir := NotesDirFor(mcpDir, slug)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var pages []NotePage
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		num, title, ok := ParsePageFile(e.Name())
		if !ok {
			continue
		}
		pages = append(pages, NotePage{Num: num, Title: title, File: e.Name()})
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Num < pages[j].Num })
	return pages
}

// ReadPage returns one page (with its body) by number, reading only that single file so a
// page fetch never pays for the rest of the notebook. ok is false when no page has that num.
func ReadPage(mcpDir, slug string, num int) (NotePage, bool) {
	for _, p := range ListPageStubs(mcpDir, slug) {
		if p.Num == num {
			body, _ := os.ReadFile(filepath.Join(NotesDirFor(mcpDir, slug), p.File))
			p.Body = string(body)
			return p, true
		}
	}
	return NotePage{}, false
}

// NextPageNum returns the next free content-page number (>= 1), skipping the Appendix.
func NextPageNum(pages []NotePage) int {
	next := 1
	for _, p := range pages {
		if p.Num >= next {
			next = p.Num + 1
		}
	}
	return next
}

// UpsertPage files bullets under a titled content page: an existing content page with
// the same title (case-insensitive) has the bullets appended; otherwise a new
// next-numbered page is created. The Appendix is regenerated and the manifest touched
// so the index and recency stay current. Creating a new non-Task-Log page pushes any
// existing Task Log page(s) to higher numbers so they stay the notebook's last pages.
func UpsertPage(mcpDir, slug, title string, bullets []string) error {
	title = SanitizePageTitle(title)
	dir := NotesDirFor(mcpDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	pages := ListPages(mcpDir, slug)
	num := NextPageNum(pages)
	body := "# " + title + "\n"
	reused := false
	// An existing content page with the same title (case-insensitive) is reused —
	// keep its number AND its original title so we append in place, not fork a file.
	for _, p := range pages {
		if p.Num != AppendixNum && strings.EqualFold(p.Title, title) {
			num, title, body = p.Num, p.Title, p.Body
			reused = true
			break
		}
	}
	if _, isLog := TaskLogSeq(title); !reused && !isLog {
		if err := pushTaskLogPagesAfter(mcpDir, slug, num, pages); err != nil {
			return err
		}
	}
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	for _, b := range bullets {
		if b = strings.TrimSpace(b); b != "" {
			// A block that's already a heading (e.g. a task-log entry) is inserted as
			// its own block, blank-line separated, rather than folded into a bullet.
			if strings.HasPrefix(b, "#") {
				if !strings.HasSuffix(body, "\n\n") {
					body += "\n"
				}
				body += b + "\n\n"
			} else {
				body += "- " + b + "\n"
			}
		}
	}
	if err := os.WriteFile(filepath.Join(dir, PageFileName(num, title)), []byte(body), 0o644); err != nil {
		return err
	}
	if err := RebuildAppendix(mcpDir, slug); err != nil {
		return err
	}
	return TouchNotebook(mcpDir, slug, "")
}

// TaskLogSeq reports whether title is a Task Log page's title ("Task Log" or
// "Task Log N"), returning its sequence number (1 for the bare title).
func TaskLogSeq(title string) (int, bool) {
	switch {
	case title == "Task Log":
		return 1, true
	case strings.HasPrefix(title, "Task Log "):
		if v, err := strconv.Atoi(strings.TrimPrefix(title, "Task Log ")); err == nil && v > 1 {
			return v, true
		}
	}
	return 0, false
}

// pushTaskLogPagesAfter renumbers any existing Task Log pages so they all sit at
// numbers greater than afterNum, in their existing sequence order — keeping them
// the notebook's last pages whenever a new non-Task-Log page claims a number.
// No-op if there's no Task Log page yet.
func pushTaskLogPagesAfter(mcpDir, slug string, afterNum int, pages []NotePage) error {
	var logs []NotePage
	for _, p := range pages {
		if _, ok := TaskLogSeq(p.Title); ok {
			logs = append(logs, p)
		}
	}
	if len(logs) == 0 {
		return nil
	}
	sort.Slice(logs, func(i, j int) bool {
		ni, _ := TaskLogSeq(logs[i].Title)
		nj, _ := TaskLogSeq(logs[j].Title)
		return ni < nj
	})
	dir := NotesDirFor(mcpDir, slug)
	next := afterNum + 1
	for _, p := range logs {
		if p.Num != next {
			oldPath := filepath.Join(dir, p.File)
			newPath := filepath.Join(dir, PageFileName(next, p.Title))
			if err := os.Rename(oldPath, newPath); err != nil {
				return err
			}
		}
		next++
	}
	return nil
}

// RebuildAppendix regenerates a notebook's "#0 (Appendix).md": the notebook title and
// summary, then a "## Pages" index of within-notebook [[#N (Title)]] links to every
// content page in order. Server-owned and overwritten on every page change, so it can
// never drift from the real page list.
func RebuildAppendix(mcpDir, slug string) error {
	dir := NotesDirFor(mcpDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	nb := LoadNotebook(mcpDir, slug)
	var b strings.Builder
	b.WriteString("# " + nb.Title + " — Appendix\n\n")
	if s := strings.TrimSpace(nb.Summary); s != "" {
		b.WriteString(s + "\n\n")
	}
	b.WriteString("## Pages\n")
	count := 0
	for _, p := range ListPages(mcpDir, slug) {
		if p.Num == AppendixNum {
			continue
		}
		fmt.Fprintf(&b, "- [[#%d (%s)]]\n", p.Num, p.Title)
		count++
	}
	if count == 0 {
		b.WriteString("_No pages yet._\n")
	}
	return os.WriteFile(filepath.Join(dir, PageFileName(AppendixNum, AppendixTitle)), []byte(b.String()), 0o644)
}

// MergeNotebookPages copies every content page of `from` into `into` as one new page
// titled after `from`'s display title, preserving the markdown verbatim, then refreshes
// `into`'s Appendix. A no-op when `from` has no content. Used by consolidation.
func MergeNotebookPages(mcpDir, from, into string) error {
	var b strings.Builder
	for _, p := range ListPages(mcpDir, from) {
		if p.Num == AppendixNum {
			continue
		}
		b.WriteString(strings.TrimRight(p.Body, "\n"))
		b.WriteString("\n\n")
	}
	content := strings.TrimSpace(b.String())
	if content == "" {
		return nil
	}
	title := LoadNotebook(mcpDir, from).Title
	dir := NotesDirFor(mcpDir, into)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	num := NextPageNum(ListPages(mcpDir, into))
	body := "# " + SanitizePageTitle(title) + "\n\n" + content + "\n"
	if err := os.WriteFile(filepath.Join(dir, PageFileName(num, title)), []byte(body), 0o644); err != nil {
		return err
	}
	return RebuildAppendix(mcpDir, into)
}
