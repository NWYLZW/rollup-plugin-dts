import MagicString from "magic-string";
import ts from "typescript";

import type { ExistingRawSourceMap } from "rollup";
import { type MappedPosition, SourceMapConsumer } from "source-map";
import { getTextHelper } from "../utils/sourcemap-helper.js";
import { matchesModifier } from "./astHelpers.js";
import { UnsupportedSyntaxError } from "./errors.js";

type Range = [start: number, end: number];

interface PreProcessOutput {
  ms: MagicString;
  typeReferences: Set<string>;
  fileReferences: Set<string>;
}

/**
 * The pre-process step has the following goals:
 * - [x] Fixes the "modifiers", removing any `export` modifier and adding any
 *   missing `declare` modifier.
 * - [x] Splitting compound `VariableStatement` into its parts.
 * - [x] Moving declarations for the same "name" to be next to each other.
 * - [x] Removing any triple-slash directives and recording them.
 * - [x] Create a synthetic name for any nameless "export default".
 * - [x] Resolve inline `import()` statements and generate top-level imports for
 *   them.
 * - [x] Generate a separate `export {}` statement for any item which had its
 *   modifiers rewritten.
 * - [ ] Duplicate the identifiers of a namespace `export`, so that renaming does
 *   not break it
 */
export async function preProcess({
  sourceFile,
  sourcemap,
}: {
  sourceFile: ts.SourceFile;
  sourcemap?: ExistingRawSourceMap;
}): Promise<PreProcessOutput> {
  const ms = new MagicString(sourceFile.getFullText());

  if (sourcemap) {
    const consumer = await new SourceMapConsumer({
      file: ".",
      ...sourcemap,
    });
    const original = consumer.sourcesContent[0]!;
    const originalTextHelper = getTextHelper(original);
    /**
     * 根据 sourcemap 还原原本在 import、dynamic import 或者 export 中的 import attributes
     */
    for (const node of sourceFile.statements) {
      if (
        ts.isImportDeclaration(node)
        || ts.isExportDeclaration(node)
      ) {
        if (node.attributes) continue;
        const endLineAndCharacter = sourceFile.getLineAndCharacterOfPosition(node.end - 1);
        const originalEndLineAndColumn = consumer.originalPositionFor({
          line: endLineAndCharacter.line + 1,
          column: endLineAndCharacter.character,
        }) as MappedPosition;
        if (originalEndLineAndColumn.line === null || originalEndLineAndColumn.column === null) continue;
        const start = originalTextHelper.getPositionOfLineAndColmn(
          originalEndLineAndColumn.line,
          originalEndLineAndColumn.column,
        );

        const nextLineOriginalEndLineAndColumn = consumer.originalPositionFor({
          line: endLineAndCharacter.line + 2,
          column: 0,
        });
        let end: number;
        if (nextLineOriginalEndLineAndColumn.line === null || nextLineOriginalEndLineAndColumn.column === null) {
          end = originalTextHelper.raw.length - 1;
        } else {
          end = originalTextHelper.getPositionOfLineAndColmn(
            nextLineOriginalEndLineAndColumn.line,
            nextLineOriginalEndLineAndColumn.column,
          ) - 1;
        }
        const originalText = originalTextHelper.getTextBetween(start, end);
        if (originalText === ";") continue;
        if (!originalText.startsWith(" with")) continue;
        const lines = originalText.split("\n");
        const withAttributesLines: string[] = [];
        for (const line of lines) {
          withAttributesLines.push(line);
          if (line.endsWith(";")) break;
          if (line.endsWith("}")) break;
          // TODO `import {} from 'module' with { external: 'true' }; const a = 1;`
          //      没有换行，字节在后面接了个定义的情况暂时不考虑
        }

        ms.update(node.end - 1, node.end, withAttributesLines.join("\n"));
      }
    }
  }

  /** All the names that are declared in the `SourceFile`. */
  const declaredNames = new Set<string>();
  /** All the names that are exported. */
  const exportedNames = new Set<string>();
  /** The name of the default export. */
  let defaultExport = "";
  /** Inlined exports from `fileId` -> <synthetic name>. */
  const inlineImports = new Map<string, string>();
  /** The ranges that each name covers, for re-ordering. */
  const nameRanges = new Map<string, Array<Range>>();

  /**
   * Pass 1:
   *
   * - Remove statements that we can’t handle.
   * - Collect a `Set` of all the declared names.
   * - Collect a `Set` of all the exported names.
   * - Maybe collect the name of the default export if present.
   * - Fix the modifiers of all the items.
   * - Collect the ranges of each named statement.
   * - Duplicate the identifiers of a namespace `export`, so that renaming does
   *   not break it
   */
  for (const node of sourceFile.statements) {
    if (ts.isEmptyStatement(node)) {
      ms.remove(node.getStart(), node.getEnd());
      continue;
    }
    if (
      ts.isEnumDeclaration(node)
      || ts.isFunctionDeclaration(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isClassDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isModuleDeclaration(node)
    ) {
      // collect the declared name
      if (node.name) {
        const name = node.name.getText();
        declaredNames.add(name);

        // collect the exported name, maybe as `default`.
        if (matchesModifier(node, ts.ModifierFlags.ExportDefault)) {
          defaultExport = name;
        } else if (matchesModifier(node, ts.ModifierFlags.Export)) {
          exportedNames.add(name);
        }
        if (!(node.flags & ts.NodeFlags.GlobalAugmentation)) {
          pushNamedNode(name, [getStart(node), getEnd(node)]);
        }
      }

      // duplicate exports of namespaces
      if (ts.isModuleDeclaration(node)) {
        duplicateExports(ms, node);
      }

      fixModifiers(ms, node);
    } else if (ts.isVariableStatement(node)) {
      const { declarations } = node.declarationList;
      // collect all the names, also check if they are exported
      const isExport = matchesModifier(node, ts.ModifierFlags.Export);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.getText();
          declaredNames.add(name);
          if (isExport) {
            exportedNames.add(name);
          }
        }
      }

      fixModifiers(ms, node);

      // collect the ranges for re-ordering
      if (declarations.length === 1) {
        const decl = declarations[0]!;
        if (ts.isIdentifier(decl.name)) {
          pushNamedNode(decl.name.getText(), [getStart(node), getEnd(node)]);
        }
      } else {
        // we do reordering after splitting
        const decls = declarations.slice();
        const first = decls.shift()!;
        pushNamedNode(first.name.getText(), [getStart(node), first.getEnd()]);
        for (const decl of decls) {
          if (ts.isIdentifier(decl.name)) {
            pushNamedNode(decl.name.getText(), [decl.getFullStart(), decl.getEnd()]);
          }
        }
      }

      // split the variable declaration into different statements
      const { flags } = node.declarationList;
      const type = flags & ts.NodeFlags.Let ? "let" : flags & ts.NodeFlags.Const ? "const" : "var";
      const prefix = `declare ${type} `;

      const list = node.declarationList
        .getChildren()
        .find((c) => c.kind === ts.SyntaxKind.SyntaxList)!
        .getChildren();
      let commaPos = 0;
      for (const node of list) {
        if (node.kind === ts.SyntaxKind.CommaToken) {
          commaPos = node.getStart();
          ms.remove(commaPos, node.getEnd());
        } else if (commaPos) {
          ms.appendLeft(commaPos, ";\n");
          const start = node.getFullStart();
          const slice = ms.slice(start, node.getStart());
          const whitespace = slice.length - slice.trimStart().length;
          if (whitespace) {
            ms.overwrite(start, start + whitespace, prefix);
          } else {
            ms.appendLeft(start, prefix);
          }
        }
      }
    }
  }

  /**
   * Pass 2:
   *
   * Now that we have a Set of all the declared names, we can use that to
   * generate and de-conflict names for the following steps:
   *
   * - Resolve all the inline imports.
   * - Give any name-less `default export` a name.
   */
  for (const node of sourceFile.statements) {
    // recursively check inline imports
    checkInlineImport(node);

    if (!matchesModifier(node, ts.ModifierFlags.ExportDefault)) {
      continue;
    }
    // only function and class can be default exported, and be missing a name
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) {
        continue;
      }
      if (!defaultExport) {
        defaultExport = uniqName("export_default");
      }

      const children = node.getChildren();
      const idx = children.findIndex(
        (node) => node.kind === ts.SyntaxKind.ClassKeyword || node.kind === ts.SyntaxKind.FunctionKeyword,
      );
      const token = children[idx]!;
      const nextToken = children[idx + 1]!;
      const isPunctuation = nextToken.kind >= ts.SyntaxKind.FirstPunctuation
        && nextToken.kind <= ts.SyntaxKind.LastPunctuation;

      if (isPunctuation) {
        const addSpace = ms.slice(token.getEnd(), nextToken.getStart()) != " ";
        ms.appendLeft(nextToken.getStart(), `${addSpace ? " " : ""}${defaultExport}`);
      } else {
        ms.appendRight(token.getEnd(), ` ${defaultExport}`);
      }
    }
  }

  // and re-order all the name ranges to be contiguous
  for (const ranges of nameRanges.values()) {
    // we have to move all the nodes in front of the *last* one, which is a bit
    // unintuitive but is a workaround for:
    // https://github.com/Rich-Harris/magic-string/issues/180
    const last = ranges.pop()!;
    const start = last[0];
    for (const node of ranges) {
      ms.move(node[0], node[1], start);
    }
  }

  // render all the inline imports, and all the exports
  if (defaultExport) {
    ms.append(`\nexport default ${defaultExport};\n`);
  }
  if (exportedNames.size) {
    ms.append(`\nexport { ${[...exportedNames].join(", ")} };\n`);
  }
  for (const [fileId, importName] of inlineImports.entries()) {
    ms.prepend(`import * as ${importName} from "${fileId}";\n`);
  }

  const lineStarts = sourceFile.getLineStarts();

  // and collect/remove all the typeReferenceDirectives
  const typeReferences = new Set<string>();
  for (const ref of sourceFile.typeReferenceDirectives) {
    typeReferences.add(ref.fileName);

    const { line } = sourceFile.getLineAndCharacterOfPosition(ref.pos);
    const start = lineStarts[line]!;
    let end = sourceFile.getLineEndOfPosition(ref.pos);
    if (ms.slice(end, end + 1) === "\n") {
      end += 1;
    }

    ms.remove(start, end);
  }

  // and collect/remove all the fileReferenceDirectives
  const fileReferences = new Set<string>();
  for (const ref of sourceFile.referencedFiles) {
    fileReferences.add(ref.fileName);

    const { line } = sourceFile.getLineAndCharacterOfPosition(ref.pos);
    const start = lineStarts[line]!;
    let end = sourceFile.getLineEndOfPosition(ref.pos);
    if (ms.slice(end, end + 1) === "\n") {
      end += 1;
    }

    ms.remove(start, end);
  }

  return {
    ms,
    typeReferences,
    fileReferences,
  };

  function checkInlineImport(node: ts.Node) {
    ts.forEachChild(node, checkInlineImport);

    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) {
        throw new UnsupportedSyntaxError(node, "inline imports should have a literal argument");
      }
      const fileId = node.argument.literal.text;
      const children = node.getChildren();

      const start = children.find((t) => t.kind === ts.SyntaxKind.ImportKeyword)!.getStart();
      let end = node.getEnd();

      const token = children.find((t) => t.kind === ts.SyntaxKind.DotToken || t.kind === ts.SyntaxKind.LessThanToken);
      if (token) {
        end = token.getStart();
      }

      const importName = createNamespaceImport(fileId);
      ms.overwrite(start, end, importName);
    }
  }

  function createNamespaceImport(fileId: string) {
    let importName = inlineImports.get(fileId);
    if (!importName) {
      importName = uniqName(fileId.replace(/[^a-zA-Z0-9_$]/g, () => "_"));
      inlineImports.set(fileId, importName);
    }
    return importName;
  }

  function uniqName(hint: string): string {
    let name = hint;
    while (declaredNames.has(name)) {
      name = `_${name}`;
    }
    declaredNames.add(name);
    return name;
  }

  function pushNamedNode(name: string, range: Range) {
    let nodes = nameRanges.get(name);
    if (!nodes) {
      nodes = [range];
      nameRanges.set(name, nodes);
    } else {
      const last = nodes[nodes.length - 1]!;
      if (last[1] === range[0]) {
        last[1] = range[1];
      } else {
        nodes.push(range);
      }
    }
  }
}

