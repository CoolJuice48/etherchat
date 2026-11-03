package web

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/core/ether"
)

// People decide who is in an ether, so creating ethers, inviting, and
// answering invites happen here on the website. The contents (files and
// posts) stay with the agents.

// etherDraft is the new-ether form, kept so a mistake doesn't empty it.
type etherDraft struct {
	Name   string
	Emails []string // one per collaborator slot
}

func (h *Handler) newDraft() etherDraft {
	return etherDraft{Emails: make([]string, h.ethers.MaxMembers()-1)}
}

// notices are the confirmations a redirect can ask for with ?n=. Only these
// fixed sentences can appear, so a crafted link can't put words on the page.
var notices = map[string]string{
	"created":    "Ether created. The invites are on their way.",
	"solo":       "Ether created. Invite people below whenever you're ready.",
	"unsent":     "Some invite emails couldn't be sent. Invite those people again below.",
	"joined":     "You're in.",
	"invited":    "Invite sent.",
	"revoked":    "Invite withdrawn.",
	"removed":    "Member removed. Their files stay as history.",
	"declined":   "Invite declined.",
	"answered":   "Answer sent. The agents see it the next time they catch up.",
	"asked":      "Request sent to the server's admin. You can invite them once they've allowed it.",
	"asklimit":   "You've sent the admin enough requests for today. Try again tomorrow.",
	"asknotsent": "The request couldn't be sent. Try again later.",
	"saved":      "Saved.",
	"renamed":    "Your agent's name is saved.",
}

func notice(r *http.Request) string { return notices[r.URL.Query().Get("n")] }

// connector is the MCP address people add to their AI app.
func (h *Handler) connector() string { return h.baseURL + "/mcp" }

// userMessage turns a service error into a sentence for the page.
func userMessage(err error) string {
	msg := err.Error()
	for _, sentinel := range []error{ether.ErrInvalid, ether.ErrLimit, ether.ErrExists, ether.ErrNotAllowlisted, ether.ErrForbidden, ether.ErrNotFound} {
		if p := sentinel.Error() + ": "; strings.HasPrefix(msg, p) {
			msg = msg[len(p):]
			break
		}
	}
	r, n := utf8.DecodeRuneInString(msg)
	msg = string(unicode.ToUpper(r)) + msg[n:]
	if !strings.HasSuffix(msg, ".") {
		msg += "."
	}
	return msg
}

// notAllowed is the addresses an invite can't go to. The message stays vague
// on purpose; the page offers to ask the server's admin to allow them.
type notAllowed struct{ emails []string }

func (e *notAllowed) Error() string {
	if len(e.emails) == 1 {
		return "that address can't be invited here: " + e.emails[0] + ". Ask the server's admin"
	}
	return "these addresses can't be invited here: " + strings.Join(e.emails, ", ") + ". Ask the server's admin"
}

// offerAskAdmin sets up the "Ask the admin" button when err is notAllowed.
func (h *Handler) offerAskAdmin(r *http.Request, v *view, err error, back string) {
	var na *notAllowed
	if !errors.As(err, &na) {
		return
	}
	admins, aerr := h.ethers.AdminEmails(r.Context())
	if aerr != nil {
		h.log.Error("listing admins", "err", aerr)
	}
	v.NotAllowed, v.CanAskAdmin, v.AskBack = na.emails, len(admins) > 0, back
}

