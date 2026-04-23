import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logVerbose } from "../../globals.js";
import { runExec } from "../../process/exec.js";
import type { CommandHandler } from "./commands-types.js";

type MarketingCallbackCommand =
  | { action: "approve"; platform: string; submissionId: number; contentId: number }
  | { action: "reject"; platform: string; submissionId: number; contentId: number }
  | { action: "queue"; mode: "dry" | "live"; submissionId: number; contentId: number }
  | { action: "status"; submissionId: number; contentId: number }
  | { action: "reschedule"; platform: string; submissionId: number; contentId: number }
  | { action: "debug"; label: string };

type CallbackResult = {
  ok?: boolean;
  action?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
};

type GoFlowResult = {
  assistant_reply?: string;
  message?: string;
  submission_id?: number;
  content_id?: number;
  [key: string]: unknown;
};

type RefinementResult = {
  matched?: boolean;
  assistant_reply?: string;
  message?: string;
  submission_id?: number;
  content_id?: number;
  platform?: string;
  [key: string]: unknown;
};

function parseInteger(raw: string): number {
  return Number.parseInt(raw, 10);
}

export function extractMarketingCallbackPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^(?:mkt:)?(?:approve|reject|queue|status|resched|debug):/i.test(lines[index])) {
      return lines[index];
    }
  }
  const inlineMatches = trimmed.match(
    /(?:mkt:)?(?:approve:[a-z0-9_]+:\d+:\d+|reject:[a-z0-9_]+:\d+:\d+|queue:(?:dry|live):\d+:\d+|status:\d+:\d+|resched:[a-z0-9_]+:\d+:\d+|debug:[a-z0-9_]+)/gi,
  );
  if (inlineMatches && inlineMatches.length > 0) {
    return inlineMatches[inlineMatches.length - 1];
  }
  return /^(?:mkt:)?(?:approve|reject|queue|status|resched|debug):/i.test(trimmed)
    ? trimmed
    : null;
}

export function parseMarketingCallbackCommand(raw: string): MarketingCallbackCommand | null {
  const trimmed = extractMarketingCallbackPayload(raw);
  if (!trimmed) {
    return null;
  }
  let match = trimmed.match(/^(?:mkt:)?approve:([a-z0-9_]+):(\d+):(\d+)$/i);
  if (match) {
    return {
      action: "approve",
      platform: match[1].toLowerCase(),
      submissionId: parseInteger(match[2]),
      contentId: parseInteger(match[3]),
    };
  }
  match = trimmed.match(/^(?:mkt:)?reject:([a-z0-9_]+):(\d+):(\d+)$/i);
  if (match) {
    return {
      action: "reject",
      platform: match[1].toLowerCase(),
      submissionId: parseInteger(match[2]),
      contentId: parseInteger(match[3]),
    };
  }
  match = trimmed.match(/^(?:mkt:)?queue:(dry|live):(\d+):(\d+)$/i);
  if (match) {
    return {
      action: "queue",
      mode: match[1].toLowerCase() as "dry" | "live",
      submissionId: parseInteger(match[2]),
      contentId: parseInteger(match[3]),
    };
  }
  match = trimmed.match(/^(?:mkt:)?status:(\d+):(\d+)$/i);
  if (match) {
    return {
      action: "status",
      submissionId: parseInteger(match[1]),
      contentId: parseInteger(match[2]),
    };
  }
  match = trimmed.match(/^(?:mkt:)?resched:([a-z0-9_]+):(\d+):(\d+)$/i);
  if (match) {
    return {
      action: "reschedule",
      platform: match[1].toLowerCase(),
      submissionId: parseInteger(match[2]),
      contentId: parseInteger(match[3]),
    };
  }
  match = trimmed.match(/^(?:mkt:)?debug:([a-z0-9_]+)$/i);
  if (match) {
    return {
      action: "debug",
      label: match[1].toLowerCase(),
    };
  }
  return null;
}

export function isMarketingCallbackCommand(raw: string): boolean {
  return parseMarketingCallbackCommand(raw) !== null;
}

