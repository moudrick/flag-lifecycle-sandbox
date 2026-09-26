# Runtime traffic workspace

`recreate` and `refresh` write ignored `sdk-keys.env` and shallow-clone the three generated public repositories into ignored `repos/`. Neither generated artifact belongs in Git.

Start all twelve services at the safe default, including the 1200 evaluations/hour orders-production probe:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml up --detach --build
```

Inspect all states, compact summaries, and resource use:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml ps --all
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml logs --tail 20 --timestamps
docker stats --no-stream
```

To run only the probe, set `DEMO_EVALUATIONS_PER_HOUR` to an integer from 10 through 100000 and optionally set `DEMO_CONTEXT_POOL_SIZE` from 1 through 10000, then start `orders-production`. The 100000 setting is an explicit short stress test, never the default.

```bash
DEMO_EVALUATIONS_PER_HOUR=1200 \
DEMO_CONTEXT_POOL_SIZE=1000 \
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml \
  up --detach --build orders-production
```

Stop traffic before `recreate`, `refresh`, or `destroy`:

```bash
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml down
```

Stopping and restarting Compose preserves evaluations. `refresh` also preserves them. `recreate` and `destroy` delete the project-scoped history, but account-level usage and audit observations may remain.

## Page keepers

`compose.pages.yaml` holds the published archive-writer page open for one flag each, so those flags keep accruing evaluations. A keeper carries no SDK key, opens no service connection, and uses one fixed context, so it costs one monthly active context however many keepers run.

```bash
make pages-up
make pages-ps
make pages-down
```

The stage and reserve flags are the defaults. Override with `PAGE_STAGE_FLAG` and `PAGE_RESERVE_FLAG`. A keeper refuses a URL without an explicit `flag=`, and refuses any URL that names or configures a failover flag: the page falls back to its compiled-in pair when no flag is given, and on that path a failed connection evaluates the failover flag.

Keepers are safe to run on several hosts at once. The evaluator stack is not.

## Running on another host

The runtime is host-independent. Evaluation history lives in the LaunchDarkly project, so moving hosts keeps it. What a fresh clone needs:

1. Docker, and Node.js only for the bootstrap step.
2. Ignored `.env` with the two non-secret settings `GH_ORG` and `LD_PROJECT_KEY`.
3. Ignored `runtime/sdk-keys.env` with `DEMO_GENERATION_ID`, `LD_EVALUATION_SDK_KEY_PRODUCTION`, `LD_EVALUATION_SDK_KEY_STAGING`, `LD_EVALUATION_SDK_KEY_TEST`, `LD_EVALUATION_SDK_KEY_DEV`. Copy it from the host that has it; never commit it. The generation id is part of every context key, so copy the file rather than generating a new one.
4. `make bootstrap`, which shallow-clones the service repositories over token-free HTTPS and checks out the pinned release trees into ignored `repos/` and `worktrees/`.
5. `make evaluators-up`.

`make doctor` reports what a host is missing before anything starts.

### "Run recreate or refresh first"

A fresh clone has no `runtime/repos/`, and `scenario compose` says so with a message naming `recreate` or `refresh`. **During a campaign, neither is the right answer:**

- `recreate` deletes the LaunchDarkly project and the owned repositories: flag age, evaluations, contexts and repository history all go.
- `refresh` keeps the project but deletes and recreates the repositories, which destroys their history and restarts code-search indexing.

Both refuse while `CAMPAIGN_LOCK=true`, and that lock exists for this reason. What a fresh host actually lacks is the clones, which `make clone` provides without a token and without touching anything remote.

### Handover, without a gap

**Exactly one host runs the evaluator stack.** Two hosts running the same services double the evaluations and the service-connection minutes, and connection cost is not linear in container count.

On the new host:

```bash
make handover-in     # bootstrap, start evaluators and keepers
make status          # wait until each evaluator shows a batch, about 5 minutes
```

Then on the old host:

```bash
make handover-out    # stops the evaluator stack only
make pages-down      # if it was also keeping pages
```

A few minutes of overlap costs a negligible amount of budget and duplicates a few evaluations. A gap costs a visible hole in every chart, so overlap is the safer order.

### Hosts without make

Windows without make runs the same two commands directly:

```bash
docker compose -f runtime/compose.pages.yaml up --detach --build
docker compose --env-file runtime/sdk-keys.env -f runtime/compose.yaml up --detach --build
```
