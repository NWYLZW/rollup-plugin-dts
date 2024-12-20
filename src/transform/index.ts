import * as path from "node:path";
import type { Plugin } from "rollup";
import ts from "typescript";
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
export const transform = () => {
  const allTypeReferences = new Map<string, Set<string>>();
  const allFileReferences = new Map<string, Set<string>>();

  return {
    name: "dts:transform",

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

    async transform(code, fileName) {
      let sourceFile = parse(fileName, code);
      const { typeReferences, fileReferences, ms } = preProcess({ sourceFile });
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
          sourceFile: parse(fileName, newCode),
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

      for (let [location, generatedCode] of new NamespaceFinder(parse(chunk.fileName, code)).fix()) {
        const originalCode = code.slice(location.start, location.end);
        if (originalCode === generatedCode) continue;

        ms.update(location.start, location.end, generatedCode);
      }

      code = ms.toString();
      // console.log(
      //   `${ms.toString()}\n//# sourceMappingURL=${ms.generateMap({ hires: "boundary", includeContent: true }).toUrl()}`,
      // );
      let offset = 0;
      for (let [location, generatedCode] of new ExportsFinder(parse(chunk.fileName, code)).findExports()) {
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
