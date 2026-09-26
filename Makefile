# Runs the two stacks on any host with Docker. See runtime/README.md for the host runbooks.
#
# pages      : headless browser keepers, no secret, no service connection
# evaluators : the traffic containers, one host at a time, needs runtime/sdk-keys.env

SHELL := /bin/sh
STEP ?= s033

# The organisation owning the generated service repositories. Read from the ignored .env so the
# repository itself names no organisation.
ORG ?= $(shell sed -n 's/^GH_ORG=//p' .env 2>/dev/null)

# Only the services the runtime builds from source. Cloning is read-only and needs no token.
RUNTIME_REPOS := demo-orders demo-profile

EVALUATORS := docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml
PAGES := docker compose -f runtime/compose.pages.yaml

# Hosts the SDKs must reach. Any HTTP status proves the path is open; 401 is the expected answer
# to an unauthenticated probe and is a pass.
LD_ENDPOINTS := https://sdk.launchdarkly.com/sdk/latest-all https://stream.launchdarkly.com/all https://events.launchdarkly.com/bulk https://clientsdk.launchdarkly.com

# A container carries its own certificate store and its own route to the internet, so it is probed
# separately from the host. Pinned so a verify run cannot drift.
PROBE_IMAGE := curlimages/curl:8.11.1

.PHONY: help doctor clone bootstrap pages-up pages-down pages-ps pages-logs evaluators-up evaluators-down evaluators-ps evaluators-logs status verify handover-in handover-out

help:
	@echo "doctor          what this host can run, and what is missing"
	@echo "clone           shallow, token-free clones of the service repositories"
	@echo "bootstrap       clone, then check out the pinned release trees (STEP=$(STEP))"
	@echo "pages-up        start the page keepers"
	@echo "pages-down      stop the page keepers"
	@echo "evaluators-up   start the evaluator stack (one host at a time)"
	@echo "evaluators-down stop the evaluator stack"
	@echo "status          what is running here, and the last batch of each evaluator"
	@echo "verify          is evaluation traffic reaching LaunchDarkly from this host"
	@echo "handover-in     take over: bootstrap, start, then show what to verify"
	@echo "handover-out    hand over: stop the evaluator stack only"

doctor:
	@command -v docker >/dev/null 2>&1 && echo "docker: yes" || echo "docker: MISSING"
	@docker info >/dev/null 2>&1 && echo "docker engine: running" || echo "docker engine: NOT RUNNING"
	@command -v node >/dev/null 2>&1 && echo "node: $$(node --version)" || echo "node: MISSING (needed for bootstrap only)"
	@test -f runtime/sdk-keys.env && echo "runtime/sdk-keys.env: present" || echo "runtime/sdk-keys.env: MISSING (evaluators cannot start)"
	@test -n "$(ORG)" && echo "GH_ORG: set" || echo "GH_ORG: MISSING from .env (needed by make clone)"
	@for repo in $(RUNTIME_REPOS); do \
		test -d "runtime/repos/$$repo/.git" && echo "clone $$repo: present" || echo "clone $$repo: missing, run make clone"; \
	done
	@test -d runtime/worktrees && echo "release trees: present" || echo "release trees: missing, run make bootstrap"
	@echo "containers here: $$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c . || echo 0)"

# Shallow, token-free clones of the public service repositories into ignored runtime/repos.
# Without them, scenario compose cannot check out a release tree and says "run recreate or refresh
# first". Never do that: recreate deletes the project and the repositories, and refresh deletes and
# recreates the repositories. Both destroy evidence this campaign cannot rebuild. Cloning is all
# that is missing on a fresh host.
clone:
	@test -n "$(ORG)" || { echo "GH_ORG is not set: put it in .env, or run make clone ORG=<org>"; exit 1; }
	@mkdir -p runtime/repos
	@for repo in $(RUNTIME_REPOS); do \
		if [ -d "runtime/repos/$$repo/.git" ]; then \
			echo "$$repo: already cloned"; \
		else \
			echo "$$repo: cloning"; \
			git clone --depth 1 "https://github.com/$(ORG)/$$repo.git" "runtime/repos/$$repo" || exit 1; \
		fi; \
	done

bootstrap: clone
	node demo.mjs scenario compose --to $(STEP)

pages-up:
	$(PAGES) up --detach --build

pages-down:
	$(PAGES) down

pages-ps:
	$(PAGES) ps --all

pages-logs:
	$(PAGES) logs --tail 20 --timestamps