export function isMarketingGoTrigger(raw: string): boolean {
  return /^(?:create|go)[.! ]*$/i.test(raw.trim());
}

export function extractMarketingCronPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/\bmkt:cron:run\b/i);
    if (match) {
      return "mkt:cron:run";
    }
  }
  return /\bmkt:cron:run\b/i.test(trimmed) ? "mkt:cron:run" : null;
}

export function isMarketingCronTrigger(raw: string): boolean {
  return extractMarketingCronPayload(raw) !== null;
}

export function isPotentialMarketingRefinementInput(raw: string, workspaceDir?: string): boolean {
  if (workspaceDir) {
    const scriptPath = path.join(
      workspaceDir,
      "skills",
      "jewelry-content",
      "scripts",
      "refine_content.py",
    );
    if (!fs.existsSync(scriptPath)) {
      return false;
    }
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return false;
  }
  if (isMarketingGoTrigger(trimmed)) {
    return false;
  }
  if (extractMarketingCallbackPayload(trimmed) !== null) {
    return false;
  }
  return true;
}

function hasMarketingGoScripts(params: Parameters<CommandHandler>[0]): boolean {
  const scriptDir = path.join(params.workspaceDir, "skills", "jewelry-content", "scripts");
  return (
    fs.existsSync(path.join(scriptDir, "go_flow.py")) &&
    fs.existsSync(path.join(scriptDir, "send_review_cards.py"))
  );
}

function hasMarketingRefinementScript(params: Parameters<CommandHandler>[0]): boolean {
  return fs.existsSync(
    path.join(params.workspaceDir, "skills", "jewelry-content", "scripts", "refine_content.py"),
  );
}

function hasMarketingCronScript(params: Parameters<CommandHandler>[0]): boolean {
  return fs.existsSync(
    path.join(
      params.workspaceDir,
      "skills",
      "jewelry-content",
      "scripts",
      "marketing_publish_cron_runner.py",
    ),
  );
}

function resolveActorLabel(params: Parameters<CommandHandler>[0]): string {
  const pieces = [params.command.channel];
  if (params.ctx.SenderName) {
    pieces.push(params.ctx.SenderName);
  } else if (params.ctx.SenderUsername) {
    pieces.push(params.ctx.SenderUsername);
  } else if (params.command.senderId) {
    pieces.push(params.command.senderId);
  }
  return pieces.filter(Boolean).join(":");
}

function extractExecErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      return stderr.trim();
    }
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim()) {
      return stdout.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

async function runMarketingCallback(params: Parameters<CommandHandler>[0]): Promise<CallbackResult> {
  const payload = extractMarketingCallbackPayload(params.command.commandBodyNormalized);
  if (!payload) {
    throw new Error("Marketing callback payload not found in message body");
  }
  const parsed = parseMarketingCallbackCommand(payload);
  if (parsed?.action === "debug") {
    return {
      ok: true,
      action: "debug",
      message: `Debug callback received: ${parsed.label}.`,
    };
  }
  const scriptPath = path.join(
    params.workspaceDir,
    "skills",
    "jewelry-content",
    "scripts",
    "publish_content.py",
  );
  const dbPath = path.join(params.workspaceDir, "data", "submissions.db");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Marketing callback runner not found at ${scriptPath}`);
  }
  const argv = [
    scriptPath,
    "--db-path",
    dbPath,
    "callback",
    "--payload",
    payload,
    "--actor",
    resolveActorLabel(params),
  ];
  const targetChatId = params.ctx.OriginatingTo ?? params.command.to ?? params.ctx.To;
  if (targetChatId) {
    argv.push("--telegram-chat-id", String(targetChatId));
  }
  if (params.ctx.MessageThreadId !== undefined && params.ctx.MessageThreadId !== null) {
    argv.push("--telegram-thread-id", String(params.ctx.MessageThreadId));
  }
  const { stdout } = await runExec("python3", argv, {
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024,
    cwd: params.workspaceDir,
  });
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as CallbackResult;
  } catch (error) {
    throw new Error(
      `Marketing callback runner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runMarketingGoFlow(params: Parameters<CommandHandler>[0]): Promise<GoFlowResult> {
  const rootCtx = params.rootCtx ?? params.ctx;
  const scriptPath = path.join(
    params.workspaceDir,
    "skills",
    "jewelry-content",
    "scripts",
    "go_flow.py",
  );
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Marketing go-flow runner not found at ${scriptPath}`);
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-marketing-go-"));
  const contextPath = path.join(tmpDir, "context.json");
  const targetChatId = rootCtx.OriginatingTo ?? params.command.to ?? rootCtx.To;
  const sessionFile = params.sessionEntry?.sessionFile ?? params.previousSessionEntry?.sessionFile;
  const contextPayload = {
    body: rootCtx.Body,
    body_for_agent: rootCtx.BodyForAgent,
    command_body: params.command.commandBodyNormalized,
    raw_body: rootCtx.RawBody,
    transcript: rootCtx.Transcript,
    media_path: rootCtx.MediaPath,
    media_paths: rootCtx.MediaPaths,
    media_understanding: rootCtx.MediaUnderstanding,
    history: rootCtx.InboundHistory,
    target_chat_id: targetChatId ? String(targetChatId) : undefined,
    thread_id:
      rootCtx.MessageThreadId !== undefined && rootCtx.MessageThreadId !== null
        ? String(rootCtx.MessageThreadId)
        : undefined,
    session_file: sessionFile,
    session_id: params.sessionEntry?.sessionId ?? params.previousSessionEntry?.sessionId,
    sender_name: rootCtx.SenderName,
    sender_id: rootCtx.SenderId,
  };

  await fs.promises.writeFile(contextPath, JSON.stringify(contextPayload, null, 2), "utf-8");
  try {
    const argv = [
      scriptPath,
      "--context-json-file",
      contextPath,
      "--db-path",
      path.join(params.workspaceDir, "data", "submissions.db"),
      "--config-path",
      path.join(path.dirname(params.workspaceDir), "openclaw.json"),
    ];
    if (targetChatId) {
      argv.push("--target-chat-id", String(targetChatId));
    }
    if (rootCtx.MessageThreadId !== undefined && rootCtx.MessageThreadId !== null) {
      argv.push("--thread-id", String(rootCtx.MessageThreadId));
    }

    const { stdout } = await runExec("python3", argv, {
      timeoutMs: 180_000,
      maxBuffer: 5 * 1024 * 1024,
      cwd: params.workspaceDir,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed) as GoFlowResult;
    } catch (error) {
      throw new Error(
        `Marketing go-flow runner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runMarketingRefinementFlow(
  params: Parameters<CommandHandler>[0],
): Promise<RefinementResult> {
  const rootCtx = params.rootCtx ?? params.ctx;
  const scriptPath = path.join(
    params.workspaceDir,
    "skills",
    "jewelry-content",
    "scripts",
    "refine_content.py",
  );
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Marketing refinement runner not found at ${scriptPath}`);
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-marketing-refine-"));
  const contextPath = path.join(tmpDir, "context.json");
  const targetChatId = rootCtx.OriginatingTo ?? params.command.to ?? rootCtx.To;
  const contextPayload = {
    body: rootCtx.Body,
    body_for_agent: rootCtx.BodyForAgent,
    command_body: params.command.commandBodyNormalized,
    raw_body: rootCtx.RawBody,
    transcript: rootCtx.Transcript,
    target_chat_id: targetChatId ? String(targetChatId) : undefined,
    thread_id:
      rootCtx.MessageThreadId !== undefined && rootCtx.MessageThreadId !== null
        ? String(rootCtx.MessageThreadId)
        : undefined,
    sender_name: rootCtx.SenderName,
    sender_id: rootCtx.SenderId,
  };

  await fs.promises.writeFile(contextPath, JSON.stringify(contextPayload, null, 2), "utf-8");
  try {
    const argv = [
      scriptPath,
      "--context-json-file",
      contextPath,
      "--db-path",
      path.join(params.workspaceDir, "data", "submissions.db"),
      "--config-path",
      path.join(path.dirname(params.workspaceDir), "openclaw.json"),
    ];
    const { stdout } = await runExec("python3", argv, {
      timeoutMs: 180_000,
      maxBuffer: 5 * 1024 * 1024,
      cwd: params.workspaceDir,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed) as RefinementResult;
    } catch (error) {
      throw new Error(
        `Marketing refinement runner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runMarketingCronFlow(params: Parameters<CommandHandler>[0]): Promise<string> {
  const scriptPath = path.join(
    params.workspaceDir,
    "skills",
    "jewelry-content",
    "scripts",
    "marketing_publish_cron_runner.py",
  );
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Marketing cron runner not found at ${scriptPath}`);
  }
  const { stdout } = await runExec(
    "python3",
    [
      scriptPath,
      "--db-path",
      path.join(params.workspaceDir, "data", "submissions.db"),
    ],
    {
      timeoutMs: 180_000,
      maxBuffer: 5 * 1024 * 1024,
      cwd: params.workspaceDir,
    },
  );
  return stdout.trim();
}

export const handleMarketingCallbackCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseMarketingCallbackCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring marketing callback from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  try {
    const result = await runMarketingCallback(params);
    const replyText =
      typeof result.message === "string" && result.message.trim()
        ? result.message.trim()
        : "Marketing action processed.";
    return {
      shouldContinue: false,
      reply: { text: replyText },
    };
  } catch (error) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Marketing action failed: ${extractExecErrorMessage(error)}`,
      },
    };
  }
};

export const handleMarketingGoCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (!isMarketingGoTrigger(params.command.commandBodyNormalized)) {
    return null;
  }
  if (!hasMarketingGoScripts(params)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring marketing go trigger from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  try {
    const result = await runMarketingGoFlow(params);
    const assistantReply =
      typeof result.assistant_reply === "string" ? result.assistant_reply.trim() : "";
    if (!assistantReply || assistantReply === "NO_REPLY") {
      return { shouldContinue: false, reply: undefined };
    }
    return {
      shouldContinue: false,
      reply: {
        text: assistantReply,
      },
    };
  } catch (error) {
    return {
      shouldContinue: false,
      reply: {
        text: `I could not generate the review cards right now: ${extractExecErrorMessage(error)}`,
      },
    };
  }
};

export const handleMarketingCronCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!isMarketingCronTrigger(params.command.commandBodyNormalized)) {
    return null;
  }
  if (!hasMarketingCronScript(params)) {
    return null;
  }
  try {
    const output = await runMarketingCronFlow(params);
    return {
      shouldContinue: false,
      reply: output ? { text: output } : undefined,
    };
  } catch (error) {
    return {
      shouldContinue: false,
      reply: {
        text: `Marketing publish scheduler failed: ${extractExecErrorMessage(error)}`,
      },
    };
  }
};

export const handleMarketingRefinementCommand: CommandHandler = async (
  params,
  allowTextCommands,
) => {
  if (!allowTextCommands) {
    return null;
  }
  if (!isPotentialMarketingRefinementInput(params.command.commandBodyNormalized)) {
    return null;
  }
  if (!hasMarketingRefinementScript(params)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    return null;
  }
  try {
    const result = await runMarketingRefinementFlow(params);
    if (!result.matched) {
      return null;
    }
    const assistantReply =
      typeof result.assistant_reply === "string" ? result.assistant_reply.trim() : "";
    if (!assistantReply || assistantReply === "NO_REPLY") {
      return { shouldContinue: false, reply: undefined };
    }
    return {
      shouldContinue: false,
      reply: {
        text: assistantReply,
      },
    };
  } catch (error) {
    return {
      shouldContinue: false,
      reply: {
        text: `I could not refresh the rejected draft right now: ${extractExecErrorMessage(error)}`,
      },
    };
  }
};
