import type { ExistingRawSourceMap, NormalizedInputOptions } from "rollup";
import ts from "typescript";
import { type Options, type ResolvedOptions, resolveDefaultOptions } from "./options.js";

export interface DtsPluginContext {
  /**
   * The entry points of the bundle.
   */
  entries: string[];
  /**
   * There exists one Program object per entry point, except when all entry points are ".d.ts" modules.
   */
  programs: ts.Program[];
  resolvedOptions: ResolvedOptions;
}

export interface Api {
  ctx: DtsPluginContext;
  /**
   * @internal
   */
  id2Sourcemap: Map<string, ExistingRawSourceMap>;
}

export function createApi(options: Options): Api {
  return {
    ctx: {
      entries: [],
      programs: [],
      resolvedOptions: resolveDefaultOptions(options),
    },
    id2Sourcemap: new Map(),
  };
}

/**
 * Get the API object for the `dts` plugin.
 * @example
 * let dtsApi = useDtsApi(options);
 * return {
 *   name: "your-plugin",
 *   buildStart(options) {
 *     const dtsApi = useDtsApi(options);
 *   }
 * }
 */
export function useDtsApi({ plugins }: Pick<NormalizedInputOptions, "plugins">) {
  const parentPlugin = plugins.find((plugin) => plugin.name === "dts");
  if (!parentPlugin) {
    throw new Error("The `dts` plugin must be included in the Rollup configuration.");
  }
  return parentPlugin.api as ReturnType<typeof createApi>;
}
