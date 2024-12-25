import * as path from "node:path";
import ts from "typescript";

import type { DtsPluginContext } from "./api.js";

export const TS_EXTENSIONS_REGEXP = /\.([cm]?)[tj]sx?$/;

export const DTS_EXTENSIONS_REGEXP = /\.d(\.[^.]+)?\.([cm])?ts$/;

export const formatHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  getNewLine: () => ts.sys.newLine,
  getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? (f) => f : (f) => f.toLowerCase(),
};

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  // Ensure ".d.ts" modules are generated
  declaration: true,
  // Skip ".js" generation
  noEmit: false,
  emitDeclarationOnly: true,
  // Skip code generation when error occurs
  noEmitOnError: true,
  // Avoid extra work
  checkJs: false,
  declarationMap: true,
  skipLibCheck: true,
  // Ensure TS2742 errors are visible
  preserveSymlinks: true,
  // Ensure we can parse the latest code
  target: ts.ScriptTarget.ESNext,
};

const configByPath = new Map<string, ts.ParsedCommandLine>();

const logCache = (...args: unknown[]) => (process.env.DTS_LOG_CACHE ? console.log("[cache]", ...args) : null);

/**
 * Caches the config for every path between two given paths.
 *
 * It starts from the first path and walks up the directory tree until it reaches the second path.
 */
function cacheConfig([fromPath, toPath]: [from: string, to: string], config: ts.ParsedCommandLine) {
  logCache(fromPath);
  configByPath.set(fromPath, config);
  while (
    fromPath !== toPath
    // make sure we're not stuck in an infinite loop
    && fromPath !== path.dirname(fromPath)
  ) {
    fromPath = path.dirname(fromPath);
    logCache("up", fromPath);
    if (configByPath.has(fromPath)) return logCache("has", fromPath);
    configByPath.set(fromPath, config);
  }
}

export interface ResolvedTSConfig {
  dtsFiles: Array<string>;
  dirName: string;
  compilerOptions: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
}

