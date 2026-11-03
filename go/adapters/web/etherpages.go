package web

import (
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/CoolJuice48/etherchat/go/core/ether"
)

// An ether has an overview tab, a comms tab (the board), a shared-files tab,
// and one tab per member's agent. Each tab is its own URL, so the pages need
// no JavaScript.

func commsURL(id string) string  { return etherURL(id) + "/comms" }
func sharedURL(id string) string { return etherURL(id) + "/shared" }
func agentURL(id, handle string) string {
	return etherURL(id) + "/m/" + url.PathEscape(handle)
}

type memberView struct {
	Handle     string
	Agent      string // what the member's agent is called: its chosen name, or "@handle"
	AgentName  string // the chosen name alone, "" for none
	Owner      bool
	Former     bool // no longer a member; their workspace stays as history
	JoinedAt   time.Time
	LastActive *time.Time
	Clients    []string
}

type activityView struct {
	At     time.Time
	Actor  string // the member's agent for things done through an app, "@handle" for things done on the website
	Handle string
	Client string
	Verb   string
	Object string
	Link   string
	Intent string
}

type crumb struct {
	Name string
	URL  string // "" for the current page
}

// folderID is the id of a folder's row in a file tree, so links can point at it.
func folderID(path string) string { return "d-" + url.PathEscape(path) }

// pathCrumbs splits a path into breadcrumbs, each linking to where that
// folder is shown: members/ to the overview's agents, a workspace to its
// agent's tab, shared/ to Shared files, and deeper folders to their row in
// that tab's tree. The last segment (the file) is the current page.
func pathCrumbs(id, path string) []crumb {
	segs := strings.Split(path, "/")
	out := make([]crumb, len(segs))
	tab := sharedURL(id)
	for i, seg := range segs {
		prefix := strings.Join(segs[:i+1], "/")
		out[i].Name = seg
		switch {
		case i == len(segs)-1:
			// the file itself
		case i == 0 && seg == "members":
			out[i].URL = etherURL(id) + "#agents-h"
		case i == 0:
			out[i].URL = tab
		case i == 1 && segs[0] == "members":
			tab = agentURL(id, seg)
			out[i].URL = tab
		case segs[0] == "shared":
			out[i].URL = tab + "?f_in=" + url.QueryEscape(prefix) + "#files-h"
		default:
			out[i].URL = tab + "#" + folderID(prefix)
		}
	}
	return out
}

// backURL is where a file's Back link goes: the folder it's in.
func backURL(crumbs []crumb) string {
	for i := len(crumbs) - 1; i >= 0; i-- {
		if crumbs[i].URL != "" {
			return crumbs[i].URL
		}
	}
	return ""
}

// etherView loads what every tab shows: the ether, its members, and when
// each was last active.
func (h *Handler) etherView(r *http.Request, acct *ether.Account, tab string) (*view, error) {
	a, id := ether.Actor{AccountID: acct.ID}, r.PathValue("id")
	e, err := h.ethers.GetEther(r.Context(), a, id)
	if err != nil {
		return nil, err
	}
	activity, err := h.ethers.MembersActivity(r.Context(), a, id)
	if err != nil {
		return nil, err
	}
	members := make([]memberView, 0, len(e.Members))
	for _, m := range e.Members {
		mv := memberView{Handle: m.Handle, Agent: m.Agent(), AgentName: m.AgentName, Owner: m.Owner, JoinedAt: m.JoinedAt}
		if act, ok := activity[m.Handle]; ok {
			t := act.LastActive
			mv.LastActive, mv.Clients = &t, act.Clients
		}
		members = append(members, mv)
	}
	return &view{Title: e.Name, Account: acct, Ether: e, Tab: tab, Members: members}, nil
}

// activityPageSize is how many events one page of Recent activity shows.
const activityPageSize = 25

// activityPager is Recent activity's filter and page links. The filter's
// times are read in the site's time zone, like every time the site shows.
type activityPager struct {
	From, To string // the filter as typed, for the form
	Err      string // why the filter couldn't be used
	Page     int
	Pages    int
	Total    int
	Newer    string // link to the newer page, "" on the first
	Older    string // link to the older page, "" on the last
	Clear    string // link without the filter, "" when there's none

	query url.Values
}

// datetimeLayouts are what a datetime-local field sends.
var datetimeLayouts = []string{"2006-01-02T15:04", "2006-01-02T15:04:05"}

