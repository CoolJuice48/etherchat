package mail

import (
	"bytes"
	"embed"
	htmltemplate "html/template"
	"strconv"
	"strings"
	texttemplate "text/template"
	"time"
)

// Every email has an HTML part in the web view's style and a plain-text part
// with the same words, for clients that don't show HTML.

//go:embed templates/*
var templateFS embed.FS

var (
	htmlTemplates = htmltemplate.Must(htmltemplate.New("").ParseFS(templateFS, "templates/*.html"))
	textTemplates = texttemplate.Must(texttemplate.New("").ParseFS(templateFS, "templates/*.txt"))
)

// email is what the templates receive.
type email struct {
	Subject   string
	Preheader string // the preview line inboxes show after the subject
	Footer    string

	Code        string // sign-in code
	CodeSpaced  string // the same code as "123 456", easier to read
	ExpiresIn   string
	Invite      InviteDetails
	ExpiresDate string
	News        RequestNews
	Allow       AllowRequest
}

// SignInCode is the email with a web sign-in code.
func SignInCode(to, code string) (Message, error) {
	e := email{
		Subject:   "Your Etherchat sign-in code",
		Preheader: "It expires in 10 minutes.",
		Footer:    "Etherchat never asks for this code in a chat, including in a conversation with an AI.",
		Code:      code, CodeSpaced: spaced(code), ExpiresIn: "10 minutes",
	}
	return render(to, "signin", e)
}

// InviteDetails describes one invite email.
type InviteDetails struct {
	To        string
	FromEmail string
	EtherName string
	Link      string // InviteLink(baseURL, code)
	ExpiresAt time.Time
}

// InviteLink is the page where the invited person accepts or declines.
func InviteLink(baseURL, code string) string {
	return strings.TrimRight(baseURL, "/") + "/invite/" + code
}

// Invite is the email that invites someone to an ether.
func Invite(d InviteDetails) (Message, error) {
	e := email{
		Subject:     d.FromEmail + ` invited you to "` + d.EtherName + `" on Etherchat`,
		Preheader:   "Different LLMs, different users, one memory bank.",
		Footer:      "If you weren't expecting this, you can ignore it. Nobody joins an ether without accepting.",
		Invite:      d,
		ExpiresDate: d.ExpiresAt.Format("January 2, 2006"), // in ExpiresAt's own zone: callers pass the site's
	}
	return render(d.To, "invite", e)
}

// RequestNewsItem is one line of a request email. It names people and the
// ether, never the agent's own words: an email from this domain must not
// carry text an agent chose, or a tricked agent could send phishing.
type RequestNewsItem struct {
	Answered  bool   // false: someone's agent asked you something; true: someone answered your agent
	Who       string // handle: whose agent asked, or who answered
	Self      bool   // your own agent asked you
	EtherName string
	Link      string
}

// RequestNews is the hourly-at-most email about requests.
type RequestNews struct {
	To           string
	Items        []RequestNewsItem
	Link         string // the button: the ether when all items share one, else the home page
	SettingsLink string
}

// RequestEmail is the email that tells someone about new requests and answers.
func RequestEmail(n RequestNews) (Message, error) {
	asked, answered := 0, 0
	for _, it := range n.Items {
		if it.Answered {
			answered++
		} else {
			asked++
		}
	}
	var subject string
	switch {
	case asked == 1 && answered == 0 && n.Items[0].Self:
		subject = "Your agent asked you something on Etherchat"
	case asked == 1 && answered == 0:
		subject = "@" + n.Items[0].Who + "'s agent asked you something on Etherchat"
	case asked == 0 && answered == 1:
		subject = "@" + n.Items[0].Who + " answered your agent on Etherchat"
	case answered == 0:
		subject = strconv.Itoa(asked) + " requests are waiting for you on Etherchat"
	case asked == 0:
		subject = strconv.Itoa(answered) + " answers to your agents' requests on Etherchat"
	default:
		subject = "Etherchat: " + plural(asked, "request", "requests") + " for you, " + plural(answered, "answer", "answers") + " for your agents"
	}
	e := email{
		Subject:   subject,
		Preheader: "Answers reach the agents the next time they catch up.",
		Footer:    "You get at most one of these an hour. To stop them, turn them off in your account: " + n.SettingsLink,
		News:      n,
	}
	return render(n.To, "requests", e)
}

