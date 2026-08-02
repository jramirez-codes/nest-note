package agent

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	cronpkg "nestnote/server/internal/cron"
	"nestnote/server/internal/httpx"
	"nestnote/server/internal/project"
)

// projectsResponse is the JSON body of /projects: the directory names directly
// under the projects base — the slugs `/code <name>` selects among. Names only,
// no paths, since the phone just needs them to autocomplete the command.
type projectsResponse struct {
	Projects []string `json:"projects"`
}

// ProjectsHandler lists the existing project directories under projectsBase so
// the phone can autocomplete `/code <name>`. It is strictly read-only — unlike
// resolveProjectDir it never creates a dir — and answers with an empty list
// (never an error) when /code is disabled or the base doesn't exist yet, so the
// client can always treat the reply as "the projects to suggest, possibly none".
func ProjectsHandler(token, projectsBase string, enabled bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
			return
		}
		names := []string{}
		if enabled {
			if entries, err := os.ReadDir(projectsBase); err == nil {
				for _, e := range entries {
					// Directories only, skipping dotfiles (.git and friends) — those
					// are never valid /code targets.
					if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
						names = append(names, e.Name())
					}
				}
			}
		}
		sort.Strings(names)
		httpx.WriteJSON(w, projectsResponse{Projects: names})
	}
}

// deleteProjectRequest is the JSON body of POST /projects/delete: the human
// project name to remove. Slugged the same way resolveProjectDir slugs it, so
// the phone can send whatever the user typed and the same folder is targeted.
type deleteProjectRequest struct {
	Project string `json:"project"`
}

// DeleteProjectHandler removes projects/<slug> under projectsBase — the
// destructive counterpart to projectsHandler's read-only listing. Gated behind
// the same -allow-code flag: with /code off there are no phone-managed projects
// to delete, so it 403s just like the agent socket. The slug is reduced to
// [a-z0-9-] before it is joined onto the base (see slugFor), so a client name can
// never traverse out of the projects dir. A missing folder is reported as a 404
// rather than silently succeeding, so the phone can tell "already gone" from
// "removed".
//
// It also takes out any crontab line a scheduled build left for this project.
// That is mandatory, not a nicety: without it, deleting a project leaves cron
// firing every half hour at a directory that no longer exists.
func DeleteProjectHandler(token, projectsBase string, enabled bool, cronIO cronpkg.IO) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
			return
		}
		if !enabled {
			http.Error(w, "code disabled (start the server with -allow-code)", http.StatusForbidden)
			return
		}
		var req deleteProjectRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		slug := project.SlugFor(req.Project)
		if slug == "" {
			http.Error(w, "empty project name", http.StatusBadRequest)
			return
		}
		dir := filepath.Join(projectsBase, slug)
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			http.Error(w, "no such project", http.StatusNotFound)
			return
		}
		if err := os.RemoveAll(dir); err != nil {
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		// Best effort, and after the removal: a crontab we couldn't rewrite must not
		// stop the folder from being deleted, and the tick it fires at a missing
		// project is a harmless 404 that logs why.
		if err := cronpkg.RemoveLine(cronIO, slug); err != nil {
			log.Printf("projects: delete %s left its crontab line: %v", slug, err)
		}
		httpx.WriteJSON(w, struct {
			OK   bool   `json:"ok"`
			Slug string `json:"slug"`
		}{OK: true, Slug: slug})
	}
}