export function resolveTSConfig(
  input: string,
  overrideOptions: ts.CompilerOptions,
  overrideConfigPath?: string,
): ResolvedTSConfig {
  const compilerOptions = { ...DEFAULT_OPTIONS, ...overrideOptions };
  let dirName = path.dirname(input);
  let dtsFiles: Array<string> = [];

  // if a custom config is provided we'll use that as the cache key since it will always be used
  const cacheKey = overrideConfigPath || dirName;
  if (!configByPath.has(cacheKey)) {
    logCache("miss", cacheKey);
    const configPath = overrideConfigPath
      ? path.resolve(process.cwd(), overrideConfigPath)
      : ts.findConfigFile(dirName, ts.sys.fileExists);
    if (!configPath) {
      return { dtsFiles, dirName, compilerOptions };
    }
    const inputDirName = dirName;
    dirName = path.dirname(configPath);
    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
    if (error) {
      console.error(ts.formatDiagnostic(error, formatHost));
      return { dtsFiles, dirName, compilerOptions };
    }
    logCache("tsconfig", config);
    const configContents = ts.parseJsonConfigFileContent(config, ts.sys, dirName);
    if (overrideConfigPath) {
      // if a custom config is provided, we always only use that one
      cacheConfig([overrideConfigPath, overrideConfigPath], configContents);
    } else {
      // cache the config for all directories between input and resolved config path
      cacheConfig([inputDirName, dirName], configContents);
    }
  } else {
    logCache("HIT", cacheKey);
  }
  const { fileNames, projectReferences = [], options, errors } = configByPath.get(cacheKey)!;
  let forceReturn = false;
  for (const key of Object.keys(options.paths ?? {})) {
    const reg = new RegExp(
      key
        .replace(".", "\\.")
        .replace(/\//g, "\\/")
        .replace(/\*/g, ".*"),
    );
    if (reg.test(input)) {
      forceReturn = true;
      break;
    }
  }
  if (
    {
      ...compilerOptions,
      ...options,
    }.allowJs && input.endsWith(".js")
  ) {
    forceReturn = true;
  }

  const maybeInputs = [input];
  if (TS_EXTENSIONS_REGEXP.test(input)) {
    if (!DTS_EXTENSIONS_REGEXP.test(input)) {
      if (!/\.[cm]?tsx?$/.test(input)) {
        maybeInputs.push(
          input + ".ts",
          input + ".tsx",
          input + ".cts",
          input + ".ctsx",
          input + ".mts",
          input + ".mtsx",
        );
      }
      if (/\.[cm]?jsx?$/.test(input)) {
        maybeInputs.push(
          input.replace(/\.([cm])?jsx?$/, ".d.$1ts"),
          input.replace(/\.([cm])?js(x)?$/, ".$1ts$2"),
        );
      }
    }
  } else {
    // https://www.typescriptlang.org/docs/handbook/modules/theory.html#the-role-of-declaration-files
    // Declaration file extension .d.*.ts
    // JavaScript file extension 	.*
    maybeInputs.push(input.replace(/\.([^.]+)$/, ".d.$1.ts"));
    // if not found file which is standard declaration file rule, try to find other declaration file rule
    maybeInputs.push(input + ".ts");
    maybeInputs.push(input + ".tsx");
    maybeInputs.push(input + ".cts");
    maybeInputs.push(input + ".ctsx");
    maybeInputs.push(input + ".mts");
    maybeInputs.push(input + ".mtsx");
    maybeInputs.push(input + ".d.ts");
    maybeInputs.push(input + ".d.cts");
    maybeInputs.push(input + ".d.mts");
  }
  if (!/\/index\.[cm]?[jt]sx?$/.test(input)) {
    maybeInputs.push(
      input + "/index.ts",
      input + "/index.cts",
      input + "/index.mts",
      input + "/index.tsx",
    );
  }
  if (!/\/index\.d\.ts$/.test(input) && !/\/index\.ts$/.test(input)) {
    maybeInputs.push(
      input + "/index.d.ts",
    );
  }
  if (!/\/index\.d\.cts$/.test(input) && !/\/index\.cts$/.test(input)) {
    maybeInputs.push(
      input + "/index.d.cts",
    );
  }
  if (!/\/index\.d\.mts$/.test(input) && !/\/index\.mts$/.test(input)) {
    maybeInputs.push(
      input + "/index.d.mts",
    );
  }
  let isInclude = fileNames.findIndex((name) => maybeInputs.includes(name)) !== -1;

  if (isInclude || forceReturn) {
    dtsFiles = fileNames.filter((name) => DTS_EXTENSIONS_REGEXP.test(name));
    if (errors.length) {
      console.error(ts.formatDiagnostics(errors, formatHost));
      return { dtsFiles, dirName, compilerOptions };
    }
    return {
      dtsFiles,
      dirName,
      projectReferences,
      compilerOptions: {
        ...compilerOptions,
        ...options,
      },
    };
  }

  for (const ref of projectReferences) {
    try {
      return resolveTSConfig(input, overrideOptions, ref.path);
    } catch (e) {}
  }

  throw new Error(`Module ${input} is not included in the tsconfig project: ${cacheKey}`);
}

export function createProgram(
  fileName: string,
  overrideOptions: ts.CompilerOptions,
  tsconfig?: string,
  resolvedTSConfig?: ResolvedTSConfig,
) {
  const { dtsFiles, projectReferences, compilerOptions } = resolvedTSConfig ?? resolveTSConfig(
    fileName,
    overrideOptions,
    tsconfig,
  );
  return ts.createProgram({
    rootNames: [fileName].concat(Array.from(dtsFiles)),
    options: compilerOptions,
    host: ts.createCompilerHost(compilerOptions, true),
    projectReferences: projectReferences,
  });
}

export function createPrograms(
  input: Array<string>,
  overrideOptions: ts.CompilerOptions,
  tsconfig?: string,
) {
  const programs = [];
  const dtsFiles: Set<string> = new Set();
  let inputs: Array<string> = [];
  let dirName = "";
  let compilerOptions: ts.CompilerOptions = {};
  let projectReferences: undefined | readonly ts.ProjectReference[] = [];

  for (let main of input) {
    if (DTS_EXTENSIONS_REGEXP.test(main)) {
      continue;
    }

    main = path.resolve(main);
    const options = resolveTSConfig(main, overrideOptions, tsconfig);
    options.dtsFiles.forEach(dtsFiles.add, dtsFiles);

    if (!inputs.length) {
      inputs.push(main);
      ({ dirName, compilerOptions, projectReferences } = options);
      continue;
    }

    if (options.dirName === dirName) {
      inputs.push(main);
    } else {
      const program = ts.createProgram({
        rootNames: inputs.concat(Array.from(dtsFiles)),
        options: compilerOptions,
        host: ts.createCompilerHost(compilerOptions, true),
        projectReferences,
      });
      programs.push(program);

      inputs = [main];
      ({ dirName, compilerOptions } = options);
    }
  }

  if (inputs.length) {
    const host = ts.createCompilerHost(compilerOptions, true);
    const program = ts.createProgram({
      rootNames: inputs.concat(Array.from(dtsFiles)),
      options: compilerOptions,
      host,
      projectReferences,
    });
    programs.push(program);
  }

  return programs;
}

export interface ResolvedModule {
  code: string;
  source?: ts.SourceFile;
  program?: ts.Program;
}

const refPrograms = new Map<string, ts.Program>();

export function getModule(
  { entries, programs, resolvedOptions: { compilerOptions, tsconfig } }: DtsPluginContext,
  fileName: string,
  code: string,
  resolvedTSConfig?: ResolvedTSConfig,
): ResolvedModule | null {
  // Create any `ts.SourceFile` objects on-demand for ".d.ts" modules,
  // but only when there are zero ".ts" entry points.
  if (!programs.length && DTS_EXTENSIONS_REGEXP.test(fileName)) {
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
  }
  if (ts.sys.fileExists(fileName)) {
    const newProgram = createProgram(fileName, compilerOptions, tsconfig, resolvedTSConfig);
    programs.push(newProgram);
    // we created hte program from this fileName, so the source file must exist :P
    const source = newProgram.getSourceFile(fileName)!;
    return {
      code: source?.getFullText(),
      source,
      program: newProgram,
    };
  }
  // the file isn't part of an existing program and doesn't exist on disk
  return null;
}