// activityFilter reads ?from=, ?to= and ?page= into a filter. The end time
// is inclusive: "to 14:00" includes everything during 14:00.
func activityFilter(q url.Values, loc *time.Location) (ether.ActivityFilter, activityPager) {
	f := ether.ActivityFilter{Limit: activityPageSize}
	p := activityPager{From: q.Get("from"), To: q.Get("to"), Page: 1, query: url.Values{}}
	parse := func(s string) (time.Time, time.Duration, bool) {
		for i, layout := range datetimeLayouts {
			if t, err := time.ParseInLocation(layout, s, loc); err == nil {
				return t, []time.Duration{time.Minute, time.Second}[i], true
			}
		}
		return time.Time{}, 0, false
	}
	if p.From != "" {
		if t, _, ok := parse(p.From); ok {
			f.From = t
			p.query.Set("from", p.From)
		} else {
			p.Err = "Enter the start as a date and time, like 2026-10-12 14:00."
		}
	}
	if p.To != "" {
		if t, step, ok := parse(p.To); ok {
			f.Until = t.Add(step)
			p.query.Set("to", p.To)
		} else {
			p.Err = "Enter the end as a date and time, like 2026-10-12 18:00."
		}
	}
	if !f.From.IsZero() && !f.Until.IsZero() && !f.From.Before(f.Until) {
		p.Err = "The start is after the end."
	}
	if p.Err != "" {
		f.From, f.Until, p.query = time.Time{}, time.Time{}, url.Values{}
	}
	if n, err := strconv.Atoi(q.Get("page")); err == nil && n > 1 {
		p.Page = n
	}
	f.Offset = (p.Page - 1) * activityPageSize
	return f, p
}

// finish works out the page count and links once the total is known.
func (p *activityPager) finish(base string, total int) {
	p.Total = total
	p.Pages = max(1, (total+activityPageSize-1)/activityPageSize)
	link := func(page int) string {
		q := url.Values{}
		for k, v := range p.query {
			q[k] = v
		}
		if page > 1 {
			q.Set("page", strconv.Itoa(page))
		}
		if len(q) == 0 {
			return base + "#activity-h"
		}
		return base + "?" + q.Encode() + "#activity-h"
	}
	if p.Page > 1 {
		p.Newer = link(min(p.Page-1, p.Pages))
	}
	if p.Page < p.Pages {
		p.Older = link(p.Page + 1)
	}
	if len(p.query) > 0 {
		p.Clear = base + "#activity-h"
	}
}

// people writes handles as "@a", "@a and @b", or "@a, @b and @c".
func people(handles []string) string {
	at := make([]string, len(handles))
	for i, h := range handles {
		at[i] = "@" + h
	}
	if len(at) < 2 {
		return strings.Join(at, "")
	}
	return strings.Join(at[:len(at)-1], ", ") + " and " + at[len(at)-1]
}

func describe(eth *ether.Ether, e ether.Event) activityView {
	id := eth.ID
	v := activityView{At: e.At, Actor: "@" + e.Handle, Handle: e.Handle, Client: e.ClientID, Intent: e.Intent}
	if e.ClientID != "" {
		v.Actor = eth.Agent(e.Handle)
	}
	switch e.Action {
	case "ether.create":
		v.Verb = "created the ether"
	case "ether.rename":
		v.Verb, v.Object = "renamed the ether to", e.Target
	case "member.join":
		v.Verb = "joined"
	case "member.leave":
		v.Verb = "left"
	case "member.remove":
		v.Verb, v.Object = "removed", "@"+e.Target
	case "file.write":
		v.Verb = "created"
		if e.Version > 1 {
			v.Verb = fmt.Sprintf("wrote v%d of", e.Version)
		}
		v.Object, v.Link = e.Target, fmt.Sprintf("%s?v=%d", fileURL(id, e.Target), e.Version)
	case "file.delete":
		v.Verb, v.Object = "deleted", e.Target
	case "folder.create":
		v.Verb, v.Object = "created folder", e.Target+"/"
	case "folder.delete":
		v.Verb, v.Object = "deleted folder", e.Target+"/"
	case "file.mode":
		v.Verb, v.Object, v.Link = "changed who can edit", e.Target, fileURL(id, e.Target)
		if e.Mode == string(ether.ModeSharedEdit) {
			v.Verb = "opened for editing:"
		} else if e.Mode == string(ether.ModeAuthorOnly) {
			v.Verb = "made author-only:"
		}
	case "post.create":
		v.Verb, v.Link = "posted", commsURL(id)+"#p-"+e.Target
		v.Object = e.PostTitle
		if v.Object == "" {
			v.Object = "a message"
		}
	case "post.delete":
		v.Verb, v.Intent = "deleted a post", ""
	case "request.create":
		v.Verb, v.Object, v.Link = "asked "+people(e.RequestTo)+":", e.RequestTitle, commsURL(id)+"#r-"+e.Target
	case "request.answer":
		v.Verb, v.Object, v.Link = "answered "+eth.Agent(e.RequestFrom)+"'s request:", e.RequestTitle, commsURL(id)+"#r-"+e.Target
	case "agent.rename":
		v.Actor, v.Verb = "@"+e.Handle, "named their agent "+e.NewName
		if e.NewName == "" {
			v.Verb = "set their agent's name back to @" + e.Handle
		}
	default:
		v.Verb = e.Action
	}
	return v
}

