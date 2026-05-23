import path from 'node:path';
import { cosmiconfig } from 'cosmiconfig';
import { CosmiconfigResult } from 'cosmiconfig/dist/types.js';
import { Config } from './interfaces/config.js';

export class ConfigLoader {
  /**
   * Load config from disk, looks for `.gibbons-postgresqlrc` file by default.
   * @see For Usage {@link https://github.com/davidtheclark/cosmiconfig}
   *
   * @param module - Cosmiconfig module name (defaults to `gibbons-postgresql`)
   * @param filepath - Optional explicit path to a config file
   * @throws {Error} When no config file could be resolved
   *
   * @example
   * ```typescript
   * // Load config from default locations (.gibbons-postgresqlrc, package.json, etc.)
   * const config = await ConfigLoader.load();
   *
   * // Load config from specific file
   * const config = await ConfigLoader.load('gibbons-postgresql', './my-config.json');
   * ```
   */
  public static async load(
    module = 'gibbons-postgresql',
    filepath?: string
  ): Promise<Config> {
    const explorer = cosmiconfig(module || 'gibbons-postgresql');

    const resolved = filepath ? path.resolve(filepath) : undefined;
    if (resolved?.includes('\0')) {
      throw new Error('Invalid filepath: null bytes are not allowed');
    }

    const configResult = (
      resolved ? await explorer.load(resolved) : await explorer.search()
    ) as CosmiconfigResult;

    if (!configResult?.config) {
      throw new Error(
        'Could not load config, execute `npx gibbons-postgresql init`'
      );
    }
    const { config } = configResult;
    return config;
  }
}
