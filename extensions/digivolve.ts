import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";

import { DigivolveConfigManager } from "./digivolve/config.ts";

const SENTINEL = "<!-- pi-digivolve -->";

const FOLLOW_UP_PROMPT = `${SENTINEL}
Read the digivolution skill if you have not already.

Review what was learned during the task. If durable, repo-specific instructions or in-repo skills should be improved, edit the narrowest appropriate file now. If no durable improvement is warranted, make no changes and do not respond.`;

/**
 * Determine whether the session has user or assistant conversation content worth
 * reflecting on.
 */
function hasConversation(ctx: ExtensionContext): boolean {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user" || entry.message.role === "assistant") return true;
  }
  return false;
}

/**
 * Check whether input text was injected by pi-digivolve.
 */
function isDigivolveText(text: string): boolean {
  return text.includes(SENTINEL);
}

/**
 * Register the pi-digivolve extension.
 *
 * Reflection is armed once per genuine user message (interactive or rpc input)
 * and consumed at most once before the agent would otherwise stop. The injected
 * follow-up reflection prompt arrives as `source: "extension"` input, so it does
 * not re-arm reflection and cannot trigger a reflection loop.
 */
export default function digivolve(pi: ExtensionAPI) {
  const config = new DigivolveConfigManager();

  // True when the current user message has not yet had a reflection pass queued.
  let reflectionArmed = false;

  /**
   * Queue the one allowed reflection follow-up for the current user message when
   * trust, conversation, and arming checks allow it. Returns whether a follow-up
   * was queued so session-replacement hooks can cancel and let it run first.
   */
  function maybeQueueReflection(ctx: ExtensionContext, force = false): boolean {
    if (!force && !reflectionArmed) return false;
    if (!ctx.isProjectTrusted()) return false;
    if (!hasConversation(ctx)) return false;

    reflectionArmed = false;
    pi.sendUserMessage(FOLLOW_UP_PROMPT, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    if (ctx.hasUI) ctx.ui.notify("pi-digivolve queued a reflection pass", "info");
    return true;
  }

  pi.on("input", (event: InputEvent, _ctx: ExtensionContext): void => {
    if (event.source === "extension" || isDigivolveText(event.text)) {
      reflectionArmed = false;
      return;
    }

    reflectionArmed = true;
  });

  pi.on("agent_end", (_event, ctx): void => {
    if (!config.enabled) return;
    if (ctx.hasPendingMessages()) return;

    maybeQueueReflection(ctx);
  });

  pi.registerCommand("digivolve", {
    description: "Run, check, or configure pi-digivolve post-task reflection",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const command = args.trim().toLowerCase();

      if (command === "status") {
        ctx.ui.notify(
          `pi-digivolve auto=${config.enabled ? "on" : "off"}; current message=${reflectionArmed ? "armed" : "done"}; config=${config.path}`,
          "info",
        );
        return;
      }

      if (command === "on") {
        config.enabled = true;
        ctx.ui.notify("pi-digivolve automatic reflection enabled", "info");
        return;
      }

      if (command === "off") {
        config.enabled = false;
        ctx.ui.notify("pi-digivolve automatic reflection disabled", "info");
        return;
      }

      if (command && command !== "force") {
        ctx.ui.notify("Usage: /digivolve [status|on|off|force]", "warning");
        return;
      }

      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("pi-digivolve skipped: project is not trusted", "warning");
        return;
      }

      if (!hasConversation(ctx)) {
        ctx.ui.notify("pi-digivolve skipped: no conversation to reflect on yet", "warning");
        return;
      }

      if (command !== "force" && !reflectionArmed) {
        ctx.ui.notify(
          "pi-digivolve already ran for this message. Use /digivolve force to run again.",
          "info",
        );
        return;
      }

      maybeQueueReflection(ctx, command === "force");
    },
  });
}
