# Native OpenClaw Cron systemRun Payload With TDD

## Summary

Add a third first-class OpenClaw cron payload kind, `systemRun`, so cron jobs can execute deterministic host commands natively through OpenClaw without going through the model path. This keeps cron fully managed by OpenClaw, preserves future multi-agent scheduling, and removes the current isolated `agentTurn` failure mode for non-conversational jobs like the marketing publish runner.

This should be implemented as a generic OpenClaw capability, not a marketing-only patch. The immediate production use case is the marketing publish scheduler, but the design must support a broader cron pipeline where:

- `systemRun` handles deterministic collection/materialization jobs
- `agentTurn` handles analysis/planning/recommendation jobs
- `systemEvent` remains available for main-session reminder/wake flows

## Key Changes

### 1. Add a new generic cron payload kind

Introduce a new cron payload kind in OpenClaw types, schema validation, normalization, gateway protocol, CLI, and persistence:

- New payload kind: `systemRun`
- Payload should be structured, not shell text
- v1 shape:
  - `kind: "systemRun"`
  - `command: string[]`
  - `cwd?: string`
  - `env?: Record<string, string>`
  - `timeoutSeconds?: number`
  - `summaryPolicy?: "stdout" | "stderr" | "combined" | "custom"`
  - `successSummary?: string`

Defaults:

- `sessionTarget` defaults to `isolated` for `systemRun`
- `delivery.mode` defaults to `none`
- `summaryPolicy` defaults to `stdout`
- `timeoutSeconds` follows the existing cron safety timeout if unset

Constraints:

- `command` must be argv, not shell source
- `systemRun` is valid only for `sessionTarget="isolated"` in v1
- `main` remains `systemEvent` only
- `current` and `session:*` remain unsupported for `systemRun` in v1 unless explicitly added later

### 2. Add native execution safety with allowlisted runner prefixes

Use an allowlist-based policy for `systemRun`.

Add OpenClaw cron config for native command jobs, for example:

- `cron.systemRun.allow`

Each allowlist entry should declare:

- `id`
- `argvPrefix`
- optional `cwdPrefix`
- optional `envAllowlist`
- optional `description`

Execution rules:

- a `systemRun` job is valid only if `command` matches one allowlisted `argvPrefix`
- if `cwd` is set and the allowlist entry defines `cwdPrefix`, it must match
- if `env` is provided, only explicitly allowlisted env keys may be passed
- validation should happen both at add/edit time and again at execution time

For the first production use case, add one allowlisted runner for the marketing scheduler:

- `python3`
- `skills/jewelry-content/scripts/marketing_publish_cron_runner.py`
- marketing workspace cwd prefix
- no arbitrary env passthrough by default

### 3. Add a dedicated systemRun execution path in cron runtime

Extend cron execution so `executeJobCore(...)` supports three runtime paths:

- `systemEvent` for main
- `agentTurn` for agentic isolated/current/session jobs
- `systemRun` for deterministic isolated command jobs

`systemRun` behavior:

- bypass the model entirely
- validate against the allowlist
- execute via OpenClaw-native system run / host execution plumbing, not via shelling outside OpenClaw and not via LLM tool routing
- capture:
  - exit code
  - timed out flag
  - stdout/stderr
  - duration
- produce deterministic cron summaries from actual execution
- never create an agent conversation session for the job

Telemetry/logging expectations:

- summary reflects real command output or configured success summary
- model, provider, and usage are absent for `systemRun`
- `sessionId` / `sessionKey` are absent unless truly required for bookkeeping
- failures are explicit command/runtime failures, not model summaries

### 4. Keep cron orchestration native and future-proof for multi-agent pipelines

Design `systemRun` and cron semantics around the long-term workflow split:

Use `systemRun` for:

- analytics ingestion from Google Analytics, Shopify, Pinterest, Instagram, Microsoft Clarity
- competitor scraping/data collection
- Google Trends and other external trend fetchers
- local snapshot storage, normalization, ETL, rollups, and report materialization

Use `agentTurn` for:

- analyzing analytics snapshots/reports
- analyzing competitor datasets
- identifying trends and opportunities
- planning content, products, campaigns, blog posts, and calendar-aware suggestions

This means OpenClaw cron should remain the native scheduler for mixed pipelines:

1. `systemRun` collector jobs
2. `systemRun` report/materialization jobs
3. `agentTurn` analyst jobs
4. `agentTurn` planner/recommendation jobs

No extra scheduling subsystem should be introduced.

### 5. Wire CLI, gateway, store, and operator UX end to end

Update all cron-facing layers to understand `systemRun`:

- cron types
- gateway protocol schemas
- cron add/edit normalization
- cron service validation
- cron store round-trip
- CLI help text
- list/status rendering
- run-log output
- doctor/validation output where relevant

Operator behavior:

- `openclaw cron add` can create `systemRun` jobs
- `openclaw cron edit` can patch them
- `openclaw cron list` and `status` display them clearly
- `openclaw cron run` executes them natively without model involvement
- model column should be blank/`-` for `systemRun`

### 6. Migrate the marketing scheduler to systemRun

Once the generic payload exists:

- keep job name `marketing-publish-runner`
- keep cadence `*/1 * * * *`
- keep timezone `America/Los_Angeles`
- replace the current `agentTurn` payload with `systemRun`
- command argv should invoke:
  - `python3`
  - `skills/jewelry-content/scripts/marketing_publish_cron_runner.py`
  - `--db-path`
  - the marketing DB path
