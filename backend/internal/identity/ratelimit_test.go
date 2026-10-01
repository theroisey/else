package identity

import (
	"fmt"
	"testing"
	"time"
)

func TestLoginLimiterBoundsAttemptsAndStorage(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newLoginLimiter()
	limiter.now = func() time.Time { return now }
	for attempt := 0; attempt < loginLimit; attempt++ {
		if !limiter.allow("127.0.0.1", "person@example.com") {
			t.Fatal("attempt blocked early")
		}
	}
	if limiter.allow("127.0.0.1", "person@example.com") {
		t.Fatal("limit exceeded")
	}
	if !limiter.allow("127.0.0.2", "person@example.com") || !limiter.allow("127.0.0.1", "other@example.com") {
		t.Fatal("independent bucket blocked")
	}
	now = now.Add(loginWindow)
	if !limiter.allow("127.0.0.1", "person@example.com") {
		t.Fatal("expired window did not reset")
	}
	limiter.buckets = make(map[[32]byte]loginBucket)
	for index := 0; index < maxLoginBuckets; index++ {
		if !limiter.allow(fmt.Sprintf("192.0.2.%d", index), fmt.Sprintf("%d@example.com", index)) {
			t.Fatal("bucket capacity blocked early")
		}
	}
	if limiter.allow("198.51.100.1", "overflow@example.com") || len(limiter.buckets) != maxLoginBuckets {
		t.Fatal("bounded capacity was not enforced")
	}
}
