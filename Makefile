.DEFAULT_GOAL := help
SHELL := /bin/sh
NODE ?= node
NPM ?= npm
CARGO ?= cargo
PYTHON ?= python3
DOCKER ?= docker
COMPOSE = $(DOCKER) compose
TARGET ?= x86_64-unknown-linux-musl
CARGO_TARGET_DIR ?= target
export CARGO_TARGET_DIR
IMAGE ?= roisey-else:local
DEV_DATA ?= $(CURDIR)/.local/data
DEV_ORIGIN ?= http://127.0.0.1:5173
BACKUP_NAME ?= backup-$(shell date -u +%Y%m%dT%H%M%SZ)
BACKUP_PATH ?= /var/lib/roisey-else/backups/$(BACKUP_NAME)

.PHONY: help install dev dev-bootstrap frontend frontend-build backend backend-release build test test-http test-browser test-container test-capacity test-compose test-cache test-import lint fmt check docker up down restart logs clean migrate bootstrap key-inventory rotate-credentials import-postgres update backup restore

help: ## List the supported workflows
	@awk 'BEGIN {FS=":.*## ";print "Roisey Else workflows"} /^[a-z-]+:.*## / {printf "  %-18s %s\n",$$1,$$2}' $(MAKEFILE_LIST)

install: ## Install locked dependencies (Node 24, Rust and native tools required)
	@command -v cmake >/dev/null && command -v cc >/dev/null && command -v openssl >/dev/null || { echo 'Install a C compiler, CMake and OpenSSL first.' >&2; exit 1; }
	cd frontend && $(NPM) ci
	$(CARGO) fetch --locked
	rustup target add $(TARGET)

frontend: ## Run frontend hot reload on loopback :5173
	cd frontend && $(NPM) run dev

frontend-build: ## Build production assets and deterministic gzip variants
	cd frontend && $(NPM) run build
	$(PYTHON) tools/prepare-artifacts.py frontend

backend: ## Run local Pingora on :8080 (use make frontend separately)
	DATABASE_PATH='$(DEV_DATA)/else.sqlite3' FRONTEND_DIRECTORY='$(CURDIR)/frontend/dist' HTTP_ADDRESS=127.0.0.1:8080 AUTH_PUBLIC_ORIGIN='$(DEV_ORIGIN)' AUTH_COOKIE_SECURE=false $(CARGO) run --locked --bin roisey-else -- serve

dev: frontend-build ## Build initial assets and run backend; make frontend adds HMR
	$(MAKE) backend

dev-bootstrap: ## Create the first local administrator with a private password prompt
	DATABASE_PATH='$(DEV_DATA)/else.sqlite3' FRONTEND_DIRECTORY='$(CURDIR)/frontend/dist' AUTH_PUBLIC_ORIGIN='$(DEV_ORIGIN)' AUTH_COOKIE_SECURE=false $(PYTHON) tools/bootstrap.py -- $(CARGO) run --locked --bin roisey-else -- bootstrap

backend-release: ## Compile static production binary; native musl tooling required
	$(CARGO) build --locked --release --target $(TARGET)
	$(PYTHON) tools/prepare-artifacts.py runtime --binary $(CARGO_TARGET_DIR)/$(TARGET)/release/roisey-else

build: frontend-build backend-release ## Prepare all production artifacts before Docker

test: ## Run meaningful frontend and Rust unit/domain tests
	cd frontend && $(NODE) node_modules/vitest/vitest.mjs run
	$(CARGO) test --locked --workspace

test-http: frontend-build ## Verify real Pingora HTTP and both shutdown signals
	$(CARGO) build --locked --workspace
	$(PYTHON) backend/tests/http_smoke.py --binary $(CARGO_TARGET_DIR)/debug/roisey-else --frontend frontend/dist --signal TERM
	$(PYTHON) backend/tests/http_smoke.py --binary $(CARGO_TARGET_DIR)/debug/roisey-else --frontend frontend/dist --signal INT

test-browser: ## Run single-origin browser workflows on disposable SQLite storage
	$(PYTHON) tools/test-browser.py --binary $(CARGO_TARGET_DIR)/debug/roisey-else --fixture-binary $(CARGO_TARGET_DIR)/debug/examples/browser-fixture

test-container: ## Verify IMAGE persistence, nonroot runtime and supported recovery
	$(PYTHON) tools/test-container.py --image '$(IMAGE)'

