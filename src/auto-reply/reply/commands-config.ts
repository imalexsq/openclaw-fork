import { resolveConfigWriteTargetFromPath } from "../../channels/plugins/config-writes.js";
import { normalizeChannelId } from "../../channels/registry.js";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import {
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "../../config/runtime-overrides.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parseConfigCommand } from "./config-commands.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";
import { parseDebugCommand } from "./debug-commands.js";

type TelegramDebugButton = {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
};

type TelegramDebugButtonRow = TelegramDebugButton[];

function buildDebugButtonsKeyboard(): TelegramDebugButtonRow[] {
  return [[{ text: "Ack", callback_data: "/debug buttons ack", style: "success" }]];
}

function buildDebugReviewCardKeyboard(): TelegramDebugButtonRow[] {
  return [
    [
      { text: "Approve", callback_data: "/debug reviewcard approve", style: "success" },
      { text: "Reject", callback_data: "/debug reviewcard reject", style: "danger" },
    ],
    [
      { text: "Queue Live", callback_data: "/debug reviewcard live", style: "primary" },
    ],
    [
      { text: "Status", callback_data: "/debug reviewcard status" },
      { text: "Reschedule", callback_data: "/debug reviewcard reschedule" },
    ],
  ];
}

export const handleConfigCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const configCommand = parseConfigCommand(params.command.commandBodyNormalized);
  if (!configCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/config");
  if (unauthorized) {
    return unauthorized;
  }
  const allowInternalReadOnlyShow =
    configCommand.action === "show" && isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnlyShow ? null : rejectNonOwnerCommand(params, "/config");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/config",
    configKey: "config",
  });
  if (disabled) {
    return disabled;
  }
  if (configCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${configCommand.message}` },
    };
  }

  let parsedWritePath: string[] | undefined;
  if (configCommand.action === "set" || configCommand.action === "unset") {
    const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
      label: "/config write",
      allowedScopes: ["operator.admin"],
      missingText: "❌ /config set|unset requires operator.admin for gateway clients.",
    });
    if (missingAdminScope) {
      return missingAdminScope;
    }
    const parsedPath = parseConfigPath(configCommand.path);
    if (!parsedPath.ok || !parsedPath.path) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
      };
    }
    parsedWritePath = parsedPath.path;
    const channelId = params.command.channelId ?? normalizeChannelId(params.command.channel);
    const deniedText = resolveConfigWriteDeniedText({
      cfg: params.cfg,
      channel: params.command.channel,
      channelId,
      accountId: params.ctx.AccountId,
      gatewayClientScopes: params.ctx.GatewayClientScopes,
      target: resolveConfigWriteTargetFromPath(parsedWritePath),
    });
    if (deniedText) {
      return {
        shouldContinue: false,
        reply: {
          text: deniedText,
        },
      };
    }
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Config file is invalid; fix it before using /config.",
      },
    };
  }
  const parsedBase = structuredClone(snapshot.parsed as Record<string, unknown>);

  if (configCommand.action === "show") {
    const pathRaw = configCommand.path?.trim();
    if (pathRaw) {
      const parsedPath = parseConfigPath(pathRaw);
      if (!parsedPath.ok || !parsedPath.path) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
        };
      }
      const value = getConfigValueAtPath(parsedBase, parsedPath.path);
      const rendered = JSON.stringify(value ?? null, null, 2);
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ Config ${pathRaw}:\n\`\`\`json\n${rendered}\n\`\`\``,
        },
      };
    }
    const json = JSON.stringify(parsedBase, null, 2);
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Config (raw):\n\`\`\`json\n${json}\n\`\`\`` },
    };
  }

  if (configCommand.action === "unset") {
    const removed = unsetConfigValueAtPath(parsedBase, parsedWritePath ?? []);
    if (!removed) {
      return {
        shouldContinue: false,
        reply: { text: `⚙️ No config value found for ${configCommand.path}.` },
      };
    }
    const validated = validateConfigObjectWithPlugins(parsedBase);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ Config invalid after unset (${issue.path}: ${issue.message}).`,
        },
      };
    }
    await writeConfigFile(validated.config);
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Config updated: ${configCommand.path} removed.` },
    };
  }

  if (configCommand.action === "set") {
    setConfigValueAtPath(parsedBase, parsedWritePath ?? [], configCommand.value);
    const validated = validateConfigObjectWithPlugins(parsedBase);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ Config invalid after set (${issue.path}: ${issue.message}).`,
        },
      };
    }
    await writeConfigFile(validated.config);
    const valueLabel =
      typeof configCommand.value === "string"
        ? `"${configCommand.value}"`
        : JSON.stringify(configCommand.value);
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Config updated: ${configCommand.path}=${valueLabel ?? "null"}`,
      },
    };
  }

  return null;
};

