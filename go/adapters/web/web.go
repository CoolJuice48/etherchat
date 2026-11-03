// Package web is the read-only web view: email-code sign-in,
// ether pages, file pages, history, downloads, and zip export.
package web

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/yuin/goldmark"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/core/ratelimit"
)

//go:embed templates/*.html static/*
var assets embed.FS

// SessionCookie is the browser session cookie. The __Host- prefix makes
// browsers require Secure, Path=/ and no Domain attribute.
const SessionCookie = "__Host-ether_session"

const (
	pageCSP     = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
	downloadCSP = "default-src 'none'; sandbox"
)

// Config is what the web view needs.
type Config struct {
	Ethers  *ether.Service
	Auth    *auth.Service
	OAuth   *oauth.Server // nil leaves out the OAuth consent page
	Mailer  mail.Mailer   // sends invites
	BaseURL string        // like https://etherchat.example, for links in emails
	Log     *slog.Logger

	// Location is the time zone pages show times in (UTC if nil).
	Location *time.Location

	// AllowCommand is how an admin allows an address, shown in the email a
	// member can send them; EMAIL stands for the address.
	AllowCommand string

	// MailPreviews serves /dev/mail, the emails rendered with sample data.
	// Development only: set when the config has a [dev] section.
	MailPreviews bool
}

// Handler serves the web view.
type Handler struct {
	ethers  *ether.Service
	auth    *auth.Service
	oauth   *oauth.Server
	mail    mail.Mailer
	baseURL string
	log     *slog.Logger
	md      goldmark.Markdown
	pages   map[string]*template.Template
	mux     *http.ServeMux
	codeCSP string // the code page's CSP: pageCSP plus its one script, by hash

	allowCmd string
	limits   *ratelimit.Window // requests to admins, per account
	loc      *time.Location
}

