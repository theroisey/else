// Package authorization provides deny-by-default permission checks and
// audited role assignment. Role names are never authorization conditions.
package authorization

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/audit"
)

var (
	ErrInvalidInput = errors.New("invalid authorization input")
	ErrDenied       = errors.New("authorization denied")
)

const (
	InitialAdministratorRoleID = "00000000-0000-4000-8000-000000000001"
	FinanceRoleID              = "00000000-0000-4000-8000-000000000002"
	ViewerRoleID               = "00000000-0000-4000-8000-000000000003"
)

type Permission string

const (
	UsersView          Permission = "users.view"
	UsersManage        Permission = "users.manage"
	RolesView          Permission = "roles.view"
	RolesManage        Permission = "roles.manage"
	AuditView          Permission = "audit.view"
	ReleasesView       Permission = "releases.view"
	ReleasesManage     Permission = "releases.manage"
	ClientsCreate      Permission = "clients.create"
	ClientsView        Permission = "clients.view"
	ClientsUpdate      Permission = "clients.update"
	ClientsArchive     Permission = "clients.archive"
	BillingView        Permission = "billing.view"
	BillingManage      Permission = "billing.manage"
	PricingView        Permission = "pricing.view"
	PricingManage      Permission = "pricing.manage"
	TasksView          Permission = "tasks.view"
	TasksManage        Permission = "tasks.manage"
	TasksCreate        Permission = "tasks.create"
	TasksUpdate        Permission = "tasks.update"
	TasksDelete        Permission = "tasks.delete"
	PlanningView       Permission = "planning.view"
	PlanningCreate     Permission = "planning.create"
	PlanningUpdate     Permission = "planning.update"
	PlanningArchive    Permission = "planning.archive"
	RemindersView      Permission = "reminders.view"
	RemindersCreate    Permission = "reminders.create"
	RemindersUpdate    Permission = "reminders.update"
	AnalyticsView      Permission = "analytics.view"
	IntegrationsManage Permission = "integrations.manage"
)

type Scope string

const (
	Global Scope = "global"
	Client Scope = "client"
)

var permissionScopes = map[Permission]Scope{
	UsersView: Global, UsersManage: Global, RolesView: Global, RolesManage: Global,
	AuditView: Global, ReleasesView: Global, ReleasesManage: Global, ClientsCreate: Global,
	ClientsView: Client, ClientsUpdate: Client, ClientsArchive: Client,
	BillingView: Client, BillingManage: Client, PricingView: Client, PricingManage: Client,
	TasksView: Client, TasksManage: Client, TasksCreate: Client, TasksUpdate: Client, TasksDelete: Client, AnalyticsView: Client, IntegrationsManage: Client,
	PlanningView: Client, PlanningCreate: Client, PlanningUpdate: Client, PlanningArchive: Client,
	RemindersView: Client, RemindersCreate: Client, RemindersUpdate: Client,
}

func KnownPermission(permission Permission) bool {
	_, known := permissionScopes[permission]
	return known
}

type Grant struct {
	Permission Permission `json:"permission"`
	Scope      Scope      `json:"scope"`
	ClientID   string     `json:"client_id,omitempty"`
}

type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewService(pool *pgxpool.Pool) (*Service, error) {
	if pool == nil {
		return nil, ErrInvalidInput
	}
	return &Service{pool: pool, now: time.Now}, nil
}

// Allowed fails closed. A database error is returned for observability, but
// callers must never turn it into an allow decision.
func (s *Service) Allowed(ctx context.Context, userID string, permission Permission, clientID string) (bool, error) {
	scope, known := permissionScopes[permission]
	if !known || !validUUID(userID) || (scope == Global && clientID != "") ||
		(scope == Client && !validUUID(clientID)) {
		return false, nil
	}
	var allowed bool
	if err := s.pool.QueryRow(ctx, `SELECT app.authorization_allowed($1::uuid,$2,$3::uuid)`,
		userID, permission, nullableUUID(clientID)).Scan(&allowed); err != nil {
		return false, err
	}
	return allowed, nil
}

