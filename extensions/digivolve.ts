import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
  SessionEntry,
  SessionStartEvent,
  SessionTreeEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { DigivolveConfigManager } from "./digivolve/config.ts";

const CUSTOM_ENTRY = "pi-digivolve";
const SENTINEL = "<!-- pi-digivolve -->";

/**
 * Session-persisted marker recording that pi-digivolve has already queued or run
 * for a specific session/repository pair.
 */
interface DigivolveEntryData {
  /** Schema version for future migrations of this custom session entry. */
  version: 1;
  /** Guard key derived from the session id and resolved repository path. */
  key: string;
  /** Pi session id that owned this digivolution run. */
  sessionId: string;
  /** Resolved Git repository root, or resolved working directory outside Git. */
  repoPath: string;
  /** Lifecycle path that caused this marker to be written. */
  source: "auto" | "manual" | "session-replacement";
  /** ISO timestamp for when the marker was created. */
  createdAt: string;
  /** Session leaf id at the point where reflection was queued. */
  leafId: string | null;
}

/**
 * Minimal cancellable result shape shared by pi session replacement hooks.
 */
interface CancelSessionChangeResult {
  /** Whether pi should cancel the pending session replacement action. */
  cancel?: boolean;
}

const DIGIVOLUTION_INSTRUCTIONS = `
You are doing pi-digivolve post-task reflection. Decide whether this session revealed durable repo-specific guidance that should help future agents.

Update instructions or skills only when at least one is true:
- You repeatedly had to rediscover a durable repo-specific fact.
- Existing instructions were misleading, stale, incomplete, or contradicted the repo.
- You learned validation, setup, workflow, safety, architecture, or convention details likely to be useful next time.

Choose the narrowest appropriate destination:
- Repo-wide durable guidance -> the narrowest relevant AGENTS.md.
- Pi/project skills -> .pi/skills/**/SKILL.md or .agents/skills/**/SKILL.md when a skill itself is stale, missing critical steps, or misleading.
- Cross-agent guidance -> existing CLAUDE.md, .github/copilot-instructions.md, or .github/instructions/*.instructions.md only when the repository already uses that surface and the change belongs there.
- Deeper docs -> link to them instead of dumping large documentation into immediate instructions.

Safety and quality rules:
- Do not add generic advice, one-off task details, secrets, private data, or speculative preferences.
- Do not create nested instructions unless the scope differs meaningfully from parent guidance.
- Prefer correcting or tightening existing guidance over duplicating new text.
- Keep edits concise and actionable.
- If there is no durable improvement, make no file changes and say so briefly.
`;

const FOLLOW_UP_PROMPT = `${SENTINEL}
Before finishing, run a pi-digivolve reflection over this session.

Review what was learned during the task. If durable, repo-specific instructions or in-repo skills should be improved, edit the narrowest appropriate file now. If no durable improvement is warranted, make no changes and finish with a brief note that no digivolution was needed.`;

/**
 * Resolve a path to its native real path when it exists, otherwise return the
 * absolute path that Node would resolve for the value.
 */
function realpathOrResolve(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

/**
 * Resolve the current Git repository root for a working directory, falling back
 * to the working directory when Git is unavailable or the directory is not in a
 * repository.
 */
async function resolveRepoPath(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    timeout: 5_000,
  });
  const topLevel = result.code === 0 ? result.stdout.trim() : "";
  return realpathOrResolve(topLevel || cwd);
}

/**
 * Read the stable pi session id from an extension context.
 */
function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

/**
 * Build the in-memory/session-persisted guard key for one session/repository
 * pair.
 */
function getGuardKey(sessionId: string, repoPath: string): string {
  return `${sessionId}\0${repoPath}`;
}

/**
 * Type guard for custom session entries written by this extension.
 */
function isDigivolveEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; data: DigivolveEntryData } {
  if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY) return false;
  const data = entry.data as Partial<DigivolveEntryData> | undefined;
  return data?.version === 1 && typeof data.key === "string";
}

/**
 * Reconstruct the set of already-triggered guard keys from the current session
 * history.
 */
function reconstructTriggeredKeys(ctx: ExtensionContext): Set<string> {
  const keys = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (isDigivolveEntry(entry)) keys.add(entry.data.key);
  }
  return keys;
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
 * Check whether a user prompt was injected by pi-digivolve.
 */
function isDigivolvePrompt(text: string): boolean {
  return text.includes(SENTINEL);
}

/**
 * Register the pi-digivolve extension.
 */
