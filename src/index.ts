import * as path from "node:path";
import type { InputPluginOption } from "rollup";
import ts from "typescript";
import { createApi } from "./api.js";
import { type Options, type ResolvedOptions } from "./options.js";
import { DTS_EXTENSIONS, createProgram, createPrograms, dts, formatHost, getCompilerOptions } from "./program.js";
import { transform } from "./transform/index.js";
import { sourceMapHelper } from "./utils/sourcemap-helper.js";

export type { Options };

const TS_EXTENSIONS = /\.([cm]?[tj]sx?)$/;

interface DtsPluginContext {
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

interface ResolvedModule {
  code: string;
  source?: ts.SourceFile;
  program?: ts.Program;
}

const refPrograms = new Map<string, ts.Program>();

function getModule(
  { entries, programs, resolvedOptions: { compilerOptions, tsconfig } }: DtsPluginContext,
  fileName: string,
  code: string,
): ResolvedModule | null {
  // Create any `ts.SourceFile` objects on-demand for ".d.ts" modules,
  // but only when there are zero ".ts" entry points.
  if (!programs.length && DTS_EXTENSIONS.test(fileName)) {
    return { code };
  }

  const isEntry = entries.includes(fileName);
  // Rollup doesn't tell you the entry point of each module in the bundle,
  // so we need to ask every TypeScript program for the given filename.
  let existingProgram = programs.find((p) => {
    // Entry points may be in the other entry source files, but it can't emit from them.
    // So we should find the program about the entry point which is the root files.
    if (isEntry) {
      return p.getRootFileNames().includes(fileName);
    } else {
      const sourceFile = p.getSourceFile(fileName);
      if (sourceFile && p.isSourceFileFromExternalLibrary(sourceFile)) {
        return false;
      }
      return !!sourceFile;
    }
  });
  existingProgram?.getResolvedProjectReferences()?.forEach(ref => {
    if (ref === undefined || ref.commandLine === undefined) return;

    const { commandLine, sourceFile: tsconfigSourceFile } = ref;
    let program = refPrograms.get(tsconfigSourceFile.fileName);
    if (!program) {
      program = ts.createProgram({
        rootNames: commandLine.fileNames,
        options: commandLine.options,
        host: ts.createCompilerHost(commandLine.options, true),
        projectReferences: commandLine.projectReferences,
      });
    }
    refPrograms.set(tsconfigSourceFile.fileName, program);

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile || sourceFile && program.isSourceFileFromExternalLibrary(sourceFile)) {
      return;
    }
    existingProgram = program;
  });
  if (existingProgram) {
    // we know this exists b/c of the .filter above, so this non-null assertion is safe
    const source = existingProgram.getSourceFile(fileName)!;
    return {
      code: source?.getFullText(),
      source,
      program: existingProgram,
    };
  } else if (ts.sys.fileExists(fileName)) {
    const newProgram = createProgram(fileName, compilerOptions, tsconfig);
    programs.push(newProgram);
    // we created hte program from this fileName, so the source file must exist :P
    const source = newProgram.getSourceFile(fileName)!;
    return {
      code: source?.getFullText(),
      source,
      program: newProgram,
    };
  } else {
    // the file isn't part of an existing program and doesn't exist on disk
    return null;
  }
}

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
            // return transformPlugin.transform.call(this, module.code, id);
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
            // return transformPlugin.transform.call(this, module.code, declarationId);
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
          }
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

export { plugin as default, plugin as dts };

export { type Api, useDtsApi } from "./api.js";
