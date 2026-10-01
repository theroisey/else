package identity

import (
	"crypto/sha256"
	"sync"
	"time"
)

const (
	loginLimit      = 5
	loginWindow     = 15 * time.Minute
	maxLoginBuckets = 10000
)

type loginBucket struct {
	started time.Time
	count   int
}
type loginLimiter struct {
	mu      sync.Mutex
	buckets map[[32]byte]loginBucket
	now     func() time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{buckets: make(map[[32]byte]loginBucket), now: time.Now}
}

func (l *loginLimiter) allow(peer, email string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	key := sha256.Sum256([]byte(peer + "\x00" + email))
	bucket, ok := l.buckets[key]
	if ok && now.Sub(bucket.started) < loginWindow {
		if bucket.count >= loginLimit {
			return false
		}
		bucket.count++
		l.buckets[key] = bucket
		return true
	}
	if len(l.buckets) >= maxLoginBuckets {
		for existing, candidate := range l.buckets {
			if now.Sub(candidate.started) >= loginWindow {
				delete(l.buckets, existing)
			}
		}
		if len(l.buckets) >= maxLoginBuckets {
			return false
		}
	}
	l.buckets[key] = loginBucket{started: now, count: 1}
	return true
}
