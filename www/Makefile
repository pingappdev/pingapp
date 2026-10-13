WWW_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DOCS_ROOT ?= $(abspath $(WWW_ROOT)/../../docs)
DOCKER ?= docker
COMPOSE = $(DOCKER) compose --project-directory "$(WWW_ROOT)" -f "$(DOCS_ROOT)/deploy/app/compose.frontend.dev.yml"
NATIVE_ENV ?= $(DOCS_ROOT)/deploy/frontend.android-emu.env

.PHONY: up down logs sh bun install typecheck lint build build-native

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200 web

sh:
	$(COMPOSE) exec web bash

bun:
	$(COMPOSE) run --rm web bun $(ARGS)

install:
	$(COMPOSE) run --rm web bun install

typecheck:
	$(COMPOSE) run --rm web bunx tsc --noEmit

lint:
	$(COMPOSE) run --rm web bun run lint

build:
	$(COMPOSE) run --rm $(if $(VERCEL),-e VERCEL=$(VERCEL)) web bun run build

# A standalone tool container avoids inheriting the web service's env_file.
# The chosen native env is loaded for this build only, never into the dev stack.
build-native:
	$(DOCKER) run --rm --env-file "$(NATIVE_ENV)" -e VITE_TARGET=native \
		-v "$(WWW_ROOT):/app" -w /app \
		$$($(COMPOSE) images -q web) bun run build
