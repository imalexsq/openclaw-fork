import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";

export type DebugCommand =
  | { action: "show" }
  | { action: "reset" }
  | { action: "buttons" }
  | { action: "buttons-ack" }
  | { action: "reviewcard" }
  | {
      action: "reviewcard-action";
      button: "approve" | "reject" | "dry" | "live" | "status" | "reschedule";
    }
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

export function parseDebugCommand(raw: string): DebugCommand | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^\/debug(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const tail = (match[1] ?? "").trim();
  const lowerTail = tail.toLowerCase();
  if (!tail || lowerTail === "show") {
    return { action: "show" };
  }
  if (lowerTail === "buttons") {
    return { action: "buttons" };
  }
  if (lowerTail === "buttons ack") {
    return { action: "buttons-ack" };
  }
  if (lowerTail === "reviewcard") {
    return { action: "reviewcard" };
  }
  const reviewcardMatch = lowerTail.match(
    /^reviewcard\s+(approve|reject|dry|dry-run|live|queue-live|status|reschedule)$/,
  );
  if (reviewcardMatch) {
    const rawAction = reviewcardMatch[1];
    const normalized =
      rawAction === "dry-run"
        ? "dry"
        : rawAction === "queue-live"
          ? "live"
          : rawAction;
    return {
      action: "reviewcard-action",
      button: normalized as "approve" | "reject" | "dry" | "live" | "status" | "reschedule",
    };
  }
  if (lowerTail === "reset") {
    return { action: "reset" };
  }

  return parseStandardSetUnsetSlashCommand<DebugCommand>({
    raw,
    slash: "/debug",
    invalidMessage: "Invalid /debug syntax.",
    usageMessage: "Usage: /debug show|buttons|reviewcard|set|unset|reset",
    onKnownAction: (action) => {
      if (action === "show") {
        return { action: "show" };
      }
      if (action === "reset") {
        return { action: "reset" };
      }
      return undefined;
    },
  });
}
