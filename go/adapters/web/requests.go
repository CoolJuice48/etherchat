package web

import (
	"errors"
	"html/template"
	"net/http"
	"strconv"

	"github.com/CoolJuice48/etherchat/go/core/ether"
)

// Attention requests on the website: the person asked
// answers on the ether's overview, and every member can read them all on
// the Comms tab. Answers are the only thing people write here.

type requestView struct {
	ether.Request
	HTML   template.HTML // the body, rendered like any agent-written markdown
	Others []string      // on the Overview: everyone else the request asked
}

func (h *Handler) requestViews(r *http.Request, acct *ether.Account, etherID string) ([]requestView, error) {
	list, err := h.ethers.ListRequests(r.Context(), ether.Actor{AccountID: acct.ID}, etherID)
	if err != nil {
		return nil, err
	}
	out := make([]requestView, 0, len(list))
	for _, rq := range list {
		body, err := renderMarkdown(h.md, []byte(rq.Body))
		if err != nil {
			return nil, err
		}
		out = append(out, requestView{Request: rq, HTML: body})
	}
	return out, nil
}

func (h *Handler) answerRequest(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	id := r.PathValue("id")
	choice := -1
	if c := r.FormValue("choice"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil {
			h.overviewError(w, r, acct, "Pick one of the choices.")
			return
		}
		choice = n
	}
	_, err := h.ethers.AnswerRequest(r.Context(), ether.Actor{AccountID: acct.ID}, id, r.PathValue("request"), choice, r.FormValue("note"))
	switch {
	case errors.Is(err, ether.ErrInvalid) || errors.Is(err, ether.ErrConflict):
		h.overviewError(w, r, acct, userMessage(err))
	case err != nil:
		h.fail(w, r, acct, err)
	default:
		http.Redirect(w, r, etherURL(id)+"?n=answered", http.StatusSeeOther)
	}
}

// agentName lets a person name their own agent in an ether (agents can
// too, with the name_agent tool).
func (h *Handler) agentName(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	id := r.PathValue("id")
	err := h.ethers.SetAgentName(r.Context(), ether.Actor{AccountID: acct.ID}, id, r.FormValue("name"))
	switch {
	case errors.Is(err, ether.ErrInvalid) || errors.Is(err, ether.ErrExists):
		h.overviewError(w, r, acct, userMessage(err))
	case err != nil:
		h.fail(w, r, acct, err)
	default:
		http.Redirect(w, r, etherURL(id)+"?n=renamed", http.StatusSeeOther)
	}
}

func (h *Handler) accountPage(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	h.render(w, http.StatusOK, "account", &view{Title: "Account", Account: acct, Notice: notice(r)})
}

func (h *Handler) accountEmails(w http.ResponseWriter, r *http.Request, acct *ether.Account) {
	if err := h.ethers.SetRequestEmails(r.Context(), acct.ID, r.FormValue("request_emails") == "on"); err != nil {
		h.fail(w, r, acct, err)
		return
	}
	http.Redirect(w, r, "/account?n=saved", http.StatusSeeOther)
}
