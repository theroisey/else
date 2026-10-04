package httpapi

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

//go:embed browser-headers.json
var browserHeaderJSON []byte

var browserHeaders = func() map[string]string {
	var headers map[string]string
	if err := json.Unmarshal(browserHeaderJSON, &headers); err != nil {
		panic("invalid compiled browser policy")
	}
	return headers
}()

func browserPolicy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for name, value := range browserHeaders {
			w.Header().Set(name, value)
		}
		next.ServeHTTP(w, r)
	})
}

type frontendAsset struct {
	content   []byte
	mediaType string
	etag      string
}

// Snapshot only the immutable built artifact at startup, never serve arbitrary
// filesystem paths. os.Root confines reads even if the input changes during load.
// Bounds cap per-replica memory, and rejecting unknown files prevents publishing
// source maps, credentials or directory contents by accident.
func loadFrontend(directory string) (http.Handler, error) {
	if directory == "" {
		return nil, nil
	}
	failed := fmt.Errorf("FRONTEND_DIRECTORY must contain a valid bounded frontend build")
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, failed
	}
	defer root.Close()
	assets := make(map[string]frontendAsset)
	var total int64
	err = fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return failed
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() || len(assets) >= 1000 {
			return failed
		}
		mediaType := ""
		switch {
		case name == "index.html":
			mediaType = "text/html; charset=utf-8"
		case strings.HasPrefix(name, "assets/") && path.Ext(name) == ".js":
			mediaType = "text/javascript; charset=utf-8"
		case strings.HasPrefix(name, "assets/") && path.Ext(name) == ".css":
			mediaType = "text/css; charset=utf-8"
		case strings.HasPrefix(name, "assets/") && path.Ext(name) == ".woff2":
			mediaType = "font/woff2"
		case strings.HasPrefix(name, "assets/") && path.Ext(name) == ".woff":
			mediaType = "font/woff"
		case strings.HasPrefix(name, "assets/") && path.Ext(name) == ".ttf":
			mediaType = "font/ttf"
		default:
			return failed
		}
		info, err := entry.Info()
		if err != nil || info.Size() <= 0 || info.Size() > 10<<20 || total+info.Size() > 64<<20 {
			return failed
		}
		file, err := root.Open(name)
		if err != nil {
			return failed
		}
		content, err := io.ReadAll(io.LimitReader(file, (10<<20)+1))
		closeErr := file.Close()
		if err != nil || closeErr != nil || int64(len(content)) != info.Size() {
			return failed
		}
		total += int64(len(content))
		assets["/"+name] = frontendAsset{content, mediaType, fmt.Sprintf("\"%x\"", sha256.Sum256(content))}
		return nil
	})
	index, exists := assets["/index.html"]
	if err != nil || !exists || len(assets) < 2 || len(index.content) > 64<<10 {
		return nil, failed
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return
		}
		requestPath := r.URL.Path
		if r.URL.RawPath != "" || strings.Contains(requestPath, "\\") || strings.Contains(requestPath, "//") || path.Clean(requestPath) != requestPath {
			writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
			return
		}
		asset, found := assets[requestPath]
		if !found && (requestPath == "/" || requestPath == "/login" || requestPath == "/interface" || requestPath == "/app" || strings.HasPrefix(requestPath, "/app/")) {
			asset, found = index, true
		}
		if !found {
			writeError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
			return
		}
		// No immutable alias assumption: avoid stale UI after rollback or upgrade.
		// API/session responses retain their independent no-store policy.
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", asset.mediaType)
		w.Header().Set("ETag", asset.etag)
		http.ServeContent(w, r, path.Base(requestPath), time.Time{}, bytes.NewReader(asset.content))
	}), nil
}