- keep delivery disabled
- keep all management through `openclaw cron`

Update the helper script so:

- `register` creates/edits a `systemRun` job
- `status` shows enabled state and payload kind
- `run-now` uses `openclaw cron run`
- `disable` remains available

## TDD Plan

### Phase 1: payload model and validation

Add failing tests first for:

- cron schema accepts `payload.kind="systemRun"`
- cron add accepts valid `systemRun`
- cron add rejects:
  - missing command
  - shell-string commands
  - `main + systemRun`
  - unsupported session targets
  - non-allowlisted command prefixes
  - disallowed delivery modes
- cron edit can patch valid `systemRun` jobs

### Phase 2: native execution path

Add failing tests for:

- `executeJobCore` runs `systemRun` without invoking `runIsolatedAgentJob`
- successful command returns `status: "ok"` with deterministic summary
- non-zero exit returns `status: "error"` with real output-based summary
- timeout returns `status: "error"` with timeout message
- telemetry for `systemRun` omits model/provider/usage
- run logs persist correct `systemRun` outcomes

### Phase 3: allowlist enforcement

Add failing tests for:

- allowlisted argv prefix passes
- non-allowlisted prefix fails
- invalid `cwd` fails
- invalid `env` keys fail
- marketing scheduler allowlist permits exactly the intended runner shape

### Phase 4: CLI and gateway behavior

Add failing tests for:

- `openclaw cron add` supports `systemRun`
- `openclaw cron edit` supports `systemRun`
- `openclaw cron list` renders `systemRun` jobs clearly
- CLI help documents `systemRun`
- gateway validators/protocol accept `systemRun`
- model column is empty for `systemRun`

### Phase 5: marketing migration

Add failing tests for:

- marketing helper registers a `systemRun` cron job
- marketing job round-trips through add/list/status/edit
- `openclaw cron run` executes the marketing runner natively
- cron run logs for marketing no longer contain model-written summaries
- marketing dry-run queue is consumed successfully through native cron execution

## Acceptance Tests

- A `systemRun` cron job executes without any model turn.
- Cron run logs for `systemRun` contain actual command execution summaries.
- The marketing publish cron job can be registered, listed, disabled, and manually run entirely through OpenClaw cron management.
- The marketing dry-run scheduler path succeeds via `openclaw cron run`.
- `agentTurn` and `systemEvent` cron behavior remain unchanged.
- The design cleanly supports future `systemRun` collectors plus `agentTurn` analysts/planners in the same OpenClaw cron ecosystem.

## Assumptions and Defaults

- The new payload is generic and reusable.
- Safety is allowlist-based, not arbitrary command execution.
- `systemRun` is isolated-only in v1.
- `systemRun` uses argv arrays, not shell strings.
- `systemRun` delivery defaults to `none`; announced output is out of scope for v1.
- Future analytics ingestion, competitor scraping, and report materialization should use `systemRun`.
- Future analysis and planning agents should use `agentTurn`.
- The marketing live publish smoke test remains blocked until platform secrets are configured.

## Progress Log

- 2026-04-08: Captured the canonical `systemRun` implementation plan from the user and stored it in the repo so ongoing implementation progress can be tracked in one file.
- 2026-04-08: Audited the current workspace against the plan. Confirmed the generic `systemRun` source work exists across cron payload types, config/schema validation, allowlist helpers, gateway runtime dispatch, CLI add/edit support, and targeted tests. Also confirmed the marketing helper script and local `openclaw.json` allowlist are migrated to `systemRun`, but the currently persisted local cron job `marketing-publish-runner` is still a disabled `agentTurn` job with message `mkt:cron:run`, so the live/store migration has not yet been applied end to end. Targeted vitest execution could not be run from this shell because local `pnpm` requires Node `>=18.12` while the host shell is on Node `v16.20.2`.
- 2026-04-08: Marked plan progress by phase after the source audit:
  - Phase 1 appears implemented in source: payload types, normalization, schema validation, and isolated-only enforcement for `systemRun`.
  - Phase 2 appears implemented in source: cron runtime dispatch now has a native `systemRun` path that bypasses `runIsolatedAgentJob` and executes allowlisted commands through the gateway cron service.
  - Phase 3 appears implemented in source: `cron.systemRun.allow` config, argv/cwd/env allowlist checks, and summary/error helpers are present.
  - Phase 4 appears largely implemented in source: gateway protocol schema plus `openclaw cron add` and `openclaw cron edit` support for `systemRun` are present.
  - Phase 5 is only partially complete: the marketing helper script and local allowlist are migrated, but the locally persisted cron job still remains the older disabled `agentTurn` registration rather than a stored `systemRun` job.

## Current Status

- Completed in the working tree:
  - Generic cron payload, config, allowlist, CLI, gateway, and native runtime support for `systemRun`
  - Targeted source tests for allowlisting, normalization, CLI add/edit, validator coverage, and native gateway execution
  - Marketing helper migration to register `systemRun` jobs
  - Local `openclaw.json` allowlist entry for the marketing scheduler runner
- Still incomplete:
  - The locally stored cron job `marketing-publish-runner` in `~/.openclaw/cron/jobs.json` is still a disabled `agentTurn` job using `mkt:cron:run`
  - End-to-end local/live migration is not complete until that stored job is recreated or edited into `systemRun` form and then validated through native cron execution
  - Runtime test execution from this shell is blocked because the host has Node `v16.20.2` while installed `pnpm` requires Node `>=18.12`
