import {
  AgentSession,
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
 * Load resources for the ephemeral reflection session while excluding only
 * pi-digivolve. Other extensions remain available so provider registrations
 * (including local-model providers) and project integrations still work.
 */
async function createDigivolveResources(
  cwd: string,
  systemPrompt: string,
): Promise<{ resourceLoader: DefaultResourceLoader; settingsManager: SettingsManager }> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPrompt,
    extensionsOverride: (result) => ({
      ...result,
      // The extension's command is a stable identity across npm, git, local,
      // symlinked, and CLI installation paths. Its factory is evaluated during
      // discovery, but removing it here prevents its handlers from being bound
      // to the side session while preserving the shared runtime registrations
      // made by every other extension.
      extensions: result.extensions.filter((extension) => !extension.commands.has("digivolve")),
    }),
  });

  // createAgentSession only reloads a loader that it creates itself. A supplied
  // loader must be initialized explicitly or its skills/context remain empty.
  await resourceLoader.reload();
  return { resourceLoader, settingsManager };
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

  // Only one side session may run per extension instance. The side session
  // filters out pi-digivolve itself, so this is a concurrency guard rather than
  // the primary recursion boundary.
  let inDigivolveSession = false;
  let activeSideSession: AgentSession | null = null;

  /**
   * Queue the one allowed reflection pass for the current user message when
   * trust, conversation, and arming checks allow it. Returns whether a pass was
   * queued so session-replacement hooks can cancel and let it run first.
   *
   * Recursion is prevented structurally because the side session filters out
   * pi-digivolve and queues its result as a non-triggering custom message.
   * Source/sentinel checks and the single-flight flag provide defense in depth.
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
   * Run the reflection pass in an in-memory side session seeded with a snapshot
   * of the main branch. The side session can edit repository guidance and use
   * other extensions, but cannot load pi-digivolve or trigger another main turn.
   */
  async function runDigivolveReflection(ctx: ExtensionContext): Promise<void> {
    inDigivolveSession = true;
    let session: AgentSession | null = null;

    // Snapshot all session-bound data before the first await. The main session
    // may be replaced while this background pass is running.
    const cwd = ctx.cwd;
    const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    let contextMessages: ReturnType<typeof buildSessionContext>["messages"] = [];
    try {
      contextMessages = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      ).messages;
    } catch {
      // Continue with an empty side session if the main branch cannot be built.
    }

    try {
      const { resourceLoader, settingsManager } = await createDigivolveResources(cwd, systemPrompt);
      const created = await createAgentSession({
        cwd,
        sessionManager: SessionManager.inMemory(cwd),
        ...(model ? { model } : {}),
        thinkingLevel,
        tools: ["read", "bash", "edit", "write"],
        resourceLoader,
        settingsManager,
      });
      session = created.session;
      activeSideSession = session;
      session.agent.state.messages = contextMessages as typeof session.agent.state.messages;

      await session.prompt(FOLLOW_UP_PROMPT, { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (response?.stopReason !== "aborted" && response?.stopReason !== "error") {
        const answer = extractText(response?.content);
        if (answer) {
          // A transient notification delivers the result to the user without
          // entering the conversation context, so the main agent never sees it
          // in the next turn and reflection cannot be re-armed by its own output.
          ctx.ui.notify(`pi-digivolve reflection result: ${answer}`, "info");
        }
      }
    } catch {
      // Background reflection is best-effort. Session replacement can also make
      // the originating extension runtime stale before a result is delivered.
    } finally {
      if (activeSideSession === session) activeSideSession = null;
      inDigivolveSession = false;
      if (session) {
        try {
          await session.abort();
        } catch {
          // Ignore abort errors during cleanup.
        }
        session.dispose();
      }
    }
  }

  pi.on("input", (event: InputEvent, _ctx: ExtensionContext): void => {
    if (event.source === "extension" || isDigivolveText(event.text)) {
      reflectionArmed = false;
      return;
    }

    // Cancel any in-flight reflection so the agent can settle cleanly for the
    // new user message; a fresh pass will be queued when agent_settled fires.
    const session = activeSideSession;
    if (session) {
      void session.abort();
    }
    activeSideSession = null;
    inDigivolveSession = false;

    reflectionArmed = true;
  });

  pi.on("agent_settled", (_event, ctx): void => {
    if (!config.enabled) return;

    maybeQueueReflection(ctx);
  });

  pi.on("session_shutdown", async (): Promise<void> => {
    const session = activeSideSession;
    activeSideSession = null;
    if (!session) return;

    try {
      await session.abort();
    } catch {
      // Ignore abort errors while the main extension runtime is shutting down.
    }
    // The owning background task disposes the session in its finally block.
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
