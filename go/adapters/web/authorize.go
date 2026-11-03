package web

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/core/ether"
)

// The browser half of OAuth authorization: the person signs in with an email
// code if needed, then sees a consent page every time an app connects.
// Consent isn't remembered, which keeps every redirect back to the app
// behind a form on a page whose CSP allows exactly that app's origin.

type consentView struct {
	ClientName   string
	RedirectHost string
	ClientURL    string // set for apps identified by a metadata-document URL
	Params       url.Values
}

func (h *Handler) authorizeFail(w http.ResponseWriter, r *http.Request, acct *ether.Account, err error) {
	var re *oauth.RequestError
	if errors.As(err, &re) {
		h.render(w, http.StatusBadRequest, "error", &view{Account: acct, Title: "Can't connect this app", Error: re.Msg})
		return
	}
	h.fail(w, r, acct, err)
}

func (h *Handler) authorizeGet(w http.ResponseWriter, r *http.Request) {
	req, err := h.oauth.ParseAuthorize(r.Context(), r.URL.Query())
	acct := h.currentAccount(r)
	if err != nil {
		h.authorizeFail(w, r, acct, err)
		return
	}
	if acct == nil {
		http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusSeeOther)
		return
	}
	h.renderConsent(w, acct, req)
}

func (h *Handler) renderConsent(w http.ResponseWriter, acct *ether.Account, req *oauth.AuthRequest) {
	cv := &consentView{ClientName: req.Client.Name, RedirectHost: req.RedirectHost(), Params: req.Params}
	if req.Client.Kind == "cimd" {
		cv.ClientURL = req.Client.ID
	}
	// Browsers apply form-action to the redirect that follows a form post,
	// so this page allows its own origin plus the app's redirect origin.
	formAction := "'self'"
	if o := cspSource(req.RedirectOrigin()); o != "" {
		formAction += " " + o
	}
	w.Header().Set("Content-Security-Policy", strings.Replace(pageCSP, "form-action 'self'", "form-action "+formAction, 1))
	h.render(w, http.StatusOK, "consent", &view{Title: "Connect " + req.Client.Name, Account: acct, Consent: cv})
}

// cspSource returns origin if it's safe to put in a CSP header, else "".
func cspSource(origin string) string {
	for _, r := range origin {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(":/.-+[]", r)) {
			return ""
		}
	}
	return origin
}

func (h *Handler) authorizePost(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		h.fail(w, r, nil, errors.Join(ether.ErrInvalid, err))
		return
	}
	acct := h.currentAccount(r)
	params := url.Values{}
	for k, vs := range r.PostForm {
		if k != "decision" {
			params[k] = vs
		}
	}
	req, err := h.oauth.ParseAuthorize(r.Context(), params)
	if err != nil {
		h.authorizeFail(w, r, acct, err)
		return
	}
	if acct == nil {
		http.Redirect(w, r, "/login?next="+url.QueryEscape("/oauth/authorize?"+params.Encode()), http.StatusSeeOther)
		return
	}
	if r.PostForm.Get("decision") != "allow" {
		http.Redirect(w, r, h.oauth.DenyURL(req), http.StatusSeeOther)
		return
	}
	to, err := h.oauth.IssueCode(r.Context(), req, acct.ID)
	if err != nil {
		h.fail(w, r, acct, err)
		return
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
}
