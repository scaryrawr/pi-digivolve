import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "pi-digivolve.json";

/**
 * User-level pi-digivolve configuration persisted under pi's agent directory.
 */
export interface DigivolveConfig {
  /** Whether automatic end-of-session reflection is enabled. Defaults to true. */
  enabled?: boolean;

  /** Optional model to use for reflection sessions. Falls back to the main session's model. */
  reflectionModel?: {
    /** The model id. */
    id: string;
    /** The model provider. */
    provider: string;
  };
}

/**
 * Represents a model identifier with provider and model id.
 */
export type ModelIdentifier = NonNullable<DigivolveConfig["reflectionModel"]>;

/**
 * Returns whether a value is a non-array object that can be inspected as JSON.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Gets the absolute path to the pi-digivolve configuration file.
 */
export function getDigivolveConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

/**
 * Parse unknown JSON into the supported pi-digivolve configuration shape.
 * Invalid or unknown values are ignored so a malformed config does not prevent
 * pi from starting.
 */
function parseConfig(value: unknown): DigivolveConfig {
  if (!isRecord(value)) return {};

  const config: DigivolveConfig = {};
  if (typeof value.enabled === "boolean") {
    config.enabled = value.enabled;
  }
  if (
    isRecord(value.reflectionModel) &&
    typeof value.reflectionModel.id === "string" &&
    typeof value.reflectionModel.provider === "string"
  ) {
    config.reflectionModel = {
      id: value.reflectionModel.id,
      provider: value.reflectionModel.provider,
    };
  }
  return config;
}

/**
 * Reads the pi-digivolve configuration from disk.
 *
 * Returns an empty config when the file does not exist or cannot be parsed.
 */
function readConfig(): DigivolveConfig {
  const configPath = getDigivolveConfigPath();
  if (!existsSync(configPath)) return {};

  try {
    return parseConfig(JSON.parse(readFileSync(configPath, "utf-8")));
  } catch {
    return {};
  }
}

/**
 * Manages persistent pi-digivolve configuration.
 */
export class DigivolveConfigManager {
  private config: DigivolveConfig;

  /**
   * Load configuration from disk.
   */
  constructor() {
    this.config = readConfig();
  }

  /**
   * Gets the full path to the managed config file.
   */
  get path(): string {
    return getDigivolveConfigPath();
  }

  /**
   * Gets whether automatic digivolution reflection is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled ?? true;
  }

  /**
   * Updates whether automatic digivolution reflection is enabled and persists
   * the new setting to disk.
   */
  set enabled(enabled: boolean) {
    this.config = {
      ...this.config,
      enabled,
    };
    this.writeConfig();
  }

  /**
   * Gets the configured reflection model identifier. Returns undefined when no
   * dedicated model is set (the reflection session will use the main session's
   * model as a fallback).
   */
  get reflectionModel(): ModelIdentifier | undefined {
    return this.config.reflectionModel;
  }

  /**
   * Sets the reflection model identifier and persists it to disk. Pass
   * `undefined` to clear the setting and fall back to the main session's model.
   */
  set reflectionModel(modelIdentifier: ModelIdentifier | undefined) {
    if (modelIdentifier === undefined) {
      const next = { ...this.config };
      delete next.reflectionModel;
      this.config = next;
    } else {
      this.config = {
        ...this.config,
        reflectionModel: modelIdentifier,
      };
    }
    this.writeConfig();
  }

  /**
   * Writes the current configuration to disk.
   */
  private writeConfig(): void {
    const configPath = getDigivolveConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf-8");
  }
}