func (s *Service) Grants(ctx context.Context, userID string) ([]Grant, error) {
	if !validUUID(userID) {
		return nil, ErrInvalidInput
	}
	rows, err := s.pool.Query(ctx, `SELECT permission_key,scope_kind,client_id::text
		FROM app.authorization_grants($1::uuid) ORDER BY permission_key,scope_kind,client_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := make([]Grant, 0)
	for rows.Next() {
		var grant Grant
		var clientID *string
		if err := rows.Scan(&grant.Permission, &grant.Scope, &clientID); err != nil {
			return nil, err
		}
		expected, known := permissionScopes[grant.Permission]
		if !known || (grant.Scope == Client && expected != Client) ||
			(grant.Scope == Global && clientID != nil) || (grant.Scope == Client && clientID == nil) {
			return nil, ErrDenied
		}
		if grant.Scope != Global && grant.Scope != Client {
			return nil, ErrDenied
		}
		if clientID != nil {
			grant.ClientID = *clientID
		}
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}

func (s *Service) AssignRole(ctx context.Context, actorID, targetID, roleID string, scope Scope, clientID string) (string, error) {
	if !validUUID(actorID) || !validUUID(targetID) || !validUUID(roleID) ||
		(scope == Global && clientID != "") || (scope == Client && !validUUID(clientID)) ||
		(scope != Global && scope != Client) {
		return "", ErrInvalidInput
	}
	id, err := newID()
	if err != nil {
		return "", err
	}
	now := s.now().UTC()
	exists := true
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var created bool
		if err := q.QueryRow(ctx, `SELECT app.create_role_assignment($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7)`,
			actorID, targetID, roleID, scope, nullableUUID(clientID), id, now).Scan(&created); err != nil {
			return audit.Event{}, err
		}
		if !created {
			return audit.Event{}, ErrDenied
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actorID}, Action: audit.Created,
			ResourceKind: "role_assignment", ResourceID: id, ClientID: clientID,
			After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		var failure *pgconn.PgError
		if errors.As(err, &failure) && failure.Code == "42501" {
			return "", ErrDenied
		}
		return "", err
	}
	return id, nil
}

func (s *Service) RevokeRole(ctx context.Context, actorID, assignmentID string) error {
	if !validUUID(actorID) || !validUUID(assignmentID) {
		return ErrInvalidInput
	}
	now := s.now().UTC()
	exists := false
	return audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var changed bool
		var clientID *string
		if err := q.QueryRow(ctx, `SELECT changed,client_id::text FROM app.revoke_role_assignment($1::uuid,$2::uuid,$3)`,
			actorID, assignmentID, now).Scan(&changed, &clientID); err != nil {
			return audit.Event{}, err
		}
		if !changed {
			return audit.Event{}, ErrDenied
		}
		event := audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actorID}, Action: audit.Archived,
			ResourceKind: "role_assignment", ResourceID: assignmentID,
			After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.HTTP}}
		if clientID != nil {
			event.ClientID = *clientID
		}
		return event, nil
	})
}

func (s *Service) AssignPermission(ctx context.Context, actorID, roleID string, permission Permission) (string, error) {
	if !validUUID(actorID) || !validUUID(roleID) {
		return "", ErrInvalidInput
	}
	if _, known := permissionScopes[permission]; !known {
		return "", ErrInvalidInput
	}
	id, err := newID()
	if err != nil {
		return "", err
	}
	now := s.now().UTC()
	exists := true
	err = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var created bool
		if err := q.QueryRow(ctx, `SELECT app.create_permission_assignment($1::uuid,$2::uuid,$3,$4::uuid,$5)`,
			actorID, roleID, permission, id, now).Scan(&created); err != nil {
			return audit.Event{}, err
		}
		if !created {
			return audit.Event{}, ErrDenied
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actorID}, Action: audit.Created,
			ResourceKind: "permission_assignment", ResourceID: id,
			After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if err != nil {
		return "", err
	}
	return id, nil
}

func (s *Service) RevokePermission(ctx context.Context, actorID, assignmentID string) error {
	if !validUUID(actorID) || !validUUID(assignmentID) {
		return ErrInvalidInput
	}
	now := s.now().UTC()
	exists := false
	return audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var changed bool
		if err := q.QueryRow(ctx, `SELECT app.revoke_permission_assignment($1::uuid,$2::uuid,$3)`,
			actorID, assignmentID, now).Scan(&changed); err != nil {
			return audit.Event{}, err
		}
		if !changed {
			return audit.Event{}, ErrDenied
		}
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actorID}, Action: audit.Archived,
			ResourceKind: "permission_assignment", ResourceID: assignmentID,
			After: &audit.Snapshot{Exists: &exists}, Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
}

func validUUID(value string) bool {
	var id pgtype.UUID
	return id.Scan(value) == nil && id.Valid && id.Bytes != [16]byte{}
}

func nullableUUID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func newID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