// New returns the web view, wrapped in cross-origin protection: browsers
// can't submit a form here from another site.
func New(c Config) (http.Handler, error) {
	h := &Handler{ethers: c.Ethers, auth: c.Auth, oauth: c.OAuth, mail: c.Mailer, baseURL: strings.TrimRight(c.BaseURL, "/"),
		log: c.Log, md: newMarkdown(), pages: map[string]*template.Template{}, allowCmd: c.AllowCommand, limits: ratelimit.New(time.Now)}
	if h.allowCmd == "" {
		h.allowCmd = "etherd admin allow --email EMAIL"
	}
	if h.loc = c.Location; h.loc == nil {
		h.loc = time.UTC
	}
	if h.mail == nil {
		h.mail = mail.Disabled{}
	}
	css, err := assets.ReadFile("static/style.css")
	if err != nil {
		return nil, err
	}
	// The stylesheet URL carries a hash of its content, so browsers can cache
	// it and still pick up a new version right after a deploy.
	sum := sha256.Sum256(css)
	cssURL := "/static/style.css?v=" + hex.EncodeToString(sum[:6])
	// The code page's six boxes need one small script. It's inlined, and the
	// page's CSP allows exactly that script by its SHA-256, nothing else.
	otp, err := assets.ReadFile("static/otp.js")
	if err != nil {
		return nil, err
	}
	otpSum := sha256.Sum256(otp)
	h.codeCSP = pageCSP + "; script-src 'sha256-" + base64.StdEncoding.EncodeToString(otpSum[:]) + "'"
	funcs := template.FuncMap{
		"fileURL": fileURL, "rawURL": rawURL, "downloadURL": downloadURL, "historyURL": historyURL,
		"etherURL": etherURL, "stamp": h.stamp, "zone": h.zone, "size": humanSize, "cssURL": func() string { return cssURL },
		"commsURL": commsURL, "sharedURL": sharedURL, "agentURL": agentURL, "dict": dict,
		"client": h.clientName, "plural": plural, "folderID": folderID,
		"intents":   func() []string { return []string{"update", "primer", "review", "handoff", "fyi"} },
		"otpScript": func() template.JS { return template.JS(otp) },
	}
	for _, name := range []string{"landing", "login", "code", "home", "newether", "invite", "account", "overview", "comms", "shared", "agent", "file", "history", "error", "consent"} {
		t, err := template.New("").Funcs(funcs).ParseFS(assets, "templates/layout.html", "templates/tabs.html", "templates/"+name+".html")
		if err != nil {
			return nil, err
		}
		h.pages[name] = t
	}

	m := http.NewServeMux()
	m.HandleFunc("GET /static/style.css", h.css)
	m.HandleFunc("GET /robots.txt", robots)
	m.HandleFunc("GET /favicon.ico", noIcon)
	m.HandleFunc("GET /{$}", h.root)
	m.HandleFunc("GET /login", h.loginForm)
	m.HandleFunc("POST /login", h.loginSubmit)
	m.HandleFunc("POST /login/verify", h.verifySubmit)
	m.HandleFunc("POST /logout", h.logout)
	m.HandleFunc("GET /account", h.signedIn(h.accountPage))
	m.HandleFunc("POST /account/emails", h.signedIn(h.accountEmails))
	m.HandleFunc("GET /new", h.signedIn(h.newEtherPage))
	m.HandleFunc("POST /ethers", h.signedIn(h.createEther))
	m.HandleFunc("POST /allow-requests", h.signedIn(h.askAdmin))
	m.HandleFunc("GET /invite/{code}", h.signedIn(h.invitePage))
	m.HandleFunc("POST /invite/{code}", h.signedIn(h.inviteAnswer))
	m.HandleFunc("POST /e/{id}/invites", h.signedIn(h.inviteSend))
	m.HandleFunc("POST /e/{id}/invites/{invite}/revoke", h.signedIn(h.inviteRevoke))
	m.HandleFunc("POST /e/{id}/members/{handle}/remove", h.signedIn(h.memberRemove))
	m.HandleFunc("POST /e/{id}/requests/{request}/answer", h.signedIn(h.answerRequest))
	m.HandleFunc("POST /e/{id}/agent-name", h.signedIn(h.agentName))
	m.HandleFunc("GET /e/{id}", h.signedIn(h.overviewPage))
	m.HandleFunc("GET /e/{id}/comms", h.signedIn(h.commsPage))
	m.HandleFunc("GET /e/{id}/shared", h.signedIn(h.sharedPage))
	m.HandleFunc("GET /e/{id}/m/{handle}", h.signedIn(h.agentPage))
	m.HandleFunc("GET /e/{id}/f/{path...}", h.signedIn(h.filePage))
	m.HandleFunc("GET /e/{id}/d/{path...}", h.signedIn(h.download))
	m.HandleFunc("GET /e/{id}/h/{path...}", h.signedIn(h.historyPage))
	m.HandleFunc("GET /e/{id}/export.zip", h.signedIn(h.export))
	if c.OAuth != nil {
		m.HandleFunc("GET /oauth/authorize", h.authorizeGet)
		m.HandleFunc("POST /oauth/authorize", h.authorizePost)
	}
	if c.MailPreviews {
		m.HandleFunc("GET /dev/mail/{$}", h.mailPreviewIndex)
		m.HandleFunc("GET /dev/mail/{name}", h.mailPreview)
	}
	h.mux = m

	return http.NewCrossOriginProtection().Handler(h), nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", pageCSP)
	w.Header().Set("Cache-Control", "no-store")
	h.mux.ServeHTTP(w, r)
}

// view is the data every template receives.
type view struct {
	Title   string
	Account *ether.Account
	Error   string
	Notice  string

	Email, Next string
	Connector   string // the MCP address apps connect to

	Ethers          []ether.Ether
	Stats           map[string]ether.EtherStats // by ether id, for the directory
	RequestCounts   map[string]int              // by ether id: open requests waiting for you
	Invites         []ether.Invite              // home: invites for you; ether pages: the ether's pending invites
	CanChangeHandle bool
	Draft           etherDraft // the new-ether form, refilled after an error

	// Addresses an invite couldn't go to, and whether an admin can be asked
	// to allow them (the button returns to AskBack).
	NotAllowed  []string
	CanAskAdmin bool
	AskBack     string

	Invite      *ether.Invite // the invite page
	IsOwner     bool
	CanInvite   bool // the ether has room for another member
	NeedConnect bool // your agent hasn't worked in this ether yet

	Requests    []requestView // Comms: this page of the ether's requests
	NeedsYou    []requestView // Overview: open requests waiting for your answer
	RequestsAny bool          // Comms: the ether has requests at all
	PostsAny    bool          // Comms: the ether has messages at all
	RF, MF      listFilter    // Comms: the requests' and messages' filters and pages
	FileRows    []fileRow     // Shared files: this page of files
	FilesAny    bool          // Shared files: there are any at all
	FF          listFilter    // Shared files: the list's filters and pages

	Ether    *ether.Ether
	Tab      string // "overview", "comms", "shared", or "@" + a member's handle
	Members  []memberView
	Agent    *memberView
	Tree     []treeEntry
	Posts    []postView
	Activity []activityView
	Act      activityPager // the Overview's activity filter and pages
	Files    int
	Shared   int
	PostsN   int
	Crumbs   []crumb // a file's path, each folder linking to where it's shown
	Back     string  // where a file page's Back link goes

	Consent *consentView

	File    *fileView
	History []ether.VersionInfo
	Path    string
	Status  int
}

