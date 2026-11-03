package web

import (
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Page sizes: Comms shows 5 requests or messages a page, Shared files 10 files.
const (
	commsPageSize  = 5
	sharedPageSize = 10
)

// listFilter is one list's filters and pages: who (the person asked, the
// author, or a file's writer), a tag (messages' intent), a folder (shared
// files), a time range, and a text search. Each list has its own query
// parameters (r_* requests, m_* messages, f_* files), so filtering or paging
// one leaves the others as they were.
type listFilter struct {
	prefix string // "r", "m" or "f"
	anchor string // the list's heading, so links land on it
	size   int    // items per page

	Who, Tag, In, Q, From, To string // as typed, for the form
	Err                       string // why the time range couldn't be used

	Page, Pages, Total  int
	Newer, Older, Clear string     // links; "" when there's no such page, or nothing to clear
	Keep                []keyValue // the other list's parameters, carried as hidden fields

	from, until time.Time
	q           string // Q, lowercased
}

type keyValue struct{ Key, Value string }

func (f *listFilter) param(name string) string { return f.prefix + "_" + name }

// parseDatetime reads a datetime-local value in loc. step is how much the
// value covers (a minute, or a second when seconds were given), so an end
// time can include all of it.
func parseDatetime(s string, loc *time.Location) (t time.Time, step time.Duration, ok bool) {
	for i, layout := range datetimeLayouts {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, []time.Duration{time.Minute, time.Second}[i], true
		}
	}
	return time.Time{}, 0, false
}

func parseListFilter(q url.Values, prefix, anchor string, size int, loc *time.Location) listFilter {
	f := listFilter{prefix: prefix, anchor: anchor, size: size, Page: 1}
	f.Who = strings.TrimPrefix(strings.TrimSpace(q.Get(f.param("who"))), "@")
	f.Tag = strings.TrimSpace(q.Get(f.param("tag")))
	f.In = strings.Trim(strings.TrimSpace(q.Get(f.param("in"))), "/")
	f.Q = strings.TrimSpace(q.Get(f.param("q")))
	f.From, f.To = q.Get(f.param("from")), q.Get(f.param("to"))
	f.q = strings.ToLower(f.Q)
	if f.From != "" {
		if t, _, ok := parseDatetime(f.From, loc); ok {
			f.from = t
		} else {
			f.Err = "Enter the start as a date and time, like 2026-10-12 14:00."
		}
	}
	if f.To != "" {
		if t, step, ok := parseDatetime(f.To, loc); ok {
			f.until = t.Add(step)
		} else {
			f.Err = "Enter the end as a date and time, like 2026-10-12 18:00."
		}
	}
	if !f.from.IsZero() && !f.until.IsZero() && !f.from.Before(f.until) {
		f.Err = "The start is after the end."
	}
	if f.Err != "" {
		f.from, f.until = time.Time{}, time.Time{}
	}
	if n, err := strconv.Atoi(q.Get(f.param("page"))); err == nil && n > 1 {
		f.Page = n
	}
	for key, values := range q {
		if key != "n" && !strings.HasPrefix(key, prefix+"_") {
			for _, v := range values {
				f.Keep = append(f.Keep, keyValue{key, v})
			}
		}
	}
	return f
}

// active reports whether any filter is set.
func (f *listFilter) active() bool {
	return f.Who != "" || f.Tag != "" || f.In != "" || f.Q != "" || f.From != "" || f.To != ""
}

// inRange reports whether t is inside the time range.
func (f *listFilter) inRange(t time.Time) bool {
	return (f.from.IsZero() || !t.Before(f.from)) && (f.until.IsZero() || t.Before(f.until))
}

// matches reports whether the search text appears in any of texts.
func (f *listFilter) matches(texts ...string) bool {
	if f.q == "" {
		return true
	}
	for _, s := range texts {
		if strings.Contains(strings.ToLower(s), f.q) {
			return true
		}
	}
	return false
}

// finish works out the pages for total matching items, builds the links
// from the current query q, and returns the slice bounds of this page.
func (f *listFilter) finish(base string, q url.Values, total int) (start, end int) {
	f.Total = total
	f.Pages = max(1, (total+f.size-1)/f.size)
	link := func(change func(url.Values)) string {
		next := url.Values{}
		for k, v := range q {
			if k != "n" {
				next[k] = v
			}
		}
		change(next)
		if len(next) == 0 {
			return base + "#" + f.anchor
		}
		return base + "?" + next.Encode() + "#" + f.anchor
	}
	page := func(n int) string {
		return link(func(v url.Values) {
			if n > 1 {
				v.Set(f.param("page"), strconv.Itoa(n))
			} else {
				v.Del(f.param("page"))
			}
		})
	}
	if f.Page > 1 {
		f.Newer = page(min(f.Page-1, f.Pages))
	}
	if f.Page < f.Pages {
		f.Older = page(f.Page + 1)
	}
	if f.active() || f.Page > 1 {
		f.Clear = link(func(v url.Values) {
			for k := range v {
				if strings.HasPrefix(k, f.prefix+"_") {
					v.Del(k)
				}
			}
		})
	}
	start = min((f.Page-1)*f.size, total)
	return start, min(start+f.size, total)
}
