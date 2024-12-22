import * as path from "node:path";

import type { Plugin } from "rollup";
import ts from "typescript";

import { type Api, useDtsApi } from "../api.js";
import type { Options, Path } from "../options.js";
import { getTextHelper, sourceMapHelper } from "../utils/sourcemap-helper.js";
import { ExportsFinder } from "./ExportsFinder.js";
import { NamespaceFinder } from "./NamespaceFinder.js";
import { convert } from "./Transformer.js";
import { preProcess } from "./preprocess.js";

function parse(fileName: string, code: string): ts.SourceFile {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

/**
 * This is the *transform* part of `rollup-plugin-dts`.
 *
 * It sets a few input and output options, and otherwise is the core part of the
 * plugin responsible for bundling `.d.ts` files.
 *
 * That itself is a multi-step process:
 *
 * 1. The plugin has a preprocessing step that moves code around and cleans it
 *    up a bit, so that later steps can work with it easier. See `preprocess.ts`.
 * 2. It then converts the TypeScript AST into a ESTree-like AST that rollup
 *    understands. See `Transformer.ts`.
 * 3. After rollup is finished, the plugin will postprocess the output in a
 *    `renderChunk` hook. As rollup usually outputs javascript, it can output
 *    some code that is invalid in the context of a `.d.ts` file. In particular,
 *    the postprocess convert any javascript code that was created for namespace
 *    exports into TypeScript namespaces. See `NamespaceFixer.ts`.
 */
export const transform = ({
  jsdocExplorer,
}: Options) => {
  const allTypeReferences = new Map<string, Set<string>>();
  const allFileReferences = new Map<string, Set<string>>();

  let api!: Api;
  return {
    name: "dts:transform",
    buildStart(options) {
      api = useDtsApi(options);
    },
    options({ onLog, ...options }) {
      return {
        ...options,
        onLog(level, log, defaultHandler) {
          if (level === "warn" && log.code === "CIRCULAR_DEPENDENCY") {
            return;
          }
          if (onLog) {
            onLog(level, log, defaultHandler);
          } else {
            defaultHandler(level, log);
          }
        },
        treeshake: {
          moduleSideEffects: "no-external",
          propertyReadSideEffects: true,
          unknownGlobalSideEffects: false,
        },
      };
    },
    outputOptions(options) {
      return {
        ...options,
        chunkFileNames: options.chunkFileNames || "[name]-[hash].d.ts",
        entryFileNames: options.entryFileNames || "[name].d.ts",
        format: "es",
        exports: "named",
        compact: false,
        freeze: true,
        interop: "esModule",
        generatedCode: Object.assign({ symbols: false }, options.generatedCode),
        strict: false,
      };
    },
    async transform(code, id) {
      const sourcemap = api.id2Sourcemap.get(id);
      let sourceFile = parse(id, code);
      const { typeReferences, fileReferences, ms } = await preProcess({
        sourceFile,
        sourcemap,
      });
      // `sourceFile.fileName` here uses forward slashes
      allTypeReferences.set(sourceFile.fileName, typeReferences);
      allFileReferences.set(sourceFile.fileName, fileReferences);

      const newCode = ms.toString();
      // console.log(
      //   `${ms.toString()}\n//# sourceMappingURL=${ms.generateMap({ hires: "boundary", includeContent: true }).toUrl()}`,
      // );
      return {
        code: newCode,
        map: ms.generateMap({ hires: "boundary" }),
        ast: convert({
          sourceFile: parse(id, newCode),
        }).ast as any,
      };
    },
    async renderChunk(inputCode, chunk, options) {
      const enableSourceMap = options.sourcemap !== "hidden" && options.sourcemap !== false;
      const [ms] = await sourceMapHelper(inputCode, {
        mock: !enableSourceMap,
      });

      const typeReferences = new Set<string>();
      const fileReferences = new Set<string>();
      for (const fileName of Object.keys(chunk.modules)) {
        for (const ref of allTypeReferences.get(fileName.split("\\").join("/")) || []) {
          typeReferences.add(ref);
        }
        for (const ref of allFileReferences.get(fileName.split("\\").join("/")) || []) {
          if (ref.startsWith(".")) {
            // Need absolute path of the target file here
            const absolutePathToOriginal = path.join(path.dirname(fileName), ref);
            const chunkFolder = (options.file && path.dirname(options.file))
              || (chunk.facadeModuleId && path.dirname(chunk.facadeModuleId!))
              || ".";
            let targetRelPath = path.relative(chunkFolder, absolutePathToOriginal).split("\\").join("/");
            if (targetRelPath[0] !== ".") {
              targetRelPath = "./" + targetRelPath;
            }
            fileReferences.add(targetRelPath);
          } else {
            fileReferences.add(ref);
          }
        }
      }

      const refLines = [
        ...Array.from(fileReferences, (ref) => `/// <reference path="${ref}" />`),
        ...Array.from(typeReferences, (ref) => `/// <reference types="${ref}" />`),
        "",
      ];
      refLines.length > 1
        && ms.prepend(refLines.join("\n"));

      let code = ms.toString();
      if (code === "") {
        return "export {  }";
      }

      const sourceFile = parse(chunk.fileName, code);
      const emitJSDoc = async (stmt: ts.Statement, paths: readonly Path[] = []) => {
        const [jsdoc] = ts.getJSDocCommentsAndTags(stmt);
        let shouldRecursive = true;
        if (jsdoc) {
          if (!ts.isJSDoc(jsdoc)) {
            throw new Error("Expected JSDoc");
          }
          let id: string | undefined;
          if (
            "name" in stmt && ts.isIdentifier(
              // @ts-expect-error
              stmt.name,
            )
          ) {
            id = stmt.name.text;
          }
          if (ts.isVariableStatement(stmt)) {
            id = stmt.declarationList.declarations[0]?.name.getText();
          }
          await jsdocExplorer?.call(this, jsdoc, {
            ts,
            input: chunk.facadeModuleId,
            output: chunk.fileName,
            paths: [...paths, id ?? "unknown"],
            chunk,
            sourceFile,
            stopRecursive() {
              shouldRecursive = false;
            },
          });
        }
        if (!shouldRecursive) return;

        if (ts.isModuleDeclaration(stmt) && stmt.body) {
          const newPaths = [...paths, stmt.name.text];
          if (ts.isModuleBlock(stmt.body)) {
            await Promise.all(stmt.body.statements.map(s => emitJSDoc(s, newPaths)));
          }
          if (ts.isModuleDeclaration(stmt.body)) {
            await emitJSDoc(stmt.body, newPaths);
          }
        }
      };
      await Promise.all(sourceFile.statements.map(s => emitJSDoc(s)));

      for (let [location, generatedCode] of new NamespaceFinder(sourceFile).run()) {
        const originalCode = code.slice(location.start, location.end);
        if (originalCode === generatedCode) continue;

        ms.update(location.start, location.end, generatedCode);
      }

      code = ms.toString();
      // console.log(
      //   `${ms.toString()}\n//# sourceMappingURL=${ms.generateMap({ hires: "boundary", includeContent: true }).toUrl()}`,
      // );
      let offset = 0;
      for (let [location, generatedCode] of new ExportsFinder(parse(chunk.fileName, code)).run()) {
        const originalCode = code.slice(location.start, location.end);
        if (originalCode === generatedCode) continue;

        await ms.updateByGenerated(location.start + offset, location.end + offset, generatedCode, {
          overrideOriginalTextHelper: enableSourceMap ? getTextHelper(inputCode) : undefined,
        });
        offset += generatedCode.length - originalCode.length;
      }
      code = ms.toString();
      if (!enableSourceMap) {
        return code;
      }

      // console.log(
      //   `${ms.toString()}\n//# sourceMappingURL=${ms.generateMap({ hires: "boundary", includeContent: true }).toUrl()}`,
      // );
      return {
        code,
        map: ms.generateMap({ hires: "boundary" }),
      };
    },
  } satisfies Plugin;
};
