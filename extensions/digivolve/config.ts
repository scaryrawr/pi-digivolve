import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

const CONFIG_FILE_NAME = "pi-digivolve.json";

const DigivolveConfigSchema = Type.Object({
  /** Whether automatic end-of-session reflection is enabled. Defaults to true. */
  enabled: Type.Optional(Type.Boolean()),
});

/**
 * User-level pi-digivolve configuration persisted under pi's agent directory.
 */
export type DigivolveConfig = Static<typeof DigivolveConfigSchema>;

/**
 * Gets the absolute path to the pi-digivolve configuration file.
 */
export function getDigivolveConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

/**
 * Reads the pi-digivolve configuration from disk.
 *
 * Returns an empty config when the file does not exist, cannot be parsed, or
 * does not match the supported configuration schema. Unknown values are ignored
 * so a malformed config does not prevent pi from starting.
 */
function readConfig(): DigivolveConfig {
  const configPath = getDigivolveConfigPath();

  if (!existsSync(configPath)) return {};

  try {
    const json: unknown = JSON.parse(readFileSync(configPath, "utf-8"));

    return Value.Check(DigivolveConfigSchema, json) ? json : {};
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
   * Writes the current configuration to disk.
   */
  private writeConfig(): void {
    const configPath = getDigivolveConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf-8");
  }
}
