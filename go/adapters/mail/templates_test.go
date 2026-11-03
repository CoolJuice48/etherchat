package mail

import (
	"strings"
	"testing"
	"time"
)

func TestSignInCodeEmail(t *testing.T) {
	m, err := SignInCode("a@example.com", "359569")
	if err != nil {
		t.Fatal(err)
	}
	if m.To != "a@example.com" || m.Subject != "Your Etherchat sign-in code" ||
		!strings.Contains(m.Text, "    359569\n") || !strings.Contains(m.HTML, "359 569") {
		t.Fatalf("sign-in email: %+v", m)
	}
	// The code stays out of the subject and preview line, which phones show
	// on the lock screen.
	if strings.Contains(m.Subject, "359") || strings.Contains(m.HTML[:strings.Index(m.HTML, "sign-in code</p>")], "359") {
		t.Fatal("code appears before the body")
	}
}

func TestInviteEmail(t *testing.T) {
	m, err := Invite(InviteDetails{
		To: "sam@example.com", FromEmail: "you@example.com", EtherName: `<b>Notes</b> & "drafts"`,
		Link: InviteLink("https://etherchat.example/", "ABCD-EFGH-IJKL-MNOP"), ExpiresAt: time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	link := "https://etherchat.example/invite/ABCD-EFGH-IJKL-MNOP"
	if !strings.Contains(m.Text, `you@example.com invited you to their ether [<b>Notes</b> & "drafts"].`) ||
		!strings.Contains(m.Text, link) || !strings.Contains(m.Text, "until October 16, 2026") {
		t.Fatalf("text part:\n%s", m.Text)
	}
	// Names are escaped in the HTML part; the link appears as the button and as text.
	if strings.Contains(m.HTML, "<b>Notes") || !strings.Contains(m.HTML, "&lt;b&gt;Notes&lt;/b&gt; &amp; &#34;drafts&#34;") ||
		strings.Count(m.HTML, link) != 2 {
		t.Fatalf("html part:\n%s", m.HTML)
	}
}

func TestPreviews(t *testing.T) {
	p, err := Previews("http://127.0.0.1:18080")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"signin.html", "signin.txt", "invite.html", "invite.txt"} {
		if p[name] == "" {
			t.Fatalf("no preview for %s", name)
		}
	}
}
