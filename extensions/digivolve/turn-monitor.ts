import { createHash } from "node:crypto";
import path from "node:path";

const MAX_INSPECTED_TEXT = 8_192;

const CORRECTION_PATTERNS = [
  /\bi already (?:said|told you)\b/iu,
  /\byou (?:ignored|missed|used)\b/iu,
  /\bwhy did you (?:ignore|miss|use|run|change|remove|skip|retry)\b/iu,
  /\bwhy are you (?:still )?(?:ignoring|missing|using|running|changing|removing|skipping|retrying)\b/iu,
  /\byou keep (?:ignoring|missing|using|running|changing|removing|skipping|retrying)\b/iu,
  /(?:^|[.!?]\s+|(?:also|and|but|just|please)\s+)remember(?:\s+(?:how|that|to))?\b/iu,
  /\b(?:can|could|would) you (?:please )?remember\b/iu,
  /\b(?:do not|don't) (?:do|use|run|change|remove|skip|retry) .{0,60}\bagain\b/iu,
  /\bnext time[,;:\s-]+(?:use|run|check|read|follow|keep|avoid|do not|don't)\b/iu,
  /\bfrom now on[,;:\s-]+(?:use|run|check|read|follow|keep|avoid|do not|don't)\b/iu,
  /\bstop (?:using|running|doing|retrying)\b/iu,
  /\b(?:no|wrong|incorrect)[,;:\s-]+(?:use|run|this|that)\b/iu,
  /\b(?:this|the) (?:repo|repository) (?:uses|requires|expects)\b/iu,
  /\bnot .{1,60}\b(?:use|run|uses|requires)\b/iu,
] as const;

const REPO_SURFACE_PATTERN =
  /\b(?:repo(?:sitory)?|agents?\.md|claude\.md|copilot instructions?|skill\.md|readme(?:\.md)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|cargo\.toml|go\.mod|manifest|config(?:uration)? file|setup instructions?|install(?:ation)? instructions?|workflow file|project convention|npm|pnpm|yarn|bun|gradle|maven|cargo|pytest|rspec)\b/iu;

const USAGE_ERROR_PATTERN =
  /\b(?:unknown|unrecognized|invalid|unsupported|unexpected)\s+(?:option|argument|flag|command)|\busage:\b|\bno such (?:script|command)\b|\bmissing required (?:argument|option)\b/iu;

interface FailedOperation {
  readonly commandDigest: string;
  readonly target: string;
  readonly usageError: boolean;
  readonly validationLike: boolean;
}

interface TurnState {
  reflectionIssued: boolean;
  evidence: Set<EvidenceKind>;
  failures: FailedOperation[];
}

type EvidenceKind = "repo-correction" | "recovered-command-mistake" | "repeated-failure-recovered";

interface CommandOperation {
  readonly command: string;
  readonly target: string;
  readonly validationLike: boolean;
}

/** In-memory detector for strong, repo-specific reflection evidence in one user turn. */
export class TurnMonitor {
  private turn: TurnState | undefined;

  /** Start monitoring a genuine user turn. */
  start(prompt: string): void {
    this.turn = {
      reflectionIssued: false,
      evidence: new Set(),
      failures: [],
    };

    if (isRepositoryCorrection(prompt)) this.turn.evidence.add("repo-correction");
  }

  /** Record a failed local shell operation without retaining its command or output. */
  recordFailure(command: string, error: string, workingDirectory: string): void {
    if (!this.turn) return;

    const operation = normalizeCommandOperation(command, workingDirectory);
    if (!operation) return;

    this.turn.failures.push({
      commandDigest: digest(operation.command),
      target: operation.target,
      usageError: USAGE_ERROR_PATTERN.test(error.slice(0, MAX_INSPECTED_TEXT)),
      validationLike: operation.validationLike,
    });
  }

  /** Correlate a changed successful command with failures against the same target. */
  recordSuccess(command: string, workingDirectory: string): void {
    if (!this.turn) return;

    const operation = normalizeCommandOperation(command, workingDirectory);
    if (!operation || !operation.validationLike) return;

    const commandDigest = digest(operation.command);
    const related = this.turn.failures.filter(
      (failure) => failure.target === operation.target && failure.commandDigest !== commandDigest,
    );

    if (related.some((failure) => failure.usageError && failure.validationLike)) {
      this.turn.evidence.add("recovered-command-mistake");
    } else if (related.filter((failure) => failure.validationLike).length >= 2) {
      this.turn.evidence.add("repeated-failure-recovered");
    }
  }

  /** Claim the turn's one reflection only when qualifying evidence exists. */
  claimReflection(): boolean {
    if (!this.turn || this.turn.reflectionIssued || this.turn.evidence.size === 0) {
      return false;
    }

    this.turn.reflectionIssued = true;
    return true;
  }

  /** Mark this turn handled after a manual reflection. */
  markReflectionIssued(): void {
    if (this.turn) this.turn.reflectionIssued = true;
  }

  /** Whether the current turn has already consumed its reflection opportunity. */
  get reflectionIssued(): boolean {
    return this.turn?.reflectionIssued ?? false;
  }

  /** Whether the current turn currently has qualifying adaptive evidence. */
  get hasEvidence(): boolean {
    return (this.turn?.evidence.size ?? 0) > 0;
  }
}

/** Detect an explicit correction that is also tied to a repository surface or workflow. */
export function isRepositoryCorrection(prompt: string): boolean {
  const inspected = prompt.slice(0, MAX_INSPECTED_TEXT);
  return (
    CORRECTION_PATTERNS.some((pattern) => pattern.test(inspected)) &&
    REPO_SURFACE_PATTERN.test(inspected)
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeCommandOperation(
  command: string,
  workingDirectory: string,
): CommandOperation | undefined {
  const inspected = command.slice(0, MAX_INSPECTED_TEXT);
  if (!inspected.trim()) return undefined;

  const candidates = shellPathCandidates(inspected);
  if (candidates.some(isUrlLike)) return undefined;

  for (const candidate of candidates) {
    const target = normalizeRepoPath(candidate, workingDirectory);
    if (target) {
      return {
        command: normalizeCommand(inspected),
        target,
        validationLike: isValidationCommand(inspected),
      };
    }
  }

  if (candidates.length > 0) return undefined;

  return {
    command: normalizeCommand(inspected),
    target: ".",
    validationLike: isValidationCommand(inspected),
  };
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
}

function isValidationCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b/iu.test(
      normalized,
    ) ||
    /\b(?:pytest|rspec|cargo\s+(?:test|check)|go\s+test|gradle\w*\s+(?:test|check|build)|mvn\w*\s+(?:test|verify)|make\s+(?:test|check|lint|build)|python3?\s+-m\s+json\.tool)\b/iu.test(
      normalized,
    ) ||
    /\b(?:test|check|lint|typecheck|build|validate)\b/iu.test(normalized)
  );
}

function isUrlLike(candidate: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate);
}

function shellPathCandidates(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((token) => token.replace(/^["'`([{]+|["'`)\]},;:]+$/gu, ""))
    .filter(
      (token) =>
        token.startsWith("./") ||
        token.startsWith("../") ||
        token.includes("/") ||
        /^[\w.-]+\.(?:json|ya?ml|toml|md|js|mjs|cjs|ts|tsx|py|rb|rs|go|java|sh)$/iu.test(token),
    );
}

function normalizeRepoPath(candidate: string, workingDirectory: string): string | undefined {
  if (!candidate || candidate.includes("\0") || isUrlLike(candidate)) return undefined;

  const root = path.resolve(workingDirectory);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);

  if (!relative) return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}
