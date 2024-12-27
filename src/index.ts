import fs from "node:fs/promises";
import * as path from "node:path";

import type { InputPluginOption } from "rollup";
import ts from "typescript";

import { createApi } from "./api.js";
import { type Options } from "./options.js";
import {
  type ResolvedModule,
  type ResolvedTSConfig,
  DTS_EXTENSIONS_REGEXP,
  TS_EXTENSIONS_REGEXP,
  createPrograms,
  formatHost,
  getModule,
  resolveTSConfig,
} from "./program.js";
import { transform } from "./transform/index.js";
import { sourceMapHelper } from "./utils/sourcemap-helper.js";

const plugin = (options: Options = {}): InputPluginOption => {
  const api = createApi(options);
  type Node = {
    path: string;
    parent?: Node;
    tsconfig: ResolvedTSConfig;
  };
  const nodes: Record<string, Node> = {};
  const resolvedTSConfigs: Record<string, ResolvedTSConfig> = {};
  return [
    {
      name: "dts",
      api,
      options(options) {
        let { input = [] } = options;
        if (!Array.isArray(input)) {
          input = typeof input === "string" ? [input] : Object.values(input);
        } else if (input.length > 1) {
          // when dealing with multiple unnamed inputs, transform the inputs into
          // an explicit object, which strips the file extension
          options.input = {};
          for (const filename of input) {
            let name = filename.replace(/((\.d)?\.(c|m)?(t|j)sx?)$/, "");
            if (path.isAbsolute(filename)) {
              name = path.basename(name);
            } else {
              name = path.normalize(name);
            }
            options.input[name] = filename;
          }
        }
        return options;
      },
      buildStart: {
        order: "post",
        handler: options => {
          const { ctx } = api;
          const { input = [] } = options;

          ctx.programs = createPrograms(
            Object.values(input),
            ctx.resolvedOptions.compilerOptions,
            ctx.resolvedOptions.tsconfig,
          );
        },
      },
      resolveId: {
        order: "post",
        handler(source, importer, { attributes }) {
          const { ctx } = api;

          if (!importer) {
            // store the entry point, because we need to know which program to add the file
            ctx.entries.push(path.resolve(source));
            return;
          }

          // normalize directory separators to forward slashes, as apparently typescript expects that?
          importer = importer.split("\\").join("/");

          let tsconfig: ResolvedTSConfig | undefined;
          let resolvedCompilerOptions = ctx.resolvedOptions.compilerOptions;
          if (ctx.resolvedOptions.tsconfig) {
            // Here we have a chicken and egg problem.
            // `source` would be resolved by `ts.nodeModuleNameResolver` a few lines below, but
            // `ts.nodeModuleNameResolver` requires `compilerOptions` which we have to resolve here,
            // since we have a custom `tsconfig.json`.
            // So, we use Node's resolver algorithm so we can see where the request is coming from so we
            // can load the custom `tsconfig.json` from the correct path.
            try {
              const resolvedSource = source.startsWith(".") ? path.resolve(path.dirname(importer), source) : source;
              tsconfig = resolveTSConfig(
                resolvedSource,
                ctx.resolvedOptions.compilerOptions,
                ctx.resolvedOptions.tsconfig,
              );
            } catch (e) {
              if (importer) {
                // if we can't resolve the source, we can resolve the importer
                tsconfig = nodes[importer]?.tsconfig ?? resolveTSConfig(
                  importer,
                  ctx.resolvedOptions.compilerOptions,
                  ctx.resolvedOptions.tsconfig,
                );
              } else {
                throw e;
              }
            }
            resolvedCompilerOptions = tsconfig.compilerOptions;
          }

          const resolutionMode = attributes["resolution-mode"];
          // resolve this via typescript
          const { resolvedModule } = ts.resolveModuleName(
            source,
            importer,
            {
              ...resolvedCompilerOptions,
              customConditions: resolutionMode
                ? [resolutionMode, ...(resolvedCompilerOptions.customConditions ?? [])]
                : resolvedCompilerOptions.customConditions,
            },
            ts.sys,
            undefined,
            undefined,
            resolutionMode === "require"
              ? ts.ModuleKind.CommonJS
              : resolutionMode === "import"
              ? ts.ModuleKind.ESNext
              : undefined,
          );
          if (!resolvedModule) {
            return;
          }

          // here, we define everything that comes from `node_modules` as `external`.
          const external = !ctx.resolvedOptions.respectExternal && resolvedModule.isExternalLibraryImport;
          const id = external
            ? source
            // using `path.resolve` here converts paths back to the system specific separators
            : path.resolve(resolvedModule.resolvedFileName);
          if (tsconfig) {
            resolvedTSConfigs[id] = tsconfig;
            nodes[id] = {
              path: id,
              // TODO a file can be imported by multiple files, so we should store all of them
              //      maybe we can store parent importer in the path id?
              parent: nodes[importer],
              tsconfig,
            };
          }
          return { id, external };
        },
      },
      async transform(inputCode, id) {
        if (!TS_EXTENSIONS_REGEXP.test(id)) return;

        const rollup = this;
        const { ctx } = api;

        const maybeIds: string[] = [];
        if (DTS_EXTENSIONS_REGEXP.test(id)) {
          maybeIds.push(id);
        } else {
          maybeIds.push(id.replace(TS_EXTENSIONS_REGEXP, ".d.$1ts"));
          maybeIds.push(id.replace(TS_EXTENSIONS_REGEXP, ".d.ts"));
          maybeIds.push(id.replace(TS_EXTENSIONS_REGEXP, ".d.cts"));
          maybeIds.push(id.replace(TS_EXTENSIONS_REGEXP, ".d.mts"));
        }
        for (const maybeId of maybeIds) {
          const module = getModule(ctx, maybeId, inputCode, resolvedTSConfigs[id]);
          if (!module || !module.source) continue;

          watchFiles(module);
          const { code, source } = module;
          const { fileName } = source;
          const mapFileName = fileName + ".map";
          const cacheSourcemap = api.id2Sourcemap.get(mapFileName);
          if (cacheSourcemap) {
            return {
              code,
              map: cacheSourcemap,
            };
          }
          const mapStr = await fs.readFile(mapFileName, "utf8").catch(() => undefined);
          const map = mapStr ? JSON.parse(mapStr) : undefined;
          api.id2Sourcemap.set(mapFileName, map);
          return {
            map,
            code,
          };
        }

        const module = getModule(ctx, id, inputCode);
        if (!module || !module.source || !module.program) return null;
        watchFiles(module);

        let generated!: {
          code?: string;
          map?: any;
          ast?: any;
        };
        const { emitSkipped, diagnostics } = module.program.emit(
          module.source,
          (fileName, declarationText) => {
            if (generated === undefined) generated = {};
            if (fileName.endsWith(".map")) {
              generated.map = JSON.parse(declarationText);
            } else {
              generated.code = declarationText.replace(/\n\/\/# sourceMappingURL=.+$/s, "\n");
            }
          },
          undefined, // cancellationToken
          true, // emitOnlyDtsFiles
          undefined, // customTransformers
          // @ts-ignore This is a private API for workers, should be safe to use as TypeScript Playground has used it for a long time.
          true, // forceDtsEmit
        );
        if (emitSkipped) {
          const errors = diagnostics.filter((diag) => diag.category === ts.DiagnosticCategory.Error);
          if (errors.length) {
            console.error(ts.formatDiagnostics(errors, formatHost));
            this.error("Failed to compile. Check the logs above.");
          }
        }
        api.id2Sourcemap.set(id, {
          ...generated.map,
          sourcesContent: [inputCode],
        });
        if (ctx.resolvedOptions.experimentalSourcemapSupport && generated.map) {
          try {
            const [ms] = await sourceMapHelper(generated.code!, {
              sourcemap: {
                ...generated.map,
                sourcesContent: [inputCode],
              },
            });
            // console.log(
            //   `${ms.toString()}\n//# sourceMappingURL=${
            //     ms.generateMap({ hires: "boundary", includeContent: true }).toUrl()
            //   }`,
            // );
            generated.map = ms.generateMap({ hires: "boundary" });
          } catch (e) {
            console.warn("Failed to generate source map for", id, e);
          }
        }
        // console.log(
        //   `${generated.code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${
        //     Buffer.from(JSON.stringify({
        //       ...generated.map,
        //       sourcesContent: [inputCode],
        //     })).toString("base64")
        //   }`,
        // );
        return generated;

        function watchFiles(module: ResolvedModule) {
          if (!module.program) return;

          const sourceDirectory = path.dirname(id);
          const sourceFilesInProgram = module.program
            .getSourceFiles()
            .map((sourceFile) => sourceFile.fileName)
            .filter((fileName) => fileName.startsWith(sourceDirectory));
          sourceFilesInProgram.forEach(rollup.addWatchFile);
        }
      },
    },
    transform(options),
  ];
};

export type { Options };

export { plugin as default, plugin as dts };

export { type Api, useDtsApi } from "./api.js";