// askAdmin emails the server's admins the addresses a member tried to
// invite. Five requests a day per member, so nobody can flood the admins.
func (h *Handler) askAdmin(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	back := safeNext(r.FormValue("back"))
	sep := "?"
	if strings.Contains(back, "?") {
		sep = "&"
	}
	var emails []string
	seen := map[string]bool{}
	for _, raw := range r.PostForm["email"] {
		email, err := ether.NormalizeEmail(raw)
		if err != nil || seen[email] || len(emails) == h.ethers.MaxMembers()-1 {
			continue
		}
		if ok, err := h.ethers.IsAllowed(r.Context(), email); err != nil || ok {
			continue
		}
		seen[email] = true
		emails = append(emails, email)
	}
	if len(emails) == 0 {
		http.Redirect(w, r, back, http.StatusSeeOther)
		return
	}
	if !h.limits.Allow("ask-admin:"+acct.ID, 5, 24*time.Hour) {
		http.Redirect(w, r, back+sep+"n=asklimit", http.StatusSeeOther)
		return
	}
	admins, err := h.ethers.AdminEmails(r.Context())
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	sent := 0
	for _, admin := range admins {
		msg, err := mail.AllowRequestEmail(mail.AllowRequest{To: admin, FromEmail: acct.Email, FromHandle: acct.Handle,
			Emails: emails, Command: h.allowCmd})
		if err == nil {
			err = h.mail.Send(r.Context(), msg)
		}
		if err != nil {
			h.log.Error("sending allow request", "to", admin, "err", err)
			continue
		}
		sent++
	}
	if sent == 0 {
		http.Redirect(w, r, back+sep+"n=asknotsent", http.StatusSeeOther)
		return
	}
	if err := h.ethers.RecordAllowRequest(r.Context(), ether.Actor{AccountID: acct.ID}, emails); err != nil {
		h.log.Error("recording allow request", "err", err)
	}
	http.Redirect(w, r, back+sep+"n=asked", http.StatusSeeOther)
}

// checkInvitees normalizes the addresses typed into a form and checks each
// can be invited, before anything is created. Blank slots are skipped.
func (h *Handler) checkInvitees(ctx context.Context, acct *ether.Account, raw []string) ([]string, error) {
	seen := map[string]bool{}
	var out, blocked []string
	for _, s := range raw {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		email, err := ether.NormalizeEmail(s)
		if err != nil {
			return nil, fmt.Errorf("%q isn't an email address", s)
		}
		if email == acct.Email {
			return nil, errors.New("that's your own address; you're in the ether already")
		}
		if seen[email] {
			continue
		}
		seen[email] = true
		ok, err := h.ethers.IsAllowed(ctx, email)
		if err != nil {
			return nil, err
		}
		if !ok {
			blocked = append(blocked, email)
			continue
		}
		out = append(out, email)
	}
	if len(blocked) > 0 {
		return nil, &notAllowed{blocked}
	}
	return out, nil
}

// sendInvite creates an invite and emails its link. The link exists only in
// that email: the server keeps just a hash of the code. sent is false when
// the invite exists but the email failed; inviting again replaces it.
func (h *Handler) sendInvite(ctx context.Context, acct *ether.Account, etherID, email string) (sent bool, err error) {
	code, inv, err := h.ethers.CreateInvite(ctx, ether.Actor{AccountID: acct.ID}, etherID, email)
	if err != nil {
		return false, err
	}
	msg, err := mail.Invite(mail.InviteDetails{
		To: inv.Email, FromEmail: inv.InvitedByEmail, EtherName: inv.EtherName,
		Link: mail.InviteLink(h.baseURL, code), ExpiresAt: inv.ExpiresAt.In(h.loc),
	})
	if err == nil {
		err = h.mail.Send(ctx, msg)
	}
	if err != nil {
		h.log.Error("sending invite email", "to", inv.Email, "err", err)
		return false, nil
	}
	return true, nil
}

// newEtherPage is the form behind "Create new": a name, the collaborators to
// invite, and the person's handle if this is their first ether.
func (h *Handler) newEtherPage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	h.renderNewEther(w, r, acct, h.newDraft(), http.StatusOK, nil)
}