type treeEntry struct {
	ether.FileInfo
	Name  string
	Depth int
}

type fileView struct {
	ether.FileInfo
	Rendered template.HTML
	Text     string
	Markdown bool
	Head     int64
}

func (h *Handler) render(w http.ResponseWriter, status int, name string, v *view) {
	if name == "code" {
		w.Header().Set("Content-Security-Policy", h.codeCSP)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := h.pages[name].ExecuteTemplate(w, "layout", v); err != nil {
		h.log.Error("rendering page", "page", name, "err", err)
	}
}

// fail renders an error page for a domain error.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, acct *ether.Account, err error) {
	v := &view{Account: acct, Title: "Not found", Status: http.StatusNotFound,
		Error: "That doesn't exist, or you aren't a member of its ether."}
	switch {
	case errors.Is(err, ether.ErrNotFound):
	case errors.Is(err, ether.ErrInvalid):
		v.Title, v.Status, v.Error = "Bad request", http.StatusBadRequest, err.Error()
	case errors.Is(err, ether.ErrForbidden):
		v.Title, v.Status, v.Error = "Not allowed", http.StatusForbidden, err.Error()
	default:
		h.log.Error("web request failed", "path", r.URL.Path, "err", err)
		v.Title, v.Status, v.Error = "Something went wrong", http.StatusInternalServerError, "Something went wrong on the server."
	}
	h.render(w, v.Status, "error", v)
}

// signedIn requires a session, redirecting to the sign-in page otherwise.
func (h *Handler) signedIn(next func(http.ResponseWriter, *http.Request, *ether.Account)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		acct := h.currentAccount(r)
		if acct == nil {
			http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusSeeOther)
			return
		}
		next(w, r, acct)
	}
}

func (h *Handler) currentAccount(r *http.Request) *ether.Account {
	c, err := r.Cookie(SessionCookie)
	if err != nil {
		return nil
	}
	acct, err := h.auth.SessionAccount(r.Context(), c.Value)
	if err != nil {
		return nil
	}
	return acct
}

// safeNext keeps post-sign-in redirects on this site.
func safeNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") {
		return "/"
	}
	return next
}

func (h *Handler) loginForm(w http.ResponseWriter, r *http.Request) {
	next := safeNext(r.URL.Query().Get("next"))
	if h.currentAccount(r) != nil {
		http.Redirect(w, r, next, http.StatusSeeOther)
		return
	}
	h.render(w, http.StatusOK, "login", &view{Title: "Sign in", Next: next})
}

func (h *Handler) loginSubmit(w http.ResponseWriter, r *http.Request) {
	email, next := strings.TrimSpace(r.FormValue("email")), safeNext(r.FormValue("next"))
	err := h.auth.RequestCode(r.Context(), email, ratelimit.ClientIP(r))
	switch {
	case errors.Is(err, ether.ErrInvalid):
		h.render(w, http.StatusBadRequest, "login", &view{Title: "Sign in", Email: email, Next: next, Error: "Enter a plain email address, like you@example.com."})
	case errors.Is(err, auth.ErrRateLimited):
		h.render(w, http.StatusTooManyRequests, "login", &view{Title: "Sign in", Email: email, Next: next, Error: err.Error()})
	case err != nil:
		h.fail(w, r, nil, err)
	default:
		h.render(w, http.StatusOK, "code", &view{Title: "Enter your code", Email: email, Next: next})
	}
}

