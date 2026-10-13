APP_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DOCS_ROOT ?= $(abspath $(APP_ROOT)/../docs)
DOCKER ?= docker
DEV = $(DOCKER) compose --project-directory "$(APP_ROOT)" -f "$(DOCS_ROOT)/deploy/app/compose.backend.dev.yml"
PROD_ROOT ?= /opt/pingapp
PROD = $(DOCKER) compose --project-directory "$(PROD_ROOT)" -f "$(PROD_ROOT)/docs/deploy/app/compose.prod.yml"

.PHONY: up down api-up api-down www-up www-down www-install www-typecheck www-lint www-build check logs ps sh npm install typecheck test build db-generate db-migrate psql redis-cli admin release deploy prod-status prod-image-check prod-down prod-logs prod-admin prod-psql down-volumes

up: api-up www-up

api-up:
	$(DEV) up -d --build

down: www-down api-down

api-down:
	$(DEV) down

www-up www-down www-install www-typecheck www-lint www-build:
	$(MAKE) -C "$(APP_ROOT)/www" $(patsubst www-%,%,$@) DOCKER="$(DOCKER)" DOCS_ROOT="$(DOCS_ROOT)"

check: typecheck test www-typecheck www-lint

logs:
	$(DEV) logs -f --tail=200 api worker

ps:
	$(DEV) ps

sh:
	$(DEV) exec api sh

npm:
	$(DEV) run --rm --no-deps api npm $(ARGS)

install:
	$(DEV) run --rm --no-deps api npm install

typecheck:
	$(DEV) run --rm --no-deps api npm run typecheck

test:
	$(DEV) run --rm --no-deps api npm test

build:
	$(DEV) run --rm --no-deps api npm run build

db-generate:
	$(DEV) run --rm --no-deps api npm run db:generate

db-migrate:
	$(DEV) run --rm migrate

psql:
	$(DEV) exec postgres psql -U pingapp pingapp

redis-cli:
	$(DEV) exec redis redis-cli

admin:
	$(DEV) exec api npx tsx src/cli/admin.ts $(ARGS)

release:
	"$(DOCS_ROOT)/deploy/app/prepare-release.sh" $(ARGS)

deploy:
	PINGAPP_SRC="$(APP_ROOT)" "$(DOCS_ROOT)/deploy/deploy.sh" $(ARGS)

prod-status:
	"$(DOCS_ROOT)/deploy/deploy.sh" --status

prod-image-check:
	$(DOCKER) build -f "$(DOCS_ROOT)/deploy/app/backend.Dockerfile" --target runtime "$(APP_ROOT)"

prod-down:
	$(PROD) down

prod-logs:
	$(PROD) logs -f --tail=200 api worker

prod-admin:
	$(PROD) exec api node dist/cli/admin.js $(ARGS)

prod-psql:
	$(PROD) exec postgres psql -U pingapp pingapp

down-volumes:
	$(DEV) down -v
