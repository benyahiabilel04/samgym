// tsfunnel: يشغّل Tailscale (tsnet) داخل التطبيق ويفتح Funnel على رابط https ثابت، ويمرّر الطلبات إلى خادم SAM GYM المحلي.
// التحكم عبر HTTP محلي:  GET /status   POST /retry
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "golang.org/x/crypto/x509roots/fallback" // شهادات الجذر مضمّنة (أندرويد لا يملك /etc/ssl)
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

type status struct {
	State string `json:"state"` // starting | login | funnel_error | ready
	Link  string `json:"link,omitempty"`
	URL   string `json:"url,omitempty"`
	Text  string `json:"text,omitempty"`
}

var (
	mu       sync.Mutex
	st       = status{State: "starting"}
	funnelOn bool
	urlRe    = regexp.MustCompile(`https://[^\s"')]+`)
)

func set(s status) { mu.Lock(); st = s; mu.Unlock() }
func get() status  { mu.Lock(); defer mu.Unlock(); return st }

func main() {
	dir := flag.String("state", "ts-state", "مجلد حالة Tailscale")
	target := flag.String("target", "127.0.0.1:3000", "عنوان خادم SAM GYM")
	control := flag.String("control", "127.0.0.1:3001", "عنوان واجهة التحكم")
	host := flag.String("hostname", "samgym", "اسم الجهاز في Tailscale")
	flag.Parse()

	// أندرويد لا يملك resolv.conf: نحدد خوادم DNS صراحةً
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		d := net.Dialer{Timeout: 4 * time.Second}
		for _, s := range []string{"1.1.1.1:53", "8.8.8.8:53"} {
			if c, err := d.DialContext(ctx, "udp", s); err == nil {
				return c, nil
			}
		}
		return d.DialContext(ctx, "udp", "1.1.1.1:53")
	}}

	srv := &tsnet.Server{Hostname: *host, Dir: *dir, UserLogf: log.Printf, Logf: func(string, ...any) {}}
	if err := srv.Start(); err != nil {
		set(status{State: "funnel_error", Text: "Tailscale: " + err.Error()})
		log.Printf("start: %v", err)
	}

	// واجهة التحكم
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(get())
	})
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: *target})
	var tryFunnel func()
	mux.HandleFunc("/retry", func(w http.ResponseWriter, r *http.Request) {
		go tryFunnel()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":1}`))
	})
	go func() { log.Fatal(http.ListenAndServe(*control, mux)) }()

	lc, err := srv.LocalClient()
	if err != nil {
		set(status{State: "funnel_error", Text: err.Error()})
		select {}
	}

	tryFunnel = func() {
		mu.Lock()
		if funnelOn {
			mu.Unlock()
			return
		}
		mu.Unlock()
		stt, err := lc.StatusWithoutPeers(context.Background())
		if err != nil || stt.Self == nil {
			return
		}
		name := strings.TrimSuffix(stt.Self.DNSName, ".")
		ln, err := srv.ListenFunnel("tcp", ":443")
		if err != nil {
			link := urlRe.FindString(err.Error())
			set(status{State: "funnel_error", Link: link, Text: err.Error()})
			log.Printf("funnel: %v", err)
			return
		}
		mu.Lock()
		funnelOn = true
		mu.Unlock()
		set(status{State: "ready", URL: "https://" + name})
		log.Printf("funnel ready: https://%s", name)
		go func() {
			err := http.Serve(ln, proxy)
			mu.Lock()
			funnelOn = false
			mu.Unlock()
			log.Printf("funnel stopped: %v", err)
		}()
	}

	// مراقبة حالة Tailscale
	for {
		w, err := lc.WatchIPNBus(context.Background(), ipn.NotifyInitialState|ipn.NotifyInitialPrefs)
		if err != nil {
			time.Sleep(3 * time.Second)
			continue
		}
		for {
			n, err := w.Next()
			if err != nil {
				break
			}
			if n.BrowseToURL != nil {
				set(status{State: "login", Link: *n.BrowseToURL})
			}
			if n.State != nil {
				switch *n.State {
				case ipn.NeedsLogin:
					if get().State != "login" {
						set(status{State: "starting"})
					}
					go lc.StartLoginInteractive(context.Background())
				case ipn.Running:
					go tryFunnel()
				}
			}
		}
		w.Close()
		time.Sleep(2 * time.Second)
	}
}
