// Go capture (printer captures, FAKE values only). Reads {c, v} JSON lines on stdin; writes {p, c, hex (UTF-8)}.
package main

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"unicode"
)

type In struct {
	C string `json:"c"`
	V string `json:"v"`
}
type S struct{ S string }

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	meta, _ := json.Marshal(map[string]string{"p": "meta", "c": "-", "go": runtime.Version(), "unicode": unicode.Version})
	w.Write(meta)
	w.WriteString("\n")
	for sc.Scan() {
		var in In
		if err := json.Unmarshal(sc.Bytes(), &in); err != nil {
			fmt.Fprintln(os.Stderr, "input error:", err)
			continue
		}
		v := in.V
		emit := func(p, out string) {
			b, _ := json.Marshal(map[string]string{"p": p, "c": in.C, "hex": hex.EncodeToString([]byte(out))})
			w.Write(b)
			w.WriteString("\n")
		}
		b, _ := json.Marshal(v)
		emit("go.json.Marshal", string(b))
		bs, _ := json.Marshal(S{v})
		emit("go.json.Marshal_struct", string(bs))
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.Encode(v)
		emit("go.json.Encoder_noHTML", strings.TrimSuffix(buf.String(), "\n"))
		emit("go.fmt.q", fmt.Sprintf("%q", v))
		emit("go.fmt.sharpv", fmt.Sprintf("%#v", v))
		emit("go.fmt.sharpv_struct", fmt.Sprintf("%#v", S{v}))
		emit("go.fmt.plusq", fmt.Sprintf("%+q", v))
		emit("go.strconv.Quote", strconv.Quote(v))
		emit("go.url.UserPassword", url.UserPassword("u", v).String())
		u := url.URL{Scheme: "https", User: url.UserPassword("u", v), Host: "h.example"}
		emit("go.url.URL_userpass", u.String())
		emit("go.url.PathEscape", url.PathEscape(v))
		emit("go.url.QueryEscape", url.QueryEscape(v))
		emit("go.fmt.X_bytes", fmt.Sprintf("%X", []byte(v)))
		emit("go.fmt.X_string", fmt.Sprintf("%X", v))
		emit("go.fmt.x_bytes", fmt.Sprintf("%x", []byte(v)))
		emit("go.html.EscapeString", html.EscapeString(v))
	}
}