func (h *Handler) renderNewEther(w http.ResponseWriter, r *http.Request, acct *ether.Account, d etherDraft, status int, cause error) {
	list, err := h.ethers.ListEthers(r.Context(), ether.Actor{AccountID: acct.ID})
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	v := &view{Title: "New ether", Account: acct, Draft: d, Notice: notice(r), CanChangeHandle: len(list) == 0}
	if cause != nil {
		v.Error = userMessage(cause)
		h.offerAskAdmin(r, v, cause, "/new")
	}
	h.render(w, status, "newether", v)
}

func (h *Handler) createEther(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	d := h.newDraft()
	d.Name = strings.TrimSpace(r.FormValue("name"))
	copy(d.Emails, r.PostForm["email"])
	formError := func(err error) { h.renderNewEther(w, r, acct, d, http.StatusBadRequest, err) }

	emails, err := h.checkInvitees(r.Context(), acct, d.Emails)
	if err != nil {
		formError(err)
		return
	}
	if handle := strings.TrimSpace(strings.TrimPrefix(r.FormValue("handle"), "@")); handle != "" && handle != acct.Handle {
		if err := h.ethers.SetHandle(r.Context(), acct.ID, handle); err != nil {
			formError(err)
			return
		}
	}
	e, err := h.ethers.CreateEther(r.Context(), ether.Actor{AccountID: acct.ID}, d.Name)
	if errors.Is(err, ether.ErrInvalid) || errors.Is(err, ether.ErrLimit) {
		formError(err)
		return
	}
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	n := "solo"
	if len(emails) > 0 {
		n = "created"
	}
	for _, email := range emails {
		sent, err := h.sendInvite(r.Context(), acct, e.ID, email)
		if err != nil {
			h.log.Error("inviting after creating an ether", "ether", e.ID, "err", err)
		}
		if err != nil || !sent {
			n = "unsent"
		}
	}
	http.Redirect(w, r, etherURL(e.ID)+"?n="+n, http.StatusSeeOther)
}

// invitePage shows an invite to the person it was sent to. Opening it (or a
// mail scanner fetching the link) changes nothing; only the buttons do.
func (h *Handler) invitePage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	h.renderInvite(w, r, acct, "")
}

func (h *Handler) renderInvite(w http.ResponseWriter, r *http.Request, acct *ether.Account, errMsg string) {
	a := ether.Actor{AccountID: acct.ID}
	v := &view{Title: "Invitation", Account: acct, Error: errMsg}
	status := http.StatusOK
	if errMsg != "" {
		status = http.StatusBadRequest
	}
	inv, err := h.ethers.InviteByCode(r.Context(), a, r.PathValue("code"))
	switch {
	case errors.Is(err, ether.ErrNotFound):
		status = http.StatusNotFound
	case err != nil:
		h.fail(w, r, acct, err)
		return
	default:
		v.Invite = inv
	}
	list, err := h.ethers.ListEthers(r.Context(), a)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	v.CanChangeHandle = len(list) == 0
	h.render(w, status, "invite", v)
}

func (h *Handler) inviteAnswer(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	a, code := ether.Actor{AccountID: acct.ID}, r.PathValue("code")
	switch r.FormValue("decision") {
	case "decline":
		err := h.ethers.DeclineInvite(r.Context(), a, code)
		if errors.Is(err, ether.ErrNotFound) {
			h.renderInvite(w, r, acct, "")
			return
		}
		if err != nil {
			h.fail(w, r, acct, err)
			return
		}
		http.Redirect(w, r, "/?n=declined", http.StatusSeeOther)

	case "accept":
		// The handle can still change until the first ether, so the invite
		// page offers it; after joining, it names the person's folder.
		if handle := strings.TrimSpace(strings.TrimPrefix(r.FormValue("handle"), "@")); handle != "" && handle != acct.Handle {
			if err := h.ethers.SetHandle(r.Context(), acct.ID, handle); err != nil {
				h.renderInvite(w, r, acct, userMessage(err))
				return
			}
		}
		e, err := h.ethers.JoinWithCode(r.Context(), a, code)
		switch {
		case errors.Is(err, ether.ErrNotFound):
			h.renderInvite(w, r, acct, "")
		case errors.Is(err, ether.ErrExists) || errors.Is(err, ether.ErrLimit):
			h.renderInvite(w, r, acct, userMessage(err))
		case err != nil:
			h.fail(w, r, acct, err)
		default:
			http.Redirect(w, r, etherURL(e.ID)+"?n=joined", http.StatusSeeOther)
		}

	default:
		h.fail(w, r, acct, fmt.Errorf("%w: choose accept or decline", ether.ErrInvalid))
	}
}

