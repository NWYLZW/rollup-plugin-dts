import type { PluginContext, RenderedChunk } from "rollup";
import type ts from "typescript";

export const moduleSymbol = Symbol();

export const globalSymbol = Symbol();

export const namespaceSymbol = Symbol();

export type Path =
  | string
  | [typeof moduleSymbol, string]
  | [typeof globalSymbol]
  | [typeof namespaceSymbol, ...[string, ...string[]]];

export interface Options {
  /**
   * The plugin will by default flag *all* external libraries as `external`,
   * and thus prevent them from be bundled.
   * If you set the `respectExternal` option to `true`, the plugin will not do
   * any default classification, but rather use the `external` option as
   * configured via rollup.
   */
  respectExternal?: boolean;
  /**
   * In case you want to use TypeScript path-mapping feature, using the
   * `baseUrl` and `paths` properties, you can pass in `compilerOptions`.
   */
  compilerOptions?: ts.CompilerOptions;
  /**
   * Path to tsconfig.json, by default, will try to load 'tsconfig.json'
   */
  tsconfig?: string;
  /**
   * @see https://jsdoc.app/
   * @see https://tsdoc.org/
   * @see https://github.com/microsoft/tsdoc/issues/21 microsoft/tsdoc#21
   */
  jsdocExplorer?: (
    this: PluginContext,
    jsdoc: ts.JSDoc,
    context: {
      ts: typeof ts;
      input: string | null;
      output: string;
      paths: Path[];
      chunk: RenderedChunk;
      sourceFile: ts.SourceFile;
      stopRecursive: () => void;
    },
  ) => void | Promise<void>;
}

export function resolveDefaultOptions(options: Options) {
  return {
    ...options,
    compilerOptions: options.compilerOptions ?? {},
    respectExternal: options.respectExternal ?? false,
  };
}

export type ResolvedOptions = ReturnType<typeof resolveDefaultOptions>;
