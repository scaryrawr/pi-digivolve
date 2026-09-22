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
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { DigivolveConfigManager } from "./digivolve/config.ts";
import { TurnMonitor } from "./digivolve/turn-monitor.ts";

const SENTINEL = "<!-- pi-digivolve -->";

const FOLLOW_UP_PROMPT = `${SENTINEL}
Run one repository-guidance review. Review whether this turn revealed a verified, durable repository-specific setup, validation, workflow, safety, convention, or instruction correction that would help future agents. Check existing guidance before editing, prefer correcting it over duplicating text, and use the narrowest relevant instruction surface. Do not add generic advice, one-off task details, secrets, private data, or speculative preferences. Make no change when there is no durable improvement; in that case finish silently.`;

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
 * Each genuine user message (interactive or rpc input) starts one in-memory
 * evidence monitor. Automatic reflection is consumed at most once and only when
 * the turn contains a repository-specific correction or a qualifying command
 * failure/recovery sequence. Extension input cannot start or re-arm monitoring.
 *
 * Reflection runs in an ephemeral side session (in-memory, not persisted) seeded
 * with the main conversation history. This keeps the current session's work
 * uninterrupted while still allowing durable repo guidance to be improved.
 */
export default function digivolve(pi: ExtensionAPI) {
  const config = new DigivolveConfigManager();
  const turnMonitor = new TurnMonitor();

  // True when the current user message has not yet had a reflection pass queued.
  let reflectionArmed = false;

  // Only one side session may run per extension instance. The side session
  // filters out pi-digivolve itself, so this is a concurrency guard rather than
  // the primary recursion boundary.
  interface ReflectionRun {
    cancelled: boolean;
    session: AgentSession | null;
    completion: Promise<void> | null;
  }
  let activeReflection: ReflectionRun | null = null;

  /**
   * Queue the one allowed reflection pass for the current user message when
   * trust, conversation, and arming checks allow it. Returns whether a pass was
   * queued so session-replacement hooks can cancel and let it run first.
   *
   * Recursion is prevented structurally because the side session filters out
   * pi-digivolve and reports its result only through the UI. Source/sentinel
   * checks and the single-flight guard provide defense in depth.
   */
  function maybeQueueReflection(
    ctx: ExtensionContext,
    options: { force?: boolean; requireEvidence?: boolean } = {},
  ): boolean {
    if (!options.force && !reflectionArmed) return false;
    if (activeReflection) return false;
    if (!ctx.isProjectTrusted()) return false;
    if (!hasConversation(ctx)) return false;
    if (options.requireEvidence && !turnMonitor.claimReflection()) return false;

    reflectionArmed = false;
    turnMonitor.markReflectionIssued();
    const run: ReflectionRun = {
      cancelled: false,
      session: null,
      completion: null,
    };
    activeReflection = run;
    run.completion = runDigivolveReflection(ctx, run);
    void run.completion;
    if (ctx.hasUI) ctx.ui.notify("pi-digivolve queued a reflection pass", "info");
    return true;
  }

  /**
   * Cancel the entire active run, including setup that has not created a
   * session yet, and wait for its owning task to release the guard.
   */
  async function cancelActiveReflection(): Promise<void> {
    const run = activeReflection;
    if (!run) return;

    run.cancelled = true;
    if (run.session) {
      try {
        await run.session.abort();
      } catch {
        // The owning task still performs final cleanup and releases the guard.
      }
    }
    await run.completion;
  }

  /**
   * Run the reflection pass in an in-memory side session seeded with a snapshot
   * of the main branch. The side session can edit repository guidance and use
   * other extensions, but cannot load pi-digivolve or trigger another main turn.
   */
  async function runDigivolveReflection(ctx: ExtensionContext, run: ReflectionRun): Promise<void> {
    let session: AgentSession | null = null;

    // Snapshot all session-bound data before the first await. The main session
    // may be replaced while this background pass is running.
    const cwd = ctx.cwd;
    const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());
    // Keep reflection behavior aligned with the active session, including any
    // model switch that occurred before this pass was queued.
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
      if (run.cancelled) return;

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
      run.session = session;
      if (run.cancelled) return;

      session.agent.state.messages = contextMessages as typeof session.agent.state.messages;

      await session.prompt(FOLLOW_UP_PROMPT, { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (
        !run.cancelled &&
        response?.stopReason !== "aborted" &&
        response?.stopReason !== "error"
      ) {
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
      if (session) {
        try {
          await session.abort();
        } catch {
          // Ignore abort errors during cleanup.
        }
        session.dispose();
      }
      if (activeReflection === run) activeReflection = null;
    }
  }

  pi.on("input", async (event: InputEvent, _ctx: ExtensionContext): Promise<void> => {
    if ((event.source !== "interactive" && event.source !== "rpc") || isDigivolveText(event.text)) {
      reflectionArmed = false;
      return;
    }

    // Cancel any in-flight reflection so the agent can settle cleanly for the
    // new user message. Wait for the owning task even during asynchronous setup,
    // so stale work cannot later create a session or clear a newer run's guard.
    await cancelActiveReflection();

    reflectionArmed = true;
    turnMonitor.start(event.text);
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx): void => {
    if (!reflectionArmed || event.toolName !== "bash") return;

    const command = event.input.command;
    if (typeof command !== "string") return;

    if (event.isError) {
      const error = event.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      turnMonitor.recordFailure(command, error, ctx.cwd);
    } else {
      turnMonitor.recordSuccess(command, ctx.cwd);
    }
  });

  pi.on("agent_settled", (_event, ctx): void => {
    if (!config.enabled) return;

    maybeQueueReflection(ctx, { requireEvidence: true });
  });

  pi.on("session_shutdown", async (): Promise<void> => {
    await cancelActiveReflection();
  });

  pi.registerCommand("digivolve", {
    description: "Run, check, or configure pi-digivolve post-task reflection",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const command = args.trim().toLowerCase();

      if (command === "status") {
        ctx.ui.notify(
          `pi-digivolve auto=${config.enabled ? "on" : "off"}; reflection model=active session model; current message=${reflectionArmed ? `armed; adaptive evidence=${turnMonitor.hasEvidence ? "yes" : "no"}` : "done"}; config=${config.path}`,
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

      maybeQueueReflection(ctx, { force: command === "force" });
    },
  });
}
