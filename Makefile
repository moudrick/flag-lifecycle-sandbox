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

.PHONY: help doctor clone bootstrap pages-up pages-down pages-ps pages-logs evaluators-up evaluators-down evaluators-ps evaluators-logs status handover-in handover-out

help:
	@echo "doctor          what this host can run, and what is missing"
	@echo "clone           shallow, token-free clones of the service repositories"
	@echo "bootstrap       clone, then check out the pinned release trees (STEP=$(STEP))"
	@echo "pages-up        start the page keepers"
	@echo "pages-down      stop the page keepers"
	@echo "evaluators-up   start the evaluator stack (one host at a time)"
	@echo "evaluators-down stop the evaluator stack"
	@echo "status          what is running here, and the last batch of each evaluator"
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

handover-in: bootstrap evaluators-up pages-up
	@echo
	@echo "Started here. Before the old host stops, confirm a batch has arrived:"
	@echo "  make status"
	@echo "Then on the old host: make handover-out"

handover-out: evaluators-down
	@echo "Evaluator stack stopped here. Page keepers, if any, are still running: make pages-down"