func (h *Handler) verifySubmit(w http.ResponseWriter, r *http.Request) {
	email, next := strings.TrimSpace(r.FormValue("email")), safeNext(r.FormValue("next"))
	acct, err := h.auth.VerifyCode(r.Context(), email, r.FormValue("code"), ratelimit.ClientIP(r))
	if errors.Is(err, auth.ErrBadCode) || errors.Is(err, auth.ErrRateLimited) {
		status := http.StatusUnauthorized
		if errors.Is(err, auth.ErrRateLimited) {
			status = http.StatusTooManyRequests
		}
		h.render(w, status, "code", &view{Title: "Enter your code", Email: email, Next: next, Error: err.Error()})
		return
	}
	if err != nil {
		h.fail(w, r, nil, err)
		return
	}
	token, expires, err := h.auth.NewSession(r.Context(), acct.ID)
	if err != nil {
		h.fail(w, r, nil, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: token, Path: "/", Expires: expires,
		MaxAge: int(time.Until(expires).Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, next, http.StatusSeeOther)
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookie); err == nil {
		if err := h.auth.EndSession(r.Context(), c.Value); err != nil {
			h.log.Error("ending session", "err", err)
		}
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", MaxAge: -1,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (h *Handler) homeView(r *http.Request, acct *ether.Account) (*view, error) {
	a := ether.Actor{AccountID: acct.ID}
	list, err := h.ethers.ListEthers(r.Context(), a)
	if err != nil {
		return nil, err
	}
	invites, err := h.ethers.PendingInvitesFor(r.Context(), a)
	if err != nil {
		return nil, err
	}
	stats, err := h.ethers.DirectoryStats(r.Context(), a)
	if err != nil {
		return nil, err
	}
	counts, err := h.ethers.OpenRequestCounts(r.Context(), a)
	if err != nil {
		return nil, err
	}
	return &view{Title: "Your ethers", Account: acct, Ethers: list, Stats: stats, RequestCounts: counts, Invites: invites,
		CanChangeHandle: len(list) == 0}, nil
}

// root is the signed-in home, or the landing page for everyone else: what
// Etherchat is and how an invited person connects their AI app.
func (h *Handler) root(w http.ResponseWriter, r *http.Request) {
	if acct := h.currentAccount(r); acct != nil {
		h.home(w, r, acct)
		return
	}
	h.render(w, http.StatusOK, "landing", &view{Title: "Shared memory for AI agents", Connector: h.connector()})
}

func (h *Handler) home(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	v, err := h.homeView(r, acct)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	v.Notice = notice(r)
	h.render(w, http.StatusOK, "home", v)
}

// allPosts returns every published post, oldest first.
func (h *Handler) allPosts(r *http.Request, a ether.Actor, id string) ([]ether.Post, error) {
	var all []ether.Post
	var since time.Time
	for {
		page, err := h.ethers.ReadBoard(r.Context(), a, id, since, 200)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if len(page) < 200 {
			return all, nil
		}
		since = *page[len(page)-1].PublishedAt
	}
}

func versionParam(r *http.Request) (int64, error) {
	v := r.URL.Query().Get("v")
	if v == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%w: version must be a positive number", ether.ErrInvalid)
	}
	return n, nil
}

func (h *Handler) filePage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	a, id, path := ether.Actor{AccountID: acct.ID}, r.PathValue("id"), r.PathValue("path")
	version, err := versionParam(r)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	f, err := h.ethers.ReadFile(r.Context(), a, id, path, version)
	if errors.Is(err, ether.ErrFolder) {
		http.Redirect(w, r, etherURL(id), http.StatusSeeOther)
		return
	}
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	if r.URL.Query().Get("raw") == "1" {
		w.Header().Set("Content-Security-Policy", downloadCSP)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(f.Content)
		return
	}
	hist, err := h.ethers.FileHistory(r.Context(), a, id, path)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	e, err := h.ethers.GetEther(r.Context(), a, id)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	fv := &fileView{FileInfo: f.FileInfo, Head: hist[0].Version}
	if strings.HasPrefix(f.MIME, "text/markdown") {
		fv.Markdown = true
		if fv.Rendered, err = renderMarkdown(h.md, f.Content); err != nil {
			h.fail(w, r, acct, err)
			return
		}
	} else {
		fv.Text = string(f.Content)
	}
	crumbs := pathCrumbs(id, f.Path)
	h.render(w, http.StatusOK, "file", &view{Title: f.Path, Account: acct, Ether: e, File: fv, Crumbs: crumbs, Back: backURL(crumbs)})
}

