DEV = docker compose -f docker-compose.dev.yml
PROD = docker compose --project-directory /opt/pingapp -f /opt/pingapp/docker-compose.yml

.PHONY: up down logs ps sh npm install typecheck test build db-generate db-migrate psql redis-cli admin deploy prod-status prod-image-check prod-down prod-logs prod-admin prod-psql down-volumes

up:
	$(DEV) up -d --build

down:
	$(DEV) down

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

deploy:
	../docs/deploy/deploy.sh $(ARGS)

prod-status:
	../docs/deploy/deploy.sh --status

prod-image-check:
	docker compose -f docker-compose.yml build

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
