.PHONY: up pull down logs ps smoke tenancy api cluster-manager up-cluster-manager test check

# Use the `docker compose` plugin when present, otherwise the standalone `docker-compose` binary (for example a
# Homebrew install where the plugin directory is not registered in ~/.docker/config.json).
COMPOSE_BIN := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")
COMPOSE = $(COMPOSE_BIN) -f docker/docker-compose.yml --env-file docker/.env

# Infra + platform services + feature-base worker. Workbench, nginx and cheminformatics are not needed for the tests.
SERVICES = postgresql temporal temporal-search-attributes-init mosquitto kafka1 kafka2 kafka3 schema-registry minio \
	continuum-api-server continuum-orchestration-service continuum-message-bridge continuum-credentials-server \
	continuum-feature-base

up:
	$(COMPOSE) up -d --wait $(SERVICES)

# Pull (or re-pull) the images for the services above without starting anything. Layers that were already
# downloaded are reused, so this resumes after a failed pull (for example a full disk).
pull:
	$(COMPOSE) pull $(SERVICES)

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

# Every suite under suites/api/, one after another. Stops at the first failing suite.
API_SUITES = workflow runs schedules node-explorer data credentials
api:
	@set -e; for s in $(API_SUITES); do echo "=== api/$$s"; ./run.sh suites/api/$$s.js --quiet; done

# The cluster-manager is optional and not part of `make up`. This starts it next to the running stack. Without a
# Kubernetes cluster it still answers validation, 404 and authorize requests (the suite's first tier).
up-cluster-manager:
	$(COMPOSE_BIN) -f docker/docker-compose.yml -f docker/docker-compose.cluster-manager.yml --env-file docker/.env \
		up -d --no-deps --wait continuum-cluster-manager

# Skips itself (and says so) when the cluster-manager is not reachable. Add CLUSTER_MANAGER_K8S=true to also run the
# lifecycle tier, which creates real pods and needs the cluster-manager to reach a cluster.
cluster-manager:
	./run.sh suites/api/cluster-manager.js

# Pure-JS unit tests for lib/util.js and a syntax check of every k6 script. Needs only node, not k6 or Docker.
test:
	npm test

check:
	npm run check
