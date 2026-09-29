COMPOSE = docker compose -f docker-compose.dev.yml

.PHONY: up down logs sh bun install typecheck lint build

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
