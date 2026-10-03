package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/theroisey/else/backend/internal/activity"
	"github.com/theroisey/else/backend/internal/administration"
	"github.com/theroisey/else/backend/internal/auditreader"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/billing"
	"github.com/theroisey/else/backend/internal/clients"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/database"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
	"github.com/theroisey/else/backend/internal/integrations/connections"
	"github.com/theroisey/else/backend/internal/integrations/keysource"
	"github.com/theroisey/else/backend/internal/overview"
	"github.com/theroisey/else/backend/internal/planning"
	"github.com/theroisey/else/backend/internal/pricing"
	"github.com/theroisey/else/backend/internal/reminders"
	"github.com/theroisey/else/backend/internal/tasks"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if code := run(ctx, os.LookupEnv, os.Stdout); code != 0 {
		os.Exit(code)
	}
}

func run(ctx context.Context, lookup func(string) (string, bool), output io.Writer) int {
	c, err := config.Load(lookup)
	if err != nil {
		logger := slog.New(slog.NewJSONHandler(output, nil))
		logger.Error("invalid_configuration", "detail", err.Error())
		return 1
	}
	logger := slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{Level: c.LogLevel}))
	if ctx.Err() != nil {
		return 0
	}
	keySettings, err := keysource.LoadSettings(lookup)
	if err != nil {
		logger.Error("integration_key_startup_failed")
		return 1
	}
	ring, err := keysource.Read(ctx, keySettings)
	if err != nil {
		logger.Error("integration_key_startup_failed")
		return 1
	}
	dbConfig, err := config.LoadDatabase(lookup, "DATABASE_URL")
	if err != nil {
		logger.Error("invalid_configuration", "detail", err.Error())
		return 1
	}
	pool, err := database.Open(ctx, dbConfig)
	if err != nil {
		logger.Error("database_startup_failed", "error_code", database.FailureCode(err))
		return 1
	}
	defer pool.Close()
	if keySettings.Enabled() {
		if err := keysource.Preflight(ctx, pool, ring, keySettings.Restored()); err != nil {
			logger.Error("integration_key_startup_failed")
			return 1
		}
	}
	authConfig, err := config.LoadAuth(lookup)
	if err != nil {
		logger.Error("invalid_configuration", "detail", err.Error())
		return 1
	}
	authorizationService, err := authorization.NewService(pool)
	if err != nil {
		logger.Error("authorization_startup_failed", "error_code", "authorization_startup_failed")
		return 1
	}
	identityService, err := identity.NewService(pool, identity.ArgonPasswords{}, authorizationService)
	if err != nil {
		logger.Error("identity_startup_failed", "error_code", "identity_startup_failed")
		return 1
	}
	authHandler, err := identity.NewHandler(identityService, authConfig, logger)
	if err != nil {
		logger.Error("identity_startup_failed", "error_code", "identity_startup_failed")
		return 1
	}
	administrationService, err := administration.NewService(pool, identity.ArgonPasswords{})
	if err != nil {
		logger.Error("administration_startup_failed", "error_code", "administration_startup_failed")
		return 1
	}
	administrationHandler, err := administration.NewHandler(administrationService, authHandler, authorizationService, logger)
	if err != nil {
		logger.Error("administration_startup_failed", "error_code", "administration_startup_failed")
		return 1
	}
	clientService, err := clients.NewService(pool)
	if err != nil {
		logger.Error("client_startup_failed", "error_code", "client_startup_failed")
		return 1
	}
	clientHandler, err := clients.NewHandler(clientService, authHandler, logger)
	if err != nil {
		logger.Error("client_startup_failed", "error_code", "client_startup_failed")
		return 1
	}
	taskService, err := tasks.NewService(pool)
	if err != nil {
		logger.Error("task_startup_failed", "error_code", "task_startup_failed")
		return 1
	}
	taskHandler, err := tasks.NewHandler(taskService, authHandler, logger)
	if err != nil {
		logger.Error("task_startup_failed", "error_code", "task_startup_failed")
		return 1
	}
	planningService, err := planning.NewService(pool)
	if err != nil {
		logger.Error("planning_startup_failed", "error_code", "planning_startup_failed")
		return 1
	}
	planningHandler, err := planning.NewHandler(planningService, authHandler, logger)
	if err != nil {
		logger.Error("planning_startup_failed", "error_code", "planning_startup_failed")
		return 1
	}
	reminderService, err := reminders.NewService(pool)
	if err != nil {
		logger.Error("reminders_startup_failed", "error_code", "reminders_startup_failed")
		return 1
	}
	reminderHandler, err := reminders.NewHandler(reminderService, authHandler, logger)
	if err != nil {
		logger.Error("reminders_startup_failed", "error_code", "reminders_startup_failed")
		return 1
	}
	activityService, err := activity.NewService(pool)
	if err != nil {
		logger.Error("activity_startup_failed", "error_code", "activity_startup_failed")
		return 1
	}
	activityHandler, err := activity.NewHandler(activityService, authHandler, logger)
	if err != nil {
		logger.Error("activity_startup_failed", "error_code", "activity_startup_failed")
		return 1
	}
	auditService, err := auditreader.NewService(pool)
	if err != nil {
		logger.Error("audit_reader_startup_failed", "error_code", "audit_reader_startup_failed")
		return 1
	}
	auditHandler, err := auditreader.NewHandler(auditService, authHandler, logger)
	if err != nil {
		logger.Error("audit_reader_startup_failed", "error_code", "audit_reader_startup_failed")
		return 1
	}
	billingService, err := billing.NewService(pool)
	if err != nil {
		logger.Error("billing_startup_failed", "error_code", "billing_startup_failed")
		return 1
	}
	billingHandler, err := billing.NewHandler(billingService, authHandler, logger)
	if err != nil {
		logger.Error("billing_startup_failed", "error_code", "billing_startup_failed")
		return 1
	}
	pricingService, err := pricing.NewService(pool)
	if err != nil {
		logger.Error("pricing_startup_failed", "error_code", "pricing_startup_failed")
		return 1
	}
	pricingHandler, err := pricing.NewHandler(pricingService, authHandler, logger)
	if err != nil {
		logger.Error("pricing_startup_failed", "error_code", "pricing_startup_failed")
		return 1
	}
	overviewService, err := overview.NewService(pool)
	if err != nil {
		logger.Error("overview_startup_failed", "error_code", "overview_startup_failed")
		return 1
	}
	overviewHandler, err := overview.NewHandler(overviewService, authHandler, logger)
	if err != nil {
		logger.Error("overview_startup_failed", "error_code", "overview_startup_failed")
		return 1
	}
	connectionService, err := connections.NewService(pool)
	if err != nil {
		logger.Error("integration_metadata_startup_failed")
		return 1
	}
	connectionHandler, err := connections.NewHandler(connectionService, authHandler, logger)
	if err != nil {
		logger.Error("integration_metadata_startup_failed")
		return 1
	}
	server, err := httpapi.NewWithIntegrations(c, logger, pool.Ping, authHandler, administrationHandler, clientHandler, taskHandler, planningHandler, reminderHandler, activityHandler, auditHandler, billingHandler, pricingHandler, overviewHandler, connectionHandler)
	if err != nil {
		logger.Error("server_configuration_invalid")
		return 1
	}
	if err := server.Run(ctx); err != nil {
		// Internal errors retain their cause, but public logs never print raw
		// transport errors or request-derived details.
		logger.Error("server_failed", "error_code", "server_failed")
		return 1
	}
	return 0
}
