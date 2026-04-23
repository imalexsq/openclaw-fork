import path from "node:path";
import type { SpawnResult } from "../process/exec.js";
import type { CronConfig, CronSystemRunAllowEntry } from "../config/types.cron.js";
import type { CronPayload } from "./types.js";

type CronSystemRunPayload = Extract<CronPayload, { kind: "systemRun" }>;

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePrefix(prefix: readonly string[]): string[] {
  return prefix
    .map((value) => normalizeTrimmedString(value))
    .filter((value): value is string => Boolean(value));
}

function argvPrefixMatches(command: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || command.length < prefix.length) {
    return false;
  }
  return prefix.every((value, index) => command[index] === value);
}

function cwdMatches(payloadCwd: string | undefined, cwdPrefix: string | undefined): boolean {
  if (!cwdPrefix) {
    return true;
  }
  if (!payloadCwd) {
    return false;
  }
  const resolvedPayload = path.resolve(payloadCwd);
  const resolvedPrefix = path.resolve(cwdPrefix);
  return (
    resolvedPayload === resolvedPrefix ||
    resolvedPayload.startsWith(`${resolvedPrefix}${path.sep}`)
  );
}

function envMatches(
  payloadEnv: Record<string, string> | undefined,
  envAllowlist: readonly string[] | undefined,
): boolean {
  const keys = Object.keys(payloadEnv ?? {});
  if (keys.length === 0) {
    return true;
  }
  if (!envAllowlist || envAllowlist.length === 0) {
    return false;
  }
  const allowed = new Set(
    envAllowlist
      .map((value) => normalizeTrimmedString(value))
      .filter((value): value is string => Boolean(value)),
  );
  return keys.every((key) => allowed.has(key));
}

function compactOutput(text: string | undefined): string {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(" | ");
  return joined.length > 600 ? `${joined.slice(0, 597)}...` : joined;
}

export function resolveCronSystemRunAllowEntry(params: {
  payload: CronSystemRunPayload;
  cronConfig?: CronConfig;
}): CronSystemRunAllowEntry | null {
  const entries = params.cronConfig?.systemRun?.allow ?? [];
  for (const entry of entries) {
    const argvPrefix = normalizePrefix(entry.argvPrefix);
    if (!argvPrefixMatches(params.payload.command, argvPrefix)) {
      continue;
    }
    if (!cwdMatches(normalizeTrimmedString(params.payload.cwd), entry.cwdPrefix)) {
      continue;
    }
    if (!envMatches(params.payload.env, entry.envAllowlist)) {
      continue;
    }
    return entry;
  }
  return null;
}

export function assertCronSystemRunAllowed(params: {
  payload: CronSystemRunPayload;
  cronConfig?: CronConfig;
}): CronSystemRunAllowEntry {
  const entries = params.cronConfig?.systemRun?.allow ?? [];
  if (entries.length === 0) {
    throw new Error("cron systemRun requires cron.systemRun.allow entries");
  }
  const match = resolveCronSystemRunAllowEntry(params);
  if (!match) {
    throw new Error("cron systemRun command is not allowlisted");
  }
  return match;
}

export function resolveCronSystemRunSummary(params: {
  payload: CronSystemRunPayload;
  status: "ok" | "error";
  stdout?: string;
  stderr?: string;
}): string {
  const summaryPolicy = params.payload.summaryPolicy ?? "stdout";
  const customSummary = normalizeTrimmedString(params.payload.successSummary);
  if (params.status === "ok" && summaryPolicy === "custom" && customSummary) {
    return customSummary;
  }
  const selected =
    summaryPolicy === "stderr"
      ? params.stderr
      : summaryPolicy === "combined"
        ? [params.stdout, params.stderr].filter(Boolean).join("\n")
        : params.stdout;
  const fallback = params.status === "ok" ? params.stderr || params.stdout : params.stderr || params.stdout;
  const compact = compactOutput(selected) || compactOutput(fallback);
  if (compact) {
    return compact;
  }
  if (params.status === "ok") {
    return customSummary ?? "systemRun completed successfully";
  }
  return "systemRun failed";
}

export function resolveCronSystemRunError(result: SpawnResult): string {
  if (result.termination === "timeout" || result.termination === "no-output-timeout") {
    return "cron systemRun timed out";
  }
  const exitCode = typeof result.code === "number" ? result.code : 1;
  const detail = compactOutput(result.stderr) || compactOutput(result.stdout);
  return detail ? `cron systemRun exited with code ${exitCode}: ${detail}` : `cron systemRun exited with code ${exitCode}`;
}
