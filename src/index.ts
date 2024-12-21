import * as path from "node:path";
import type { InputPluginOption } from "rollup";
import ts from "typescript";
import { createApi } from "./api.js";
import { type Options } from "./options.js";
import {
  type ResolvedModule,
  DTS_EXTENSIONS,
  createPrograms,
  dts,
  formatHost,
  getCompilerOptions,
  getModule,
} from "./program.js";
import { transform } from "./transform/index.js";
import { sourceMapHelper } from "./utils/sourcemap-helper.js";

const TS_EXTENSIONS = /\.([cm]?[tj]sx?)$/;

const plugin = (options: Options = {}): InputPluginOption => {
  const api = createApi(options);
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
      transform(code, id) {
        const { ctx } = api;
        if (!TS_EXTENSIONS.test(id)) {
          return null;
        }

        const watchFiles = (module: ResolvedModule) => {
          if (module.program) {
            const sourceDirectory = path.dirname(id);
            const sourceFilesInProgram = module.program
              .getSourceFiles()
              .map((sourceFile) => sourceFile.fileName)
              .filter((fileName) => fileName.startsWith(sourceDirectory));
            sourceFilesInProgram.forEach(this.addWatchFile);
          }
        };

        const handleDtsFile = () => {
          const module = getModule(ctx, id, code);
          if (module) {
            watchFiles(module);
            // TODO sourcemap
            return module.code;
          }
          return null;
        };

        const treatTsAsDts = () => {
          const declarationId = id.replace(TS_EXTENSIONS, dts);
          const module = getModule(ctx, declarationId, code);
          if (module) {
            watchFiles(module);
            // TODO sourcemap
            return module.code;
          }
          return null;
        };

        const generateDtsFromTs = async () => {
          const module = getModule(ctx, id, code);
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
          if (generated.map) {
            try {
              const [ms] = await sourceMapHelper(generated.code!, {
                sourcemap: {
                  ...generated.map,
                  sourcesContent: [code],
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
          api.id2Sourcemap.set(id, {
            ...generated.map,
            sourcesContent: [code],
          });
          // console.log(
          //   `${generated.code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${
          //     Buffer.from(JSON.stringify({
          //       ...generated.map,
          //       sourcesContent: [code],
          //     })).toString("base64")
          //   }`,
          // );
          return generated;
        };

        // if it's a .d.ts file, handle it as-is
        if (DTS_EXTENSIONS.test(id)) return handleDtsFile();

        // first attempt to treat .ts files as .d.ts files, and otherwise use the typescript compiler to generate the declarations
        return treatTsAsDts() ?? generateDtsFromTs();
      },
      resolveId: {
        order: "post",
        handler(source, importer) {
          const { ctx } = api;

          if (!importer) {
            // store the entry point, because we need to know which program to add the file
            ctx.entries.push(path.resolve(source));
            return;
          }

          // normalize directory separators to forward slashes, as apparently typescript expects that?
          importer = importer.split("\\").join("/");

          let resolvedCompilerOptions = ctx.resolvedOptions.compilerOptions;
          if (ctx.resolvedOptions.tsconfig) {
            // Here we have a chicken and egg problem.
            // `source` would be resolved by `ts.nodeModuleNameResolver` a few lines below, but
            // `ts.nodeModuleNameResolver` requires `compilerOptions` which we have to resolve here,
            // since we have a custom `tsconfig.json`.
            // So, we use Node's resolver algorithm so we can see where the request is coming from so we
            // can load the custom `tsconfig.json` from the correct path.
            const resolvedSource = source.startsWith(".") ? path.resolve(path.dirname(importer), source) : source;
            resolvedCompilerOptions = getCompilerOptions(
              resolvedSource,
              ctx.resolvedOptions.compilerOptions,
              ctx.resolvedOptions.tsconfig,
            ).compilerOptions;
          }

          // resolve this via typescript
          const { resolvedModule } = ts.resolveModuleName(source, importer, resolvedCompilerOptions, ts.sys);
          if (!resolvedModule) {
            return;
          }

          if (!ctx.resolvedOptions.respectExternal && resolvedModule.isExternalLibraryImport) {
            // here, we define everything that comes from `node_modules` as `external`.
            return { id: source, external: true };
          } else {
            // using `path.resolve` here converts paths back to the system specific separators
            return { id: path.resolve(resolvedModule.resolvedFileName) };
          }
        },
      },
    },
    transform(),
  ];
};

export type { Options };

export { plugin as default, plugin as dts };

export { type Api, useDtsApi } from "./api.js";