test-capacity: ## Rehearse 500 clients and 100 users against IMAGE
	$(CARGO) build --locked --example browser-fixture
	$(PYTHON) tools/test-capacity.py --image '$(IMAGE)' --fixture-binary $(CARGO_TARGET_DIR)/debug/examples/browser-fixture

test-compose: ## Verify actual Compose and optional Redis on private test storage
	$(PYTHON) tools/test-compose.py --image '$(IMAGE)'

test-cache: ## Verify cache/outage fallback against official Redis
	$(PYTHON) tools/test-infrastructure.py cache

test-import: ## Verify populated PostgreSQL v28 import with original constraints
	$(PYTHON) tools/test-infrastructure.py import

lint: ## Check frontend types/lint, Rust format and warnings-as-errors Clippy
	cd frontend && $(NPM) run typecheck && $(NPM) run lint
	$(CARGO) fmt --all --check
	$(CARGO) clippy --locked --workspace --all-targets -- -D warnings

fmt: ## Format Rust source
	$(CARGO) fmt --all

check: lint test ## Run normal source quality gates

docker: build ## Build one custom image from already prepared artifacts
	$(DOCKER) build --build-arg BUILD_REVISION=$$(git rev-parse HEAD) --build-arg BUILD_TIME=$$(date -u +%Y-%m-%dT%H:%M:%SZ) -t $(IMAGE) .

up: ## Start selected production image and wait for readiness
	$(COMPOSE) up -d --wait --wait-timeout 60

down: ## Stop/remove containers; KEEP persistent data volumes
	$(COMPOSE) down

restart: ## Gracefully restart the application
	$(COMPOSE) restart else

logs: ## Follow structured application logs
	$(COMPOSE) logs --tail=100 -f else

migrate: ## Verify/apply additive SQLite migrations on selected volume
	$(COMPOSE) run --rm --no-deps else migrate

bootstrap: ## Create the first administrator with a private password prompt
	$(PYTHON) tools/bootstrap.py -- $(COMPOSE) run --rm --no-deps -T else bootstrap

key-inventory: ## Read retained-key counts; actor attribution JSON on stdin
	$(COMPOSE) exec -T else /roisey-else key-inventory

rotate-credentials: ## Run one confirmed bounded rotation page from JSON stdin
	$(COMPOSE) exec -T else /roisey-else rotate-credentials

import-postgres: ## Import protected IMPORT_BUNDLE into explicitly empty IMPORT_VOLUME
	@test -n '$(IMPORT_BUNDLE)' && test -n '$(IMPORT_VOLUME)' || { echo 'Set an absolute, protected IMPORT_BUNDLE and empty IMPORT_VOLUME.' >&2; exit 1; }
	ELSE_DATA_VOLUME='$(IMPORT_VOLUME)' $(COMPOSE) run --rm --no-deps -T --volume '$(IMPORT_BUNDLE):/import-source:ro' -e IMPORT_DIRECTORY=/import-source else import-postgres

update: ## Pull and recreate selected images; registry checks stay outside app
	$(COMPOSE) pull
	$(COMPOSE) up -d --wait --wait-timeout 60

backup: ## Verify an online SQLite + retained-key bundle inside data volume
	$(COMPOSE) exec -T -e BACKUP_DIRECTORY='$(BACKUP_PATH)' else /roisey-else backup
	@printf 'Verified bundle: %s\n' '$(BACKUP_PATH)'

restore: ## Restore BACKUP_NAME from SOURCE_VOLUME into empty RESTORE_VOLUME
	@test -n '$(SOURCE_VOLUME)' && test -n '$(RESTORE_VOLUME)' && test '$(SOURCE_VOLUME)' != '$(RESTORE_VOLUME)' || { echo 'Set distinct SOURCE_VOLUME and empty RESTORE_VOLUME.' >&2; exit 1; }
	ELSE_DATA_VOLUME='$(RESTORE_VOLUME)' $(COMPOSE) run --rm --no-deps -T --volume '$(SOURCE_VOLUME):/backup-source:ro' -e BACKUP_DIRECTORY='/backup-source/backups/$(BACKUP_NAME)' else restore

clean: ## Remove generated assets, never application data
	$(CARGO) clean
	rm -rf build frontend/dist frontend/test-results frontend/playwright-report
