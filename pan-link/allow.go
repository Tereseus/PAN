package link

import (
	"fmt"
	"net/http"
	"path"
	"strings"
)

// A device can be limited to a few kinds of request to PAN: its Allow list. A rule is
// "METHOD /path" for that exact path, or "METHOD /path/*" for everything under /path/;
// METHOD "*" is any method. An empty list means no limit, which is how the owner's own
// phone and computers are paired.
//
// pan-link checks every request a limited device sends, WebSocket upgrades included,
// before it reaches PAN, and answers 403 itself for the rest. It is for computers that
// someone else also controls, such as a work computer whose company has admin rights on
// it: it can send alerts and messages to PAN, but it can't read PAN or change it.
// The rules come from PAN (routes/link.js), which knows its own paths.

const (
	maxAllowRules = 32
	maxRuleLen    = 200
)

var ruleMethods = map[string]bool{"*": true, "GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}

// CheckAllow says what is wrong with an Allow list, or returns nil.
func CheckAllow(rules []string) error {
	if len(rules) > maxAllowRules {
		return fmt.Errorf("at most %d allow rules", maxAllowRules)
	}
	for _, r := range rules {
		if len(r) > maxRuleLen {
			return fmt.Errorf("allow rule too long: %.40q", r)
		}
		m, p, ok := strings.Cut(r, " ")
		if !ok || !ruleMethods[m] {
			return fmt.Errorf("allow rule %q: want \"METHOD /path\" or \"METHOD /path/*\"", r)
		}
		exact := p
		if prefix, isPrefix := strings.CutSuffix(p, "/*"); isPrefix {
			exact = prefix
		}
		if !strings.HasPrefix(exact, "/") || strings.ContainsAny(exact, " *?#%\\") || path.Clean(exact) != exact {
			return fmt.Errorf("allow rule %q: the path must be clean, start with / and hold no * ? # %% or \\ (a prefix ends in /*)", r)
		}
	}
	return nil
}

// allows says whether a device with these rules may send r. No rules: anything. A path
// that isn't already clean (dot segments, double slashes) or that carries percent escapes
// is refused, so a request can't name an allowed path and reach another.
func allows(rules []string, r *http.Request) bool {
	if len(rules) == 0 {
		return true
	}
	p := r.URL.Path
	if p == "" || r.URL.RawPath != "" {
		return false
	}
	clean := path.Clean(p)
	if strings.HasSuffix(p, "/") && clean != "/" {
		clean += "/" // a trailing slash is fine; it only matters to exact rules
	}
	if clean != p {
		return false
	}
	for _, rule := range rules {
		m, rp, _ := strings.Cut(rule, " ")
		if m != "*" && m != r.Method {
			continue
		}
		if prefix, isPrefix := strings.CutSuffix(rp, "*"); isPrefix {
			if strings.HasPrefix(p, prefix) {
				return true
			}
		} else if p == rp {
			return true
		}
	}
	return false
}