func (h *Handler) download(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	a, id, path := ether.Actor{AccountID: acct.ID}, r.PathValue("id"), r.PathValue("path")
	version, err := versionParam(r)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	f, err := h.ethers.ReadFile(r.Context(), a, id, path, version)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	name := f.Path[strings.LastIndexByte(f.Path, '/')+1:]
	w.Header().Set("Content-Security-Policy", downloadCSP)
	w.Header().Set("Content-Type", f.MIME)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Length", strconv.Itoa(len(f.Content)))
	w.Write(f.Content)
}

func (h *Handler) historyPage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	a, id, path := ether.Actor{AccountID: acct.ID}, r.PathValue("id"), r.PathValue("path")
	e, err := h.ethers.GetEther(r.Context(), a, id)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	hist, err := h.ethers.FileHistory(r.Context(), a, id, path)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	crumbs := pathCrumbs(id, path)
	crumbs[len(crumbs)-1].URL = fileURL(id, path)
	h.render(w, http.StatusOK, "history", &view{Title: "History of " + path, Account: acct, Ether: e, Path: path, History: hist,
		Crumbs: crumbs, Back: fileURL(id, path)})
}

func (h *Handler) css(w http.ResponseWriter, r *http.Request) {
	b, err := assets.ReadFile("static/style.css")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Write(b)
}

// noIcon answers the browser's icon request with nothing, so it doesn't
// show up as a 404 on every page. (A data: icon link would break img-src.)
func noIcon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(http.StatusNoContent)
}

func robots(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte("User-agent: *\nDisallow: /\n"))
}

// URL helpers. Each path segment is escaped separately so "/" stays a separator.
func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

func etherURL(id string) string { return "/e/" + url.PathEscape(id) }

func fileURL(id, path string) string { return etherURL(id) + "/f/" + escapePath(path) }

func rawURL(id, path string, version int64) string {
	return fileURL(id, path) + "?raw=1&v=" + strconv.FormatInt(version, 10)
}

func downloadURL(id, path string, version int64) string {
	return etherURL(id) + "/d/" + escapePath(path) + "?v=" + strconv.FormatInt(version, 10)
}

func historyURL(id, path string) string { return etherURL(id) + "/h/" + escapePath(path) }

// stamp shows a time in the site's time zone, like "2026-10-12 18:33 EDT".
func (h *Handler) stamp(v any) string {
	var t time.Time
	switch x := v.(type) {
	case time.Time:
		t = x
	case *time.Time:
		if x == nil {
			return ""
		}
		t = *x
	default:
		return ""
	}
	return t.In(h.loc).Format("2006-01-02 15:04 MST")
}

// zone is the site's time zone as it's called right now, like "EDT".
func (h *Handler) zone() string { return time.Now().In(h.loc).Format("MST") }

func humanSize(n int64) string {
	switch {
	case n < 1024:
		return strconv.FormatInt(n, 10) + " B"
	case n < 1<<20:
		return strconv.FormatFloat(float64(n)/1024, 'f', 1, 64) + " KB"
	default:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	}
}

// plural writes a count with the right form of a noun: "1 agent interaction",
// "36 agent interactions".
func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// dict builds a map from key/value pairs, for passing several values to a
// template partial.
func dict(kv ...any) (map[string]any, error) {
	if len(kv)%2 != 0 {
		return nil, fmt.Errorf("dict: odd number of arguments")
	}
	m := make(map[string]any, len(kv)/2)
	for i := 0; i < len(kv); i += 2 {
		k, ok := kv[i].(string)
		if !ok {
			return nil, fmt.Errorf("dict: key %v is not a string", kv[i])
		}
		m[k] = kv[i+1]
	}
	return m, nil
}

// clientName shows an MCP client by the name it registered, falling back to
// its ID (e.g. "dev" for the local development token).
func (h *Handler) clientName(id string) string {
	if h.oauth == nil || id == "" {
		return id
	}
	return h.oauth.ClientName(context.Background(), id)
}
