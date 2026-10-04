package identity

import (
	"context"
	"errors"
)

var ErrPasswordWorkUnavailable = errors.New("password work unavailable")

const passwordWorkSlots = 2

// BoundedPasswords counts actual synchronous CPU work, shared across API
// identity/admin services. Admission is nonblocking; there is no request queue.
type BoundedPasswords struct {
	inner Passwords
	slots chan struct{}
}

func NewBoundedPasswords(inner Passwords) (*BoundedPasswords, error) {
	if inner == nil {
		return nil, ErrInvalidInput
	}
	return &BoundedPasswords{inner: inner, slots: make(chan struct{}, passwordWorkSlots)}, nil
}

func (p *BoundedPasswords) admit(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case p.slots <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-p.slots
			return err
		}
		return nil
	default:
		return ErrPasswordWorkUnavailable
	}
}

func (p *BoundedPasswords) Hash(password string) (string, error) {
	return p.HashContext(context.Background(), password)
}

func (p *BoundedPasswords) Verify(encoded, password string) bool {
	valid, err := p.VerifyContext(context.Background(), encoded, password)
	return err == nil && valid
}

func (p *BoundedPasswords) HashContext(ctx context.Context, password string) (string, error) {
	if err := p.admit(ctx); err != nil {
		return "", err
	}
	defer func() { <-p.slots }() // Panic/cancellation must not release live work early.
	hash, err := p.inner.Hash(password)
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	return hash, err
}

func (p *BoundedPasswords) VerifyContext(ctx context.Context, encoded, password string) (bool, error) {
	if err := p.admit(ctx); err != nil {
		return false, err
	}
	defer func() { <-p.slots }()
	valid := p.inner.Verify(encoded, password)
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	return valid, nil
}

type contextPasswords interface {
	HashContext(context.Context, string) (string, error)
	VerifyContext(context.Context, string, string) (bool, error)
}

// HashPassword retains compatibility with trusted existing Passwords/CLI tests.
// Actual API callers use the shared context-aware bounded implementation.
func HashPassword(ctx context.Context, p Passwords, password string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if bounded, ok := p.(contextPasswords); ok {
		return bounded.HashContext(ctx, password)
	}
	hash, err := p.Hash(password)
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	return hash, err
}

func verifyPassword(ctx context.Context, p Passwords, encoded, password string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if bounded, ok := p.(contextPasswords); ok {
		return bounded.VerifyContext(ctx, encoded, password)
	}
	valid := p.Verify(encoded, password)
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	return valid, nil
}
