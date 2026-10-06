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

.PHONY: help install dev dev-bootstrap frontend frontend-build backend backend-release build test test-http test-browser test-container test-capacity test-compose test-cache redis-artifacts runtime-fixture lint fmt check docker up down restart logs clean migrate bootstrap key-inventory rotate-credentials update backup restore

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

backend: redis-artifacts ## Run local Pingora on :8080 (use make frontend separately)
	DATABASE_PATH='$(DEV_DATA)/else.sqlite3' FRONTEND_DIRECTORY='$(CURDIR)/frontend/dist' HTTP_ADDRESS=127.0.0.1:8080 AUTH_PUBLIC_ORIGIN='$(DEV_ORIGIN)' AUTH_COOKIE_SECURE=false $(CARGO) run --locked --bin roisey-else -- serve

dev: frontend-build ## Build initial assets and run backend; make frontend adds HMR
	$(MAKE) backend

dev-bootstrap: ## Create the first local administrator with a private password prompt
	DATABASE_PATH='$(DEV_DATA)/else.sqlite3' FRONTEND_DIRECTORY='$(CURDIR)/frontend/dist' AUTH_PUBLIC_ORIGIN='$(DEV_ORIGIN)' AUTH_COOKIE_SECURE=false $(PYTHON) tools/bootstrap.py -- $(CARGO) run --locked --bin roisey-else -- bootstrap

backend-release: ## Compile static production binary; native musl tooling required
	$(CARGO) build --locked --release --target $(TARGET)
	$(PYTHON) tools/prepare-artifacts.py runtime --binary $(CARGO_TARGET_DIR)/$(TARGET)/release/roisey-else

build: frontend-build backend-release redis-artifacts ## Prepare all production artifacts before Docker

test: redis-artifacts ## Run meaningful frontend and Rust unit/domain tests
	cd frontend && $(NODE) node_modules/vitest/vitest.mjs run
	$(CARGO) test --locked --workspace

test-http: frontend-build redis-artifacts ## Verify real Pingora HTTP and both shutdown signals
	$(CARGO) build --locked --workspace
	$(PYTHON) backend/tests/http_smoke.py --binary $(CARGO_TARGET_DIR)/debug/roisey-else --frontend frontend/dist --signal TERM
	$(PYTHON) backend/tests/http_smoke.py --binary $(CARGO_TARGET_DIR)/debug/roisey-else --frontend frontend/dist --signal INT

test-browser: redis-artifacts ## Run single-origin browser workflows on disposable SQLite storage
	$(PYTHON) tools/test-browser.py --binary $(CARGO_TARGET_DIR)/debug/roisey-else --fixture-binary $(CARGO_TARGET_DIR)/debug/examples/browser-fixture

test-container: runtime-fixture ## Verify IMAGE persistence, nonroot runtime and supported recovery
	$(PYTHON) tools/test-container.py --image '$(IMAGE)'

test-capacity: ## Rehearse 500 clients and 100 users against IMAGE
	$(CARGO) build --locked --example browser-fixture
	$(PYTHON) tools/test-capacity.py --image '$(IMAGE)' --fixture-binary $(CARGO_TARGET_DIR)/debug/examples/browser-fixture

test-compose: runtime-fixture ## Verify actual single-service Compose on private test storage
	$(PYTHON) tools/test-compose.py --image '$(IMAGE)'

redis-artifacts: ## Prepare pinned embedded Redis, minimal libraries and notices
	$(PYTHON) tools/prepare-redis.py

runtime-fixture: ## Build the host-only static container inspection helper
	$(CARGO) build --locked --release --target $(TARGET) --example runtime-fixture
	mkdir -p build
	cp --remove-destination $(CARGO_TARGET_DIR)/$(TARGET)/release/examples/runtime-fixture build/runtime-fixture

test-cache: redis-artifacts ## Verify owned cache, deadlines, integrity and failure handling
	$(CARGO) test --locked --workspace embedded_

lint: ## Check frontend types/lint, Rust format and warnings-as-errors Clippy
	cd frontend && $(NPM) run typecheck && $(NPM) run lint
	$(CARGO) fmt --all --check
	$(CARGO) clippy --locked --workspace --all-targets -- -D warnings

fmt: ## Format Rust source
	$(CARGO) fmt --all

check: lint test ## Run normal source quality gates

docker: build ## Build one custom image from already prepared artifacts
	$(DOCKER) build --build-arg BUILD_REVISION=$$(git rev-parse HEAD) --build-arg BUILD_TIME=$$(date -u +%Y-%m-%dT%H:%M:%SZ) -t $(IMAGE) .

up: ## Start the production image and wait for readiness
	$(COMPOSE) up -d --wait --wait-timeout 60

down: ## Stop/remove containers; KEEP persistent data volumes
	$(COMPOSE) down

restart: ## Gracefully restart the application
	$(COMPOSE) restart else

logs: ## Follow structured application logs
	$(COMPOSE) logs --tail=100 -f else

migrate: ## Verify/apply additive SQLite migrations on the fixed data volume
	$(COMPOSE) run --rm --no-deps else migrate

bootstrap: ## Create the first administrator with a private password prompt
	$(PYTHON) tools/bootstrap.py -- $(COMPOSE) run --rm --no-deps -T else bootstrap

key-inventory: ## Read retained-key counts; actor attribution JSON on stdin
	$(COMPOSE) exec -T else /roisey-else key-inventory

rotate-credentials: ## Run one confirmed bounded rotation page from JSON stdin
	$(COMPOSE) exec -T else /roisey-else rotate-credentials


update: ## Pull and recreate the production image; registry checks stay outside app
	$(COMPOSE) pull
	$(COMPOSE) up -d --wait --wait-timeout 60

backup: ## Verify an online SQLite + retained-key bundle inside data volume
	$(COMPOSE) exec -T -e BACKUP_DIRECTORY='$(BACKUP_PATH)' else /roisey-else backup
	@printf 'Verified bundle: %s\n' '$(BACKUP_PATH)'

restore: ## Restore absolute BACKUP_SOURCE into EMPTY fixed storage on a recovery host
	@test -n '$(BACKUP_SOURCE)' && test -d '$(BACKUP_SOURCE)' || { echo 'Set BACKUP_SOURCE to an absolute protected backup bundle directory.' >&2; exit 1; }
	$(PYTHON) tools/restore.py --source '$(BACKUP_SOURCE)' -- $(COMPOSE)

clean: ## Remove generated assets, never application data
	$(CARGO) clean
	rm -rf build frontend/dist frontend/test-results frontend/playwright-report
