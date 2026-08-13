import {
  AgentSession,
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ResourceLoader,
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
 * Strip dynamic footer lines from a system prompt so the ephemeral session
 * gets a stable prompt without session-specific date/time/cwd noise.
 */
function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

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
 * Create a resource loader for the ephemeral digivolve side session. It loads
 * project skills, prompts, themes, and agentsFiles so the reflection pass can
 * find and improve durable guidance. Extensions are excluded to prevent the
 * digivolve extension from re-arming inside its own side session.
 */
function createDigivolveResourceLoader(ctx: ExtensionContext): ResourceLoader {
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

  const defaultLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    systemPrompt,
    noExtensions: true,
  });

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => defaultLoader.getSkills(),
    getPrompts: () => defaultLoader.getPrompts(),
    getThemes: () => defaultLoader.getThemes(),
    getAgentsFiles: () => defaultLoader.getAgentsFiles(),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Find the last assistant message in an ephemeral side session's state.
 */
function getLastAssistantMessage(
  session: AgentSession,
): { role: "assistant"; content: unknown; stopReason?: string } | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message?.role === "assistant") {
      return message as { role: "assistant"; content: unknown; stopReason?: string };
    }
  }
  return null;
}

/**
 * Extract plain text from an assistant message's content parts.
 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Register the pi-digivolve extension.
 *
 * Reflection is armed once per genuine user message (interactive or rpc input)
 * and consumed at most once before the agent would otherwise stop. The injected
 * follow-up reflection prompt arrives as `source: "extension"` input, so it does
 * not re-arm reflection and cannot trigger a reflection loop.
 *
 * Instead of prompting the current coding agent directly, digivolve now kicks off
 * an ephemeral side session (in-memory, not persisted) that is seeded with the
 * main conversation history and runs the reflection pass independently in the
 * background. This keeps the current session's work uninterrupted while still
 * allowing durable repo guidance and skills to be improved.
 */
export default function digivolve(pi: ExtensionAPI) {
  const config = new DigivolveConfigManager();

  // True when the current user message has not yet had a reflection pass queued.
  let reflectionArmed = false;

  // Set while an ephemeral digivolve side session is running. When this flag
  // is true, maybeQueueReflection skips queuing a new pass, preventing the
  // ephemeral session's summary follow-up from triggering an indefinite recursion
  // of reflection passes.
  let inDigivolveSession = false;

  /**
   * Queue the one allowed reflection pass for the current user message when
   * trust, conversation, and arming checks allow it. Returns whether a pass was
   * queued so session-replacement hooks can cancel and let it run first.
   *
   * Recursion is prevented because:
   * 1. Extension-sourced messages (including follow-ups from the ephemeral
   *    session) reset reflectionArmed in the input handler.
   * 2. When agent_end fires after a follow-up is processed, reflectionArmed
   *    is already false so maybeQueueReflection returns false and no new
   *    pass is queued.
   * 3. inDigivolveSession acts as an additional guard: while a side session
   *    is running, no new pass can be queued even if reflectionArmed were
   *    to re-arm unexpectedly.
   */
  function maybeQueueReflection(ctx: ExtensionContext, force = false): boolean {
    if (!force && !reflectionArmed) return false;
    if (inDigivolveSession) return false;
    if (!ctx.isProjectTrusted()) return false;
    if (!hasConversation(ctx)) return false;

    reflectionArmed = false;
    void runDigivolveReflection(ctx);
    if (ctx.hasUI) ctx.ui.notify("pi-digivolve queued a reflection pass", "info");
    return true;
  }

  /**
   * Run the digivolve reflection pass in an ephemeral side session seeded with
   * the main conversation history. The session runs independently and makes
   * filesystem changes (edits to skills, AGENTS.md, etc.) without interrupting
   * the current session's work. When it finishes, a summary of what was changed
   * is sent back to the main session as a follow-up.
   *
   * Recursion safeguard: inDigivolveSession is set while the side session is
   * active, which prevents maybeQueueReflection from queuing a second pass.
   * The summary message sent back does NOT include the pi-digivolve sentinel,
   * so it won't be mistaken for a reflection prompt. When it arrives as a
   * follow-up (source: "extension"), the input handler resets reflectionArmed,
   * preventing a third pass from being queued when agent_end fires afterward.
   */
  async function runDigivolveReflection(ctx: ExtensionContext): Promise<void> {
    inDigivolveSession = true;

    const resourceLoader = createDigivolveResourceLoader(ctx);

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      ...(ctx.model ? { model: ctx.model } : {}),
      modelRegistry: ctx.modelRegistry,
      thinkingLevel: pi.getThinkingLevel(),
      tools: ["read", "bash", "edit", "write"],
      resourceLoader,
    });

    // Seed the ephemeral session with the main conversation history so the
    // reflection pass has full context about what was done.
    try {
      const contextMessages = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      ).messages;
      session.agent.state.messages = contextMessages as typeof session.agent.state.messages;
    } catch {
      // Ignore context seed failures and continue with an empty side session.
    }

    try {
      await session.prompt(FOLLOW_UP_PROMPT, { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (response?.stopReason !== "aborted" && response?.stopReason !== "error") {
        const answer = extractText(response?.content) || "(No summary generated)";
        // Send the summary back to the main session as a follow-up.
        if (ctx.isIdle()) {
          pi.sendUserMessage(answer);
        } else {
          pi.sendUserMessage(answer, { deliverAs: "followUp" });
        }
      }
    } catch {
      // Ignore errors from the ephemeral session — it's a background task.
    } finally {
      inDigivolveSession = false;
      try {
        await session.abort();
      } catch {
        // Ignore abort errors during cleanup.
      }
      session.dispose();
    }
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