export const handleDebugCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const debugCommand = parseDebugCommand(params.command.commandBodyNormalized);
  if (!debugCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/debug");
  if (unauthorized) {
    return unauthorized;
  }
  const nonOwner = rejectNonOwnerCommand(params, "/debug");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/debug",
    configKey: "debug",
  });
  if (disabled) {
    return disabled;
  }
  if (debugCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${debugCommand.message}` },
    };
  }
  const isTelegram =
    normalizeChannelId(params.command.channel) === "telegram" || params.command.surface === "telegram";
  if (debugCommand.action === "buttons") {
    if (!isTelegram) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ /debug buttons is only available on Telegram." },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: "⚙️ Debug button smoke test. Tap Ack to verify inline buttons and callback delivery.",
        channelData: { telegram: { buttons: buildDebugButtonsKeyboard() } },
      },
    };
  }
  if (debugCommand.action === "buttons-ack") {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Debug button callback received." },
    };
  }
  if (debugCommand.action === "reviewcard") {
    if (!isTelegram) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ /debug reviewcard is only available on Telegram." },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text:
          "Instagram draft\n\nA ruby centerpiece framed by diamonds in 18K yellow gold. Made for a friend, with a warm personal story behind it.\n\nPrice: $599\n\nThis is a deterministic debug card. It does not write to the marketing pipeline.",
        channelData: { telegram: { buttons: buildDebugReviewCardKeyboard() } },
      },
    };
  }
  if (debugCommand.action === "reviewcard-action") {
    const labels = {
      approve: "Approve",
      reject: "Reject",
      dry: "Dry Run",
      live: "Queue Live",
      status: "Status",
      reschedule: "Reschedule",
    } as const;
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Debug review-card action received: ${labels[debugCommand.button]}.` },
    };
  }
  if (debugCommand.action === "show") {
    const overrides = getConfigOverrides();
    const hasOverrides = Object.keys(overrides).length > 0;
    if (!hasOverrides) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Debug overrides: (none)" },
      };
    }
    const json = JSON.stringify(overrides, null, 2);
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Debug overrides (memory-only):\n\`\`\`json\n${json}\n\`\`\``,
      },
    };
  }
  if (debugCommand.action === "reset") {
    resetConfigOverrides();
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Debug overrides cleared; using config on disk." },
    };
  }
  if (debugCommand.action === "unset") {
    const result = unsetConfigOverride(debugCommand.path);
    if (!result.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${result.error ?? "Invalid path."}` },
      };
    }
    if (!result.removed) {
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ No debug override found for ${debugCommand.path}.`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Debug override removed for ${debugCommand.path}.` },
    };
  }
  if (debugCommand.action === "set") {
    const result = setConfigOverride(debugCommand.path, debugCommand.value);
    if (!result.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${result.error ?? "Invalid override."}` },
      };
    }
    const valueLabel =
      typeof debugCommand.value === "string"
        ? `"${debugCommand.value}"`
        : JSON.stringify(debugCommand.value);
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Debug override set: ${debugCommand.path}=${valueLabel ?? "null"}`,
      },
    };
  }

  return null;
};
