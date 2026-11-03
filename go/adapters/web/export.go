package web

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/CoolJuice48/etherchat/go/core/ether"
)

type manifestFile struct {
	Path      string `json:"path"`
	Type      string `json:"type"`
	Size      int64  `json:"size"`
	Version   int64  `json:"version"`
	Author    string `json:"author"`
	UpdatedBy string `json:"updated_by"`
	Client    string `json:"client,omitempty"`
	UpdatedAt string `json:"updated_at"`
	SHA256    string `json:"sha256"`
}

type manifest struct {
	Ether      string         `json:"ether"`
	EtherID    string         `json:"ether_id"`
	Owner      string         `json:"owner"`
	Members    []string       `json:"members"`
	ExportedAt string         `json:"exported_at"`
	Files      []manifestFile `json:"files"`
}

// safeName turns an ether name into a file name.
func safeName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.', r == ' ':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	s := strings.Trim(b.String(), " .-")
	if s == "" {
		return "ether"
	}
	return s
}

// export streams the ether as a zip: current versions of
// every file, board.md, requests.md, and manifest.json. Paths come from validated ether
// paths, so entries can't escape the archive's root folder.
func (h *Handler) export(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	ctx, a, id := r.Context(), ether.Actor{AccountID: acct.ID}, r.PathValue("id")
	e, err := h.ethers.GetEther(ctx, a, id)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	entries, err := h.ethers.ListFiles(ctx, a, id, "", true)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	posts, err := h.allPosts(r, a, id)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	requests, err := h.ethers.ListRequests(ctx, a, id)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}

	root := safeName(e.Name)
	w.Header().Set("Content-Security-Policy", downloadCSP)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": root + ".zip"}))
	zw := zip.NewWriter(w)
	// Once the first byte is written the status is 200, so failures after
	// this point can only be logged; the client gets a truncated zip.
	abort := func(err error) { h.log.Error("zip export failed", "ether", id, "err", err) }

	m := manifest{Ether: e.Name, EtherID: e.ID, Owner: "@" + e.OwnerHandle, ExportedAt: time.Now().In(h.loc).Format(time.RFC3339),
		Members: make([]string, len(e.Members)), Files: []manifestFile{}}
	for i, mem := range e.Members {
		m.Members[i] = "@" + mem.Handle
	}
	for _, fi := range entries {
		if fi.Kind == "folder" {
			if _, err := zw.CreateHeader(&zip.FileHeader{Name: root + "/" + fi.Path + "/", Modified: fi.UpdatedAt}); err != nil {
				abort(err)
				return
			}
			continue
		}
		f, err := h.ethers.ReadFile(ctx, a, id, fi.Path, 0)
		if err != nil {
			abort(err)
			return
		}
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: root + "/" + f.Path, Method: zip.Deflate, Modified: f.UpdatedAt})
		if err != nil {
			abort(err)
			return
		}
		if _, err := fw.Write(f.Content); err != nil {
			abort(err)
			return
		}
		m.Files = append(m.Files, manifestFile{Path: f.Path, Type: f.MIME, Size: f.Size, Version: f.Version,
			Author: "@" + f.Author, UpdatedBy: "@" + f.UpdatedBy, Client: f.ClientID,
			UpdatedAt: f.UpdatedAt.In(h.loc).Format(time.RFC3339Nano), SHA256: f.SHA256})
	}

	board, err := zw.CreateHeader(&zip.FileHeader{Name: root + "/board.md", Method: zip.Deflate, Modified: time.Now()})
	if err != nil {
		abort(err)
		return
	}
	fmt.Fprintf(board, "# %s — message board\n\n", e.Name)
	if len(posts) == 0 {
		fmt.Fprintln(board, "No posts.")
	}
	for _, p := range posts {
		title := p.Title
		if title == "" {
			title = "(untitled)"
		}
		fmt.Fprintf(board, "## %s\n\n@%s · %s · %s", title, p.Author, p.Intent, p.PublishedAt.In(h.loc).Format(time.RFC3339))
		if p.ClientID != "" {
			fmt.Fprintf(board, " · via %s", p.ClientID)
		}
		if p.ReplyTo != "" {
			fmt.Fprintf(board, " · reply to %s", p.ReplyTo)
		}
		fmt.Fprintf(board, " · id %s\n\n%s\n\n", p.ID, strings.TrimSpace(p.Body))
	}

	reqs, err := zw.CreateHeader(&zip.FileHeader{Name: root + "/requests.md", Method: zip.Deflate, Modified: time.Now()})
	if err != nil {
		abort(err)
		return
	}
	fmt.Fprintf(reqs, "# %s — requests\n\n", e.Name)
	if len(requests) == 0 {
		fmt.Fprintln(reqs, "No requests.")
	}
	for i := len(requests) - 1; i >= 0; i-- { // oldest first, like board.md
		rq := requests[i]
		asked := make([]string, len(rq.To))
		for i, rc := range rq.To {
			asked[i] = rc.Handle
		}
		fmt.Fprintf(reqs, "## %s\n\n%s asked %s · %s · %s", rq.Title, e.Agent(rq.From), people(asked), rq.Status, rq.CreatedAt.In(h.loc).Format(time.RFC3339))
		if rq.ClientID != "" {
			fmt.Fprintf(reqs, " · via %s", rq.ClientID)
		}
		fmt.Fprintf(reqs, " · id %s\n\n", rq.ID)
		if body := strings.TrimSpace(rq.Body); body != "" {
			fmt.Fprintf(reqs, "%s\n\n", body)
		}
		if len(rq.Choices) > 0 {
			fmt.Fprintf(reqs, "Choices: %s\n\n", strings.Join(rq.Choices, " · "))
		}
		for _, rc := range rq.To {
			if !rc.Answered() {
				continue
			}
			fmt.Fprintf(reqs, "**@%s answered** (%s):", rc.Handle, rc.AnsweredAt.In(h.loc).Format(time.RFC3339))
			if t := rq.ChoiceText(rc.AnswerChoice); t != "" {
				fmt.Fprintf(reqs, " %s.", t)
			}
			if rc.AnswerNote != "" {
				fmt.Fprintf(reqs, " %s", rc.AnswerNote)
			}
			fmt.Fprint(reqs, "\n\n")
		}
	}

	mw, err := zw.CreateHeader(&zip.FileHeader{Name: root + "/manifest.json", Method: zip.Deflate, Modified: time.Now()})
	if err != nil {
		abort(err)
		return
	}
	enc := json.NewEncoder(mw)
	enc.SetIndent("", "  ")
	if err := enc.Encode(m); err != nil {
		abort(err)
		return
	}
	if err := zw.Close(); err != nil {
		abort(err)
	}
}