export default function digivolve(pi: ExtensionAPI) {
  let triggeredKeys = new Set<string>();
  let currentKey: string | undefined;
  const config = new DigivolveConfigManager();

  /**
   * Rebuild extension state for the currently active session.
   */
  async function refreshState(ctx: ExtensionContext): Promise<void> {
    triggeredKeys = reconstructTriggeredKeys(ctx);
    const repoPath = await resolveRepoPath(pi, ctx.cwd);
    currentKey = getGuardKey(getSessionId(ctx), repoPath);
  }

  /**
   * Persist a guard marker for the current session/repository pair and return
   * the marker key.
   */
  async function markTriggered(
    ctx: ExtensionContext,
    source: DigivolveEntryData["source"],
  ): Promise<string> {
    const sessionId = getSessionId(ctx);
    const repoPath = await resolveRepoPath(pi, ctx.cwd);
    const key = getGuardKey(sessionId, repoPath);

    if (!triggeredKeys.has(key)) {
      triggeredKeys.add(key);
      pi.appendEntry(CUSTOM_ENTRY, {
        version: 1,
        key,
        sessionId,
        repoPath,
        source,
        createdAt: new Date().toISOString(),
        leafId: ctx.sessionManager.getLeafId(),
      } satisfies DigivolveEntryData);
    }

    currentKey = key;
    return key;
  }

  /**
   * Queue the one allowed digivolution follow-up for the active session when the
   * guard, trust, and conversation checks allow it.
   */
  async function maybeQueueReflection(
    ctx: ExtensionContext,
    source: DigivolveEntryData["source"],
  ): Promise<boolean> {
    if (!ctx.isProjectTrusted()) return false;
    if (!hasConversation(ctx)) return false;

    const sessionId = getSessionId(ctx);
    const repoPath = await resolveRepoPath(pi, ctx.cwd);
    const key = getGuardKey(sessionId, repoPath);
    currentKey = key;

    if (triggeredKeys.has(key)) return false;

    await markTriggered(ctx, source);
    pi.sendUserMessage(FOLLOW_UP_PROMPT, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    if (ctx.hasUI) ctx.ui.notify("pi-digivolve queued one final reflection pass", "info");
    return true;
  }

  /**
   * Restore persisted guard state whenever a session starts.
   */
  async function handleSessionStart(
    _event: SessionStartEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    await refreshState(ctx);
  }

  /**
   * Restore persisted guard state after tree navigation changes the active
   * branch.
   */
  async function handleSessionTree(_event: SessionTreeEvent, ctx: ExtensionContext): Promise<void> {
    await refreshState(ctx);
  }

  /**
   * Add stricter digivolution guidance only to prompts injected by this
   * extension.
   */
  function handleBeforeAgentStart(
    event: BeforeAgentStartEvent,
  ): BeforeAgentStartEventResult | undefined {
    if (!isDigivolvePrompt(event.prompt)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${DIGIVOLUTION_INSTRUCTIONS}`,
    };
  }

  /**
   * Queue automatic reflection after a final-looking turn.
   */
  async function handleTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<void> {
    if (!config.enabled) return;
    if (event.toolResults.length > 0) return;
    if (ctx.hasPendingMessages()) return;

    await maybeQueueReflection(ctx, "auto");
  }

  /**
   * Cancel a session switch once when digivolution has not had a chance to run.
   */
  async function handleSessionBeforeSwitch(
    _event: SessionBeforeSwitchEvent,
    ctx: ExtensionContext,
  ): Promise<CancelSessionChangeResult | undefined> {
    if (!config.enabled) return;
    const queued = await maybeQueueReflection(ctx, "session-replacement");
    if (queued) return { cancel: true };
  }

  /**
   * Cancel a fork or clone once when digivolution has not had a chance to run.
   */
  async function handleSessionBeforeFork(
    _event: SessionBeforeForkEvent,
    ctx: ExtensionContext,
  ): Promise<CancelSessionChangeResult | undefined> {
    if (!config.enabled) return;
    const queued = await maybeQueueReflection(ctx, "session-replacement");
    if (queued) return { cancel: true };
  }

  /**
   * Handle `/digivolve` subcommands and manual reflection requests.
   */
  async function handleDigivolveCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const command = args.trim().toLowerCase();

    if (command === "status") {
      await refreshState(ctx);
      const done = currentKey ? triggeredKeys.has(currentKey) : false;
      ctx.ui.notify(
        `pi-digivolve auto=${config.enabled ? "on" : "off"}; current session/repo=${done ? "done" : "armed"}; config=${config.path}`,
        "info",
      );
      return;
    }

    if (command === "on") {
      config.enabled = true;
      await refreshState(ctx);
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

    await refreshState(ctx);
    if (command !== "force" && currentKey && triggeredKeys.has(currentKey)) {
      ctx.ui.notify(
        "pi-digivolve already ran for this session/repo. Use /digivolve force to run again.",
        "info",
      );
      return;
    }

    await markTriggered(ctx, "manual");
    pi.sendUserMessage(FOLLOW_UP_PROMPT);
  }

  pi.on("session_start", handleSessionStart);
  pi.on("session_tree", handleSessionTree);
  pi.on("before_agent_start", handleBeforeAgentStart);
  pi.on("turn_end", handleTurnEnd);
  pi.on("session_before_switch", handleSessionBeforeSwitch);
  pi.on("session_before_fork", handleSessionBeforeFork);

  pi.registerCommand("digivolve", {
    description: "Run, check, or configure pi-digivolve post-task reflection",
    handler: handleDigivolveCommand,
  });
}
