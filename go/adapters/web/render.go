package web

import (
	"bytes"
	"html/template"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

// newMarkdown returns a renderer for agent-written markdown. Raw HTML is
// never rendered (goldmark's default), dangerous URL schemes are dropped,
// and external links get rel="noopener noreferrer nofollow" with the full
// URL shown beside them. The page's Content-Security-Policy blocks images
// from other origins, which stops the markdown-image exfiltration trick.
func newMarkdown() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithRendererOptions(
			renderer.WithNodeRenderers(util.Prioritized(linkRenderer{}, 100)),
		),
	)
}

func renderMarkdown(md goldmark.Markdown, src []byte) (template.HTML, error) {
	var buf bytes.Buffer
	if err := md.Convert(src, &buf); err != nil {
		return "", err
	}
	// Safe: goldmark escapes text and omits raw HTML.
	return template.HTML(buf.String()), nil
}

type linkRenderer struct{}

func (linkRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindLink, renderLink)
	reg.Register(ast.KindAutoLink, renderAutoLink)
}

func isExternal(url []byte) bool {
	l := bytes.ToLower(url)
	return bytes.HasPrefix(l, []byte("http://")) || bytes.HasPrefix(l, []byte("https://")) ||
		bytes.HasPrefix(l, []byte("//")) || bytes.HasPrefix(l, []byte("mailto:"))
}

const externalRel = ` rel="noopener noreferrer nofollow"`

func renderLink(w util.BufWriter, _ []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*ast.Link)
	external := isExternal(n.Destination)
	if entering {
		w.WriteString(`<a href="`)
		if !html.IsDangerousURL(n.Destination) {
			w.Write(util.EscapeHTML(util.URLEscape(n.Destination, true)))
		}
		w.WriteByte('"')
		if external {
			w.WriteString(externalRel)
		}
		if n.Title != nil {
			w.WriteString(` title="`)
			w.Write(util.EscapeHTML(n.Title))
			w.WriteByte('"')
		}
		w.WriteByte('>')
		return ast.WalkContinue, nil
	}
	w.WriteString("</a>")
	if external {
		w.WriteString(` <span class="url">(`)
		w.Write(util.EscapeHTML(n.Destination))
		w.WriteString(")</span>")
	}
	return ast.WalkContinue, nil
}

func renderAutoLink(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*ast.AutoLink)
	url := util.URLEscape(n.URL(source), false)
	if n.AutoLinkType == ast.AutoLinkEmail && !bytes.HasPrefix(bytes.ToLower(url), []byte("mailto:")) {
		url = append([]byte("mailto:"), url...)
	}
	w.WriteString(`<a href="`)
	if !html.IsDangerousURL(url) {
		w.Write(util.EscapeHTML(url))
	}
	w.WriteString(`"` + externalRel + `>`)
	w.Write(util.EscapeHTML(n.Label(source)))
	w.WriteString("</a>")
	return ast.WalkContinue, nil
}