evaluators-up:
	@test -f runtime/sdk-keys.env || { echo "runtime/sdk-keys.env is missing: this host cannot run evaluators"; exit 1; }
	$(EVALUATORS) up --detach --build

# For a host behind a TLS-inspecting VPN or proxy. See runtime/compose.corp-ca.yaml.
evaluators-up-corp-ca:
	@test -n "$(CORP_CA)" || { echo "set CORP_CA to the corporate root certificate in PEM form"; exit 1; }
	@test -f "$(CORP_CA)" || { echo "CORP_CA file not found: $(CORP_CA)"; exit 1; }
	CORP_CA="$(CORP_CA)" $(EVALUATORS) -f runtime/compose.corp-ca.yaml up --detach --build

evaluators-down:
	$(EVALUATORS) down

evaluators-ps:
	$(EVALUATORS) ps --all

evaluators-logs:
	$(EVALUATORS) logs --tail 20 --timestamps

status:
	@echo "== containers =="
	@docker ps --format '{{.Names}}\t{{.Status}}' | sort
	@echo "== last batch per evaluator =="
	@for c in $$(docker ps --format '{{.Names}}' | grep '^runtime-' || true); do \
		printf '%s\t' "$$c"; \
		docker logs --timestamps --tail 200 "$$c" 2>&1 | grep traffic-batch | tail -1 | cut -c1-20 || echo "no batch yet"; \
	done

# Is anything eating the traffic between this host and LaunchDarkly? Three independent answers:
# the network path, the SDK's own flush result, and whether evaluations returned real values or
# the fallbacks a disconnected SDK serves.
verify:
	@echo "== network path =="
	@for url in $(LD_ENDPOINTS); do \
		code=$$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$$url" || echo 000); \
		case "$$code" in \
			000) echo "  BLOCKED $$url (no HTTP response: firewall, proxy or DNS)";; \
			*) echo "  reachable ($$code) $$url";; \
		esac; \
	done
	@echo "== who issued the certificate, from this host =="
	@echo "  a corporate issuer means TLS is being intercepted, and a container will not trust it"
	@for host in sdk.launchdarkly.com events.launchdarkly.com; do \
		issuer=$$(echo | openssl s_client -connect "$$host:443" -servername "$$host" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null); \
		echo "  $$host $${issuer:-no certificate returned}"; \
	done
	@echo "== network path from inside a container =="
	@echo "  the containers do not share this host's VPN routes or its certificate store"
	@docker run --rm $(PROBE_IMAGE) -s -o /dev/null -m 15 -w '  sdk.launchdarkly.com: %{http_code}\n' https://sdk.launchdarkly.com/sdk/latest-all 2>&1 | tail -1 || echo "  sdk.launchdarkly.com: BLOCKED from containers"
	@docker run --rm $(PROBE_IMAGE) -sS -o /dev/null -m 15 https://events.launchdarkly.com/bulk 2>&1 | head -2 || true
	@echo "== SDK flush, from the last batch of each evaluator =="
	@for c in $$(docker ps --format '{{.Names}}' | grep '^runtime-' || true); do \
		line=$$(docker logs --tail 200 "$$c" 2>&1 | grep traffic-batch | tail -1); \
		if [ -z "$$line" ]; then echo "  $$c: no batch logged yet"; \
		elif echo "$$line" | grep -q '"flush":"ok"'; then echo "  $$c: flush ok"; \
		else echo "  $$c: FLUSH NOT OK, events are not reaching LaunchDarkly"; fi; \
	done
	@echo "== real values or fallbacks =="
	@echo "  a disconnected SDK serves the fallback for every flag, so an all-false batch is the tell"
	@for c in $$(docker ps --format '{{.Names}}' | grep '^runtime-' || true); do \
		line=$$(docker logs --tail 200 "$$c" 2>&1 | grep traffic-batch | tail -1); \
		if echo "$$line" | grep -q '"true":[1-9]'; then echo "  $$c: serving real values"; \
		elif [ -n "$$line" ]; then echo "  $$c: every evaluation false, check targeting before assuming a block"; fi; \
	done
	@echo "== container restarts, a crash loop means flush is failing =="
	@docker ps --format '{{.Names}}\t{{.Status}}' | grep '^runtime-' || echo "  no evaluators running here"

handover-in: bootstrap evaluators-up pages-up
	@echo
	@echo "Started here. Before the old host stops, confirm a batch has arrived:"
	@echo "  make status"
	@echo "Then on the old host: make handover-out"

handover-out: evaluators-down
	@echo "Evaluator stack stopped here. Page keepers, if any, are still running: make pages-down"