function fixModifiers(ms: MagicString, node: ts.Node) {
  // remove the `export` and `default` modifier, add a `declare` if its missing.
  if (!ts.canHaveModifiers(node)) {
    return;
  }
  let hasDeclare = false;
  const needsDeclare = ts.isEnumDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isFunctionDeclaration(node)
    || ts.isModuleDeclaration(node)
    || ts.isVariableStatement(node);

  for (const mod of node.modifiers ?? []) {
    switch (mod.kind) {
      case ts.SyntaxKind.ExportKeyword: // fall through
      case ts.SyntaxKind.DefaultKeyword: {
        ms.remove(mod.getStart(), mod.getEnd() + 1);
        break;
      }
      case ts.SyntaxKind.DeclareKeyword:
        hasDeclare = true;
    }
  }
  if (needsDeclare && !hasDeclare) {
    ms.appendRight(node.getStart(), "declare ");
  }
}

function duplicateExports(ms: MagicString, module: ts.ModuleDeclaration) {
  if (!module.body || !ts.isModuleBlock(module.body)) {
    return;
  }
  for (const node of module.body.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamespaceExport(node.exportClause)) {
        continue;
      }
      for (const decl of node.exportClause.elements) {
        if (!decl.propertyName) {
          ms.appendLeft(decl.name.getEnd(), ` as ${decl.name.getText()}`);
        }
      }
    }
  }
}

function getStart(node: ts.Node): number {
  const start = node.getFullStart();
  return start + (newlineAt(node, start) ? 1 : 0);
}
function getEnd(node: ts.Node): number {
  const end = node.getEnd();
  return end + (newlineAt(node, end) ? 1 : 0);
}

function newlineAt(node: ts.Node, idx: number): boolean {
  return node.getSourceFile().getFullText()[idx] === "\n";
}
