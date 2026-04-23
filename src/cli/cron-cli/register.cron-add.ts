import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parsePositiveIntOrUndefined } from "../program/helpers.js";
import { resolveCronCreateSchedule } from "./schedule-options.js";
import {
  getCronChannelOptions,
  handleCronCliError,
  printCronJson,
  printCronList,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

function parseJsonArrayOfStrings(raw: unknown, flagName: string): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${flagName} requires a JSON array of strings`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${flagName} must be valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error(`${flagName} requires a non-empty JSON array of strings`);
  }
  return parsed.map((value) => String(value).trim());
}

function parseJsonStringRecord(raw: unknown, flagName: string): Record<string, string> {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${flagName} requires a JSON object of string values`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${flagName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flagName} requires a JSON object of string values`);
  }
  const entries = Object.entries(parsed).map(([key, value]) => {
    if (typeof value !== "string") {
      throw new Error(`${flagName} requires all env values to be strings`);
    }
    return [key, value] as const;
  });
  return Object.fromEntries(entries);
}

export function registerCronStatusCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("status")
      .description("Show cron scheduler status")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.status", opts, {});
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronListCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("list")
      .description("List cron jobs")
      .option("--all", "Include disabled jobs", false)
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.list", opts, {
            includeDisabled: Boolean(opts.all),
          });
          if (opts.json) {
            printCronJson(res);
            return;
          }
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          printCronList(jobs, defaultRuntime);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerCronAddCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("add")
      .alias("create")
      .description("Add a cron job")
      .requiredOption("--name <name>", "Job name")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create job disabled", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
      .option("--agent <id>", "Agent id for this job")
      .option("--session <target>", "Session target (main|isolated)")
      .option("--session-key <key>", "Session key for job routing (e.g. agent:my-agent:my-session)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now")
      .option(
        "--at <when>",
        "Run once at time (ISO with offset, or +duration). Use --tz for offset-less datetimes",
      )
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)", "")
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option("--system-run-command-json <json>", "systemRun argv payload as JSON array")
      .option("--cwd <dir>", "Working directory for systemRun jobs")
      .option("--env-json <json>", "Environment variables for systemRun jobs as JSON object")
      .option("--summary-policy <policy>", "systemRun summary policy (stdout|stderr|combined|custom)")
      .option("--success-summary <text>", "Fixed success summary for systemRun jobs")
      .option(
        "--thinking <level>",
        "Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)",
      )
      .option("--model <model>", "Model override for agent jobs (provider/model or alias)")
      .option("--timeout-seconds <n>", "Timeout seconds for agentTurn/systemRun jobs")
      .option("--light-context", "Use lightweight bootstrap context for agent jobs", false)
      .option("--announce", "Announce summary to a chat (subagent-style)", false)
      .option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.")
      .option("--no-deliver", "Disable announce delivery and skip main-session summary")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--account <id>", "Channel account id for delivery (multi-account setups)")
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)
      .option("--json", "Output JSON", false)
      .action(async (opts: GatewayRpcOpts & Record<string, unknown>, cmd?: Command) => {
        try {
          const schedule = resolveCronCreateSchedule({
            at: opts.at,
            cron: opts.cron,
            every: opts.every,
            exact: opts.exact,
            stagger: opts.stagger,
            tz: opts.tz,
          });

          const wakeModeRaw = typeof opts.wake === "string" ? opts.wake : "now";
          const wakeMode = wakeModeRaw.trim() || "now";
          if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
            throw new Error("--wake must be now or next-heartbeat");
          }

          const agentId =
            typeof opts.agent === "string" && opts.agent.trim()
              ? sanitizeAgentId(opts.agent.trim())
              : undefined;

          const hasAnnounce = Boolean(opts.announce) || opts.deliver === true;
          const hasNoDeliver = opts.deliver === false;
          const deliveryFlagCount = [hasAnnounce, hasNoDeliver].filter(Boolean).length;
          if (deliveryFlagCount > 1) {
            throw new Error("Choose at most one of --announce or --no-deliver");
          }

          const payload = (() => {
            const systemEvent = typeof opts.systemEvent === "string" ? opts.systemEvent.trim() : "";
            const message = typeof opts.message === "string" ? opts.message.trim() : "";
            const systemRunCommandJson =
              typeof opts.systemRunCommandJson === "string" ? opts.systemRunCommandJson.trim() : "";
            const chosen = [Boolean(systemEvent), Boolean(message), Boolean(systemRunCommandJson)].filter(Boolean).length;
            if (chosen !== 1) {
              throw new Error(
                "Choose exactly one payload: --system-event, --message, or --system-run-command-json",
              );
            }
            if (systemEvent) {
              return { kind: "systemEvent" as const, text: systemEvent };
            }
            const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
            if (systemRunCommandJson) {
              const summaryPolicyRaw =
                typeof opts.summaryPolicy === "string" ? opts.summaryPolicy.trim().toLowerCase() : "";
              if (
                summaryPolicyRaw &&
                !["stdout", "stderr", "combined", "custom"].includes(summaryPolicyRaw)
              ) {
                throw new Error(
                  "--summary-policy must be one of stdout, stderr, combined, or custom",
                );
              }
              return {
                kind: "systemRun" as const,
                command: parseJsonArrayOfStrings(systemRunCommandJson, "--system-run-command-json"),
                cwd:
                  typeof opts.cwd === "string" && opts.cwd.trim() ? opts.cwd.trim() : undefined,
                env: typeof opts.envJson === "string" ? parseJsonStringRecord(opts.envJson, "--env-json") : undefined,
                timeoutSeconds:
                  timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
                summaryPolicy: summaryPolicyRaw || undefined,
                successSummary:
                  typeof opts.successSummary === "string" && opts.successSummary.trim()
                    ? opts.successSummary.trim()
                    : undefined,
              };
            }
            return {
              kind: "agentTurn" as const,
              message,
              model:
                typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : undefined,
              thinking:
                typeof opts.thinking === "string" && opts.thinking.trim()
                  ? opts.thinking.trim()
                  : undefined,
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
              lightContext: opts.lightContext === true ? true : undefined,
            };
          })();

          const optionSource =
            typeof cmd?.getOptionValueSource === "function"
              ? (name: string) => cmd.getOptionValueSource(name)
              : () => undefined;
          const sessionSource = optionSource("session");
          const sessionTargetRaw = typeof opts.session === "string" ? opts.session.trim() : "";
          const inferredSessionTarget =
            payload.kind === "systemEvent" ? "main" : "isolated";
          const sessionTarget =
            sessionSource === "cli" ? sessionTargetRaw || "" : inferredSessionTarget;
          const isCustomSessionTarget =
            sessionTarget.toLowerCase().startsWith("session:") &&
            sessionTarget.slice(8).trim().length > 0;
          const isIsolatedLikeSessionTarget =
            sessionTarget === "isolated" || sessionTarget === "current" || isCustomSessionTarget;
          if (sessionTarget !== "main" && !isIsolatedLikeSessionTarget) {
            throw new Error("--session must be main, isolated, current, or session:<id>");
          }

          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new Error("Choose --delete-after-run or --keep-after-run, not both");
          }

          if (sessionTarget === "main" && payload.kind !== "systemEvent") {
            throw new Error("Main jobs require --system-event (systemEvent).");
          }
          if (
            isIsolatedLikeSessionTarget &&
            payload.kind !== "agentTurn" &&
            payload.kind !== "systemRun"
          ) {
            throw new Error(
              "Isolated jobs require --message (agentTurn) or --system-run-command-json (systemRun).",
            );
          }
          if (
            payload.kind === "systemRun" &&
            sessionTarget !== "isolated"
          ) {
            throw new Error("systemRun jobs currently require --session isolated.");
          }
          if (
            (opts.announce || typeof opts.deliver === "boolean") &&
            (!isIsolatedLikeSessionTarget || payload.kind !== "agentTurn")
          ) {
            throw new Error("--announce/--no-deliver require a non-main agentTurn session target.");
          }
          if (
            payload.kind !== "systemRun" &&
            (typeof opts.cwd === "string" ||
              typeof opts.envJson === "string" ||
              typeof opts.summaryPolicy === "string" ||
              typeof opts.successSummary === "string")
          ) {
            throw new Error(
              "--cwd, --env-json, --summary-policy, and --success-summary require --system-run-command-json",
            );
          }

          const accountId =
            typeof opts.account === "string" && opts.account.trim()
              ? opts.account.trim()
              : undefined;

          if (accountId && (!isIsolatedLikeSessionTarget || payload.kind !== "agentTurn")) {
            throw new Error("--account requires a non-main agentTurn job with delivery.");
          }

          const deliveryMode =
            isIsolatedLikeSessionTarget && payload.kind === "agentTurn"
              ? hasAnnounce
                ? "announce"
                : hasNoDeliver
                  ? "none"
                  : "announce"
              : undefined;

          const nameRaw = typeof opts.name === "string" ? opts.name : "";
          const name = nameRaw.trim();
          if (!name) {
            throw new Error("--name is required");
          }

          const description =
            typeof opts.description === "string" && opts.description.trim()
              ? opts.description.trim()
              : undefined;

          const sessionKey =
            typeof opts.sessionKey === "string" && opts.sessionKey.trim()
              ? opts.sessionKey.trim()
              : undefined;

          const params = {
            name,
            description,
            enabled: !opts.disabled,
            deleteAfterRun: opts.deleteAfterRun ? true : opts.keepAfterRun ? false : undefined,
            agentId,
            sessionKey,
            schedule,
            sessionTarget,
            wakeMode,
            payload,
            delivery: deliveryMode
              ? {
                  mode: deliveryMode,
                  channel:
                    typeof opts.channel === "string" && opts.channel.trim()
                      ? opts.channel.trim()
                      : undefined,
                  to: typeof opts.to === "string" && opts.to.trim() ? opts.to.trim() : undefined,
                  accountId,
                  bestEffort: opts.bestEffortDeliver ? true : undefined,
                }
              : undefined,
          };

          const res = await callGatewayFromCli("cron.add", opts, params);
          printCronJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