func (h *Handler) overviewPage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	v, err := h.overviewView(r, acct)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	v.Notice = notice(r)
	h.render(w, http.StatusOK, "overview", v)
}

// overviewView loads the overview tab: counts, recent activity, and the
// people side (pending invites, room to invite, whether to show how to
// connect an AI).
func (h *Handler) overviewView(r *http.Request, acct *ether.Account) (*view, error) {
	v, err := h.etherView(r, acct, "overview")
	if err != nil {
		return nil, err
	}
	a, id := ether.Actor{AccountID: acct.ID}, v.Ether.ID
	f, pager := activityFilter(r.URL.Query(), h.loc)
	events, total, err := h.ethers.ActivityPage(r.Context(), a, id, f)
	if err != nil {
		return nil, err
	}
	for _, e := range events {
		v.Activity = append(v.Activity, describe(v.Ether, e))
	}
	pager.finish(etherURL(id), total)
	v.Act = pager
	entries, err := h.ethers.ListFiles(r.Context(), a, id, "", true)
	if err != nil {
		return nil, err
	}
	for _, fi := range entries {
		if fi.Kind == "file" {
			v.Files++
			if strings.HasPrefix(fi.Path, "shared/") {
				v.Shared++
			}
		}
	}
	posts, err := h.allPosts(r, a, id)
	if err != nil {
		return nil, err
	}
	v.PostsN = len(posts)
	if v.Invites, err = h.ethers.ListInvites(r.Context(), a, id); err != nil {
		return nil, err
	}
	requests, err := h.requestViews(r, acct, id)
	if err != nil {
		return nil, err
	}
	for _, rq := range requests {
		if rq.WaitingOn(acct.ID) {
			for _, rc := range rq.To {
				if rc.AccountID != acct.ID {
					rq.Others = append(rq.Others, rc.Handle)
				}
			}
			v.NeedsYou = append(v.NeedsYou, rq)
		}
	}
	v.IsOwner = v.Ether.OwnerID == acct.ID
	v.CanInvite = len(v.Members)+len(v.Invites) < h.ethers.MaxMembers()
	v.Connector = h.connector()
	v.NeedConnect = true
	for _, m := range v.Members {
		if m.Handle == acct.Handle && len(m.Clients) > 0 {
			v.NeedConnect = false
		}
	}
	return v, nil
}

func (h *Handler) commsPage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	v, err := h.etherView(r, acct, "comms")
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	q, base := r.URL.Query(), commsURL(v.Ether.ID)

	// Requests: filter by who was asked, when, and text; 5 a page.
	requests, err := h.requestViews(r, acct, v.Ether.ID)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	rf := parseListFilter(q, "r", "requests-h", commsPageSize, h.loc)
	var matched []requestView
	for _, rq := range requests {
		asked, texts := rf.Who == "", []string{rq.Title, rq.Body}
		for _, rc := range rq.To {
			asked = asked || rc.Handle == rf.Who
			texts = append(texts, rc.AnswerNote, rq.ChoiceText(rc.AnswerChoice))
		}
		if asked && rf.inRange(rq.CreatedAt) && rf.matches(texts...) {
			matched = append(matched, rq)
		}
	}
	start, end := rf.finish(base, q, len(matched))
	v.Requests, v.RequestsAny, v.RF = matched[start:end], len(requests) > 0, rf

	// Messages: filter by author, intent, when, and text; 5 a page.
	posts, err := h.allPosts(r, ether.Actor{AccountID: acct.ID}, v.Ether.ID)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	byID := make(map[string]ether.Post, len(posts))
	for _, p := range posts {
		byID[p.ID] = p
	}
	mf := parseListFilter(q, "m", "messages-h", commsPageSize, h.loc)
	var shown []ether.Post
	for i := len(posts) - 1; i >= 0; i-- { // newest first
		p := posts[i]
		if (mf.Who == "" || p.Author == mf.Who) && (mf.Tag == "" || string(p.Intent) == mf.Tag) &&
			p.PublishedAt != nil && mf.inRange(*p.PublishedAt) && mf.matches(p.Title, p.Body) {
			shown = append(shown, p)
		}
	}
	start, end = mf.finish(base, q, len(shown))
	for _, p := range shown[start:end] {
		pv, err := h.postView(p, byID)
		if err != nil {
			h.fail(w, r, acct, err)
			return
		}
		v.Posts = append(v.Posts, pv)
	}
	v.PostsAny, v.MF = len(posts) > 0, mf
	h.render(w, http.StatusOK, "comms", v)
}

