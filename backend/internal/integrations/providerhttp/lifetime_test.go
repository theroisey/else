package providerhttp

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"
)

func TestCanceledDNSHoldsAdmissionUntilStartedLookupReturns(t *testing.T) {
	gate := NewAdmission()
	entered := make(chan struct{}, 2)
	canceled := make(chan struct{}, 2)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	client, err := newClient("https://shop.example.com", gate, lookup(func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
		entered <- struct{}{}
		<-ctx.Done()
		canceled <- struct{}{}
		// Deliberately delay the injected resolver's cleanup acknowledgement.
		<-release
		return nil, ctx.Err()
	}), func(context.Context, string, string) (net.Conn, error) {
		t.Error("canceled lookup reached dial")
		return nil, errors.New("synthetic dial failure")
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan error, 2)
	for range 2 {
		go func() { _, err := client.Do(ctx, "GET", "/orders", nil, nil, "", ""); results <- err }()
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for range 2 {
		select {
		case <-entered:
		case <-deadline.C:
			t.Fatal("DNS did not start")
		}
	}
	cancel()
	for range 2 {
		select {
		case <-canceled:
		case <-deadline.C:
			t.Fatal("request cancellation did not reach DNS")
		}
	}
	if len(gate.slots) != 2 {
		t.Fatal("cancellation released slots while DNS still running")
	}
	if body, err := client.Do(context.Background(), "GET", "/orders", nil, nil, "", ""); body != nil || err != ErrBusy {
		t.Fatal("canceled DNS admitted new work before cleanup")
	}
	once.Do(func() { close(release) })
	for range 2 {
		select {
		case err := <-results:
			if err != ErrUnavailable {
				t.Fatal("canceled DNS returned success")
			}
		case <-deadline.C:
			t.Fatal("DNS cleanup did not release request")
		}
	}
	if len(gate.slots) != 0 {
		t.Fatal("DNS cleanup retained slots")
	}
}

func TestTLSHandshakeInheritsRequestCancellationAndClosesConnection(t *testing.T) {
	gate := NewAdmission()
	peer := make(chan net.Conn, 1)
	client, err := newClient("https://shop.example.com", gate, lookup(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}), func(context.Context, string, string) (net.Conn, error) {
		local, remote := net.Pipe()
		peer <- remote
		return local, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan error, 1)
	go func() { _, err := client.Do(ctx, "GET", "/orders", nil, nil, "", ""); results <- err }()
	var remote net.Conn
	select {
	case remote = <-peer:
	case <-time.After(3 * time.Second):
		t.Fatal("TLS test dial did not start")
	}
	defer remote.Close()
	cancel()
	select {
	case err := <-results:
		if err != ErrUnavailable || len(gate.slots) != 0 {
			t.Fatal("TLS cancellation lost error or capacity")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("TLS cancellation did not finish")
	}
	if err := remote.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		return
	} // Closed pipe is already proof.
	if _, err := remote.Write([]byte("synthetic")); err == nil {
		t.Fatal("canceled TLS connection remained writable")
	}
}