// AllowRequest is a member asking the server's admins to allow addresses
// they tried to invite. The addresses were checked as plain email addresses,
// so nothing else typed by the member reaches the email.
type AllowRequest struct {
	To         string // an admin
	FromEmail  string
	FromHandle string
	Emails     []string
	Command    string // how to allow one address, with EMAIL as the placeholder
}

// AllowCommand returns Command for one address.
func (a AllowRequest) AllowCommand(email string) string {
	return strings.ReplaceAll(a.Command, "EMAIL", email)
}

// AllowRequestEmail is the email that asks an admin to allow addresses.
func AllowRequestEmail(a AllowRequest) (Message, error) {
	e := email{
		Subject:   "@" + a.FromHandle + " asked to allow " + plural(len(a.Emails), "address", "addresses") + " on Etherchat",
		Preheader: "Someone wants to invite people who can't be invited yet.",
		Footer:    "You get these because you're an admin of this Etherchat server. Nothing changes until you run the command.",
		Allow:     a,
	}
	return render(a.To, "allow", e)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

func render(to, name string, e email) (Message, error) {
	var text, html bytes.Buffer
	if err := textTemplates.ExecuteTemplate(&text, name+".txt", e); err != nil {
		return Message{}, err
	}
	if err := htmlTemplates.ExecuteTemplate(&html, name+".html", e); err != nil {
		return Message{}, err
	}
	return Message{To: to, Subject: e.Subject, Text: text.String(), HTML: html.String()}, nil
}

func spaced(code string) string {
	if len(code) == 6 {
		return code[:3] + " " + code[3:]
	}
	return code
}

// Previews renders every email with sample data, for reviewing the design.
// The keys are file names like "invite.html".
func Previews(baseURL string) (map[string]string, error) {
	out := map[string]string{}
	signin, err := SignInCode("you@example.com", "359569")
	if err != nil {
		return nil, err
	}
	invite, err := Invite(InviteDetails{
		To: "sam@example.com", FromEmail: "you@example.com", EtherName: "Atlas: research notes",
		Link: InviteLink(baseURL, "ABCD-EFGH-IJKL-MNOP"), ExpiresAt: time.Now().Add(7 * 24 * time.Hour),
	})
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(baseURL, "/")
	news, err := RequestEmail(RequestNews{
		To: "you@example.com", Link: base + "/", SettingsLink: base + "/account",
		Items: []RequestNewsItem{
			{Who: "sam", EtherName: "Atlas: research notes", Link: base + "/e/abc"},
			{Self: true, Who: "you", EtherName: "Atlas: research notes", Link: base + "/e/abc"},
			{Answered: true, Who: "sam", EtherName: "Thesis", Link: base + "/e/abc/comms"},
		},
	})
	if err != nil {
		return nil, err
	}
	allow, err := AllowRequestEmail(AllowRequest{To: "admin@example.com", FromEmail: "you@example.com", FromHandle: "you",
		Emails:  []string{"lee@example.org", "kim@example.com"},
		Command: "sudo -u etherchat etherd admin --config /etc/etherchat/etherd.toml allow --email EMAIL"})
	if err != nil {
		return nil, err
	}
	for name, m := range map[string]Message{"signin": signin, "invite": invite, "requests": news, "allow": allow} {
		out[name+".html"], out[name+".txt"] = m.HTML, "Subject: "+m.Subject+"\n\n"+m.Text
	}
	return out, nil
}