func (h *Handler) postView(p ether.Post, byID map[string]ether.Post) (postView, error) {
	body, err := renderMarkdown(h.md, []byte(p.Body))
	if err != nil {
		return postView{}, err
	}
	pv := postView{Post: p, HTML: body}
	if parent, ok := byID[p.ReplyTo]; ok {
		pv.ReplyAuthor, pv.ReplyTitle = parent.Author, parent.Title
		if pv.ReplyTitle == "" {
			pv.ReplyTitle = "their post"
		}
	}
	return pv, nil
}

// fileRow is one file in the Shared files list.
type fileRow struct {
	ether.FileInfo
	Dir  string // its folder under shared/, like "slides/"; "" at the top
	Name string
}

// sharedPage lists the files in shared/, 10 a page, filtered by folder (from
// a breadcrumb), by who created or last wrote them, and by name.
func (h *Handler) sharedPage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	v, err := h.etherView(r, acct, "shared")
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	entries, err := h.ethers.ListFiles(r.Context(), ether.Actor{AccountID: acct.ID}, v.Ether.ID, "shared", true)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	q := r.URL.Query()
	f := parseListFilter(q, "f", "files-h", sharedPageSize, h.loc)
	var rows []fileRow
	for _, fi := range entries {
		if fi.Kind != "file" {
			continue
		}
		v.FilesAny = true
		if (f.In != "" && !strings.HasPrefix(fi.Path, f.In+"/")) ||
			(f.Who != "" && fi.Author != f.Who && fi.UpdatedBy != f.Who) || !f.matches(fi.Path) {
			continue
		}
		rel := strings.TrimPrefix(fi.Path, "shared/")
		dir, name := "", rel
		if i := strings.LastIndex(rel, "/"); i >= 0 {
			dir, name = rel[:i+1], rel[i+1:]
		}
		rows = append(rows, fileRow{FileInfo: fi, Dir: dir, Name: name})
	}
	start, end := f.finish(sharedURL(v.Ether.ID), q, len(rows))
	v.FileRows, v.FF = rows[start:end], f
	v.Title = "Shared files · " + v.Ether.Name
	h.render(w, http.StatusOK, "shared", v)
}

func (h *Handler) agentPage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	handle := r.PathValue("handle")
	v, err := h.etherView(r, acct, "@"+handle)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	for i := range v.Members {
		if v.Members[i].Handle == handle {
			v.Agent = &v.Members[i]
		}
	}
	tree, err := h.tree(r, acct, v.Ether.ID, "members/"+handle)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	if v.Agent == nil {
		// A former member: their workspace stays readable as history.
		v.Agent = &memberView{Handle: handle, Former: true}
	}
	v.Tree = tree
	events, err := h.ethers.Activity(r.Context(), ether.Actor{AccountID: acct.ID}, v.Ether.ID, handle, 40)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	for _, e := range events {
		v.Activity = append(v.Activity, describe(v.Ether, e))
	}
	v.Title = v.Ether.Agent(handle) + " · " + v.Ether.Name
	h.render(w, http.StatusOK, "agent", v)
}

// tree lists everything under root, with names and depths relative to it.
func (h *Handler) tree(r *http.Request, acct *ether.Account, id, root string) ([]treeEntry, error) {
	entries, err := h.ethers.ListFiles(r.Context(), ether.Actor{AccountID: acct.ID}, id, root, true)
	if errors.Is(err, ether.ErrInvalid) {
		return nil, ether.ErrNotFound // e.g. a handle that isn't a valid path segment
	}
	if err != nil {
		return nil, err
	}
	out := make([]treeEntry, 0, len(entries))
	for _, fi := range entries {
		segs := strings.Split(fi.Path[len(root)+1:], "/")
		out = append(out, treeEntry{FileInfo: fi, Name: segs[len(segs)-1], Depth: len(segs) - 1})
	}
	return out, nil
}

// postView is a board post rendered for the comms tab.
type postView struct {
	ether.Post
	HTML        template.HTML
	ReplyAuthor string
	ReplyTitle  string
}