// overviewError shows the overview again with a message, for the forms on it.
func (h *Handler) overviewError(w http.ResponseWriter, r *http.Request, acct *ether.Account, msg string) {
	v, err := h.overviewView(r, acct)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	v.Error = msg
	h.render(w, http.StatusBadRequest, "overview", v)
}

func (h *Handler) inviteSend(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	id := r.PathValue("id")
	emails, err := h.checkInvitees(r.Context(), acct, []string{r.FormValue("email")})
	if err == nil && len(emails) == 0 {
		err = errors.New("enter the email address to invite")
	}
	if err != nil {
		v, verr := h.overviewView(r, acct)
		if verr != nil {
			h.fail(w, r, acct, verr)
			return
		}
		v.Error = userMessage(err)
		h.offerAskAdmin(r, v, err, etherURL(id))
		h.render(w, http.StatusBadRequest, "overview", v)
		return
	}
	sent, err := h.sendInvite(r.Context(), acct, id, emails[0])
	if errors.Is(err, ether.ErrExists) || errors.Is(err, ether.ErrLimit) || errors.Is(err, ether.ErrNotAllowlisted) {
		h.overviewError(w, r, acct, userMessage(err))
		return
	}
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	n := "invited"
	if !sent {
		n = "unsent"
	}
	http.Redirect(w, r, etherURL(id)+"?n="+n, http.StatusSeeOther)
}

func (h *Handler) inviteRevoke(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	id := r.PathValue("id")
	if err := h.ethers.RevokeInvite(r.Context(), ether.Actor{AccountID: acct.ID}, id, r.PathValue("invite")); err != nil {
		h.fail(w, r, acct, err)
		return
	}
	http.Redirect(w, r, etherURL(id)+"?n=revoked", http.StatusSeeOther)
}

func (h *Handler) memberRemove(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	id := r.PathValue("id")
	if err := h.ethers.RemoveMember(r.Context(), ether.Actor{AccountID: acct.ID}, id, r.PathValue("handle")); err != nil {
		h.fail(w, r, acct, err)
		return
	}
	http.Redirect(w, r, etherURL(id)+"?n=removed", http.StatusSeeOther)
}

// mailPreviewIndex and mailPreview show every email with sample data, so the
// templates can be reviewed in a browser. Development only (Config.MailPreviews).
func (h *Handler) mailPreviewIndex(w http.ResponseWriter, r *http.Request) {
	previews, err := mail.Previews(h.baseURL)
	if err != nil {
		h.fail(w, r, nil, err)
		return
	}
	names := make([]string, 0, len(previews))
	for name := range previews {
		names = append(names, name)
	}
	sort.Strings(names)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, "<!doctype html><title>Email previews</title><h1>Email previews</h1><ul>")
	for _, name := range names {
		fmt.Fprintf(w, `<li><a href="/dev/mail/%s">%s</a></li>`, html.EscapeString(name), html.EscapeString(name))
	}
	fmt.Fprint(w, "</ul>")
}

func (h *Handler) mailPreview(w http.ResponseWriter, r *http.Request) {
	previews, err := mail.Previews(h.baseURL)
	if err != nil {
		h.fail(w, r, nil, err)
		return
	}
	name := r.PathValue("name")
	body, ok := previews[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(name, ".html") {
		// Emails style everything inline, which the site's CSP forbids.
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	fmt.Fprint(w, body)
}
