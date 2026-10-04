package identity

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

type controlledPasswords struct {
	entered chan struct{}
	release chan struct{}
	active  atomic.Int32
	peak    atomic.Int32
	panic   bool
	fail    bool
}

func (p *controlledPasswords) Hash(string) (string, error) {
	if p.panic {
		panic("synthetic private marker")
	}
	n := p.active.Add(1)
	defer p.active.Add(-1)
	for old := p.peak.Load(); n > old; old = p.peak.Load() {
		if p.peak.CompareAndSwap(old, n) {
			break
		}
	}
	if p.entered != nil {
		p.entered <- struct{}{}
		<-p.release
	}
	if p.fail {
		return "", ErrInvalidInput
	}
	return "synthetic hash", nil
}

func (p *controlledPasswords) Verify(_, _ string) bool {
	_, err := p.Hash("")
	return err == nil
}

func TestPasswordWorkAdmissionLifetimeAndCancellation(t *testing.T) {
	inner := &controlledPasswords{entered: make(chan struct{}, 2), release: make(chan struct{})}
	p, err := NewBoundedPasswords(inner)
	if err != nil {
		t.Fatal("bounded password setup failed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	errorsOut := make(chan error, 2)
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := HashPassword(ctx, p, "synthetic password")
			errorsOut <- err
		}()
	}
	for range 2 {
		<-inner.entered
	}
	if _, err := p.HashContext(context.Background(), "another password"); err != ErrPasswordWorkUnavailable {
		t.Error("saturated hash was queued or admitted")
	}
	if _, err := p.VerifyContext(context.Background(), "synthetic hash", "another password"); err != ErrPasswordWorkUnavailable {
		t.Error("hash and verification did not share the same bound")
	}
	cancel()
	if _, err := p.HashContext(ctx, "another password"); !errors.Is(err, context.Canceled) {
		t.Error("already canceled work was admitted")
	}
	if _, err := p.HashContext(context.Background(), "another password"); err != ErrPasswordWorkUnavailable {
		t.Error("cancellation released CPU work before it stopped")
	}
	close(inner.release)
	workers.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if !errors.Is(err, context.Canceled) {
			t.Error("completed canceled hash result remained usable")
		}
	}
	if inner.peak.Load() != 2 || inner.active.Load() != 0 || len(p.slots) != 0 {
		t.Fatal("password work admission/accounting differs")
	}
	if valid, err := verifyPassword(context.Background(), p, "synthetic hash", "synthetic password"); err != nil || !valid {
		t.Fatal("password work did not recover")
	}
}

func TestPasswordWorkErrorAndPanicRelease(t *testing.T) {
	inner := &controlledPasswords{panic: true}
	p, _ := NewBoundedPasswords(inner)
	func() {
		defer func() {
			if recover() == nil {
				t.Error("inner panic did not propagate to caller")
			}
		}()
		_, _ = p.Hash("synthetic password")
	}()
	inner.panic, inner.fail = false, true
	if _, err := p.Hash("synthetic password"); err != ErrInvalidInput || len(p.slots) != 0 {
		t.Fatal("error/panic leaked a password slot")
	}
	inner.fail = false
	if _, err := p.Hash("synthetic password"); err != nil {
		t.Fatal("password work did not recover after panic/error")
	}
}

func TestBoundedActualArgonCompatibility(t *testing.T) {
	p, _ := NewBoundedPasswords(ArgonPasswords{})
	hash, err := HashPassword(context.Background(), p, "correct horse battery staple")
	if err != nil || !p.Verify(hash, "correct horse battery staple") || p.Verify(hash, "incorrect password") || !(ArgonPasswords{}).Verify(hash, "correct horse battery staple") {
		t.Fatal("existing Argon policy/verification changed")
	}
}
