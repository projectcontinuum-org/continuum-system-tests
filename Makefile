.PHONY: up down logs ps smoke tenancy test check

COMPOSE = docker compose -f docker/docker-compose.yml --env-file docker/.env

# Infra + platform services + feature-base worker. Workbench, nginx and cheminformatics are not needed for the tests.
SERVICES = postgresql temporal temporal-search-attributes-init mosquitto kafka1 kafka2 kafka3 schema-registry minio \
	continuum-api-server continuum-orchestration-service continuum-message-bridge continuum-credentials-server \
	continuum-feature-base

up:
	$(COMPOSE) up -d --wait $(SERVICES)

down:
	$(COMPOSE) down -v

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100 $(SERVICES)

smoke:
	./run.sh smoke

tenancy:
	./run.sh tenancy

# Pure-JS unit tests for lib/util.js and a syntax check of every k6 script. Needs only node, not k6 or Docker.
test:
	npm test

check:
	npm run check
