import ts from "typescript";
import { UnsupportedSyntaxError } from "./errors.js";

/**
 * The reason we need this here as a post-processing step is that rollup will
 * generate special objects for things like `export * as namespace`.
 * In the typescript world, the `namespace` constructs exists for this purpose.
 *
 * Now the problem is that we can’t just re-export things from a typescript
 * namespace right away, because of naming issues, `export { A as A }` is
 * trivially recursive inside the namespace. Therefore we create an alias
 * *outside* the namespace, and re-export that alias under the proper name,
 * something like `Alias_A = A; export { Alias_A as A }`.
 * And now we also have to take care that in typescript there is a difference
 * between types and values, and some constructs like `class` are actually both.
 *
 * Types get a `type` alias, and values get a `declare const` alias.
 */

interface Export {
  exportedName: string;
  localName: string;
}
interface Item {
  type: string;
  generics?: ts.NodeArray<ts.TypeParameterDeclaration>;
}
interface Namespace {
  name: string;
  exports: Array<Export>;
  location: { start: number; end: number; };
  textBeforeCodeAfter?: string;
}

const genNamespaceExport = (ns: Namespace) => (`
declare namespace ${ns.name} {
  export {
${
  ns.exports
    .map(({ exportedName, localName }) => {
      return exportedName === localName
        ? `${ns.name}_${exportedName} as ${exportedName}`
        : `${localName} as ${exportedName}`;
    })
    .map((line) => `    ${line}`)
    .join(",\n")
  + ","
}
  };
}
`.trim());

export class NamespaceFinder {
  constructor(private sourceFile: ts.SourceFile) {}

  findNamespaces() {
    const namespaces: Array<Namespace> = [];
    const itemTypes: { [key: string]: Item; } = {};

    for (const node of this.sourceFile.statements) {
      const location = {
        start: node.getStart(),
        end: node.getEnd(),
      };

      // Well, this is a big hack:
      // For some global `namespace` and `module` declarations, we generate
      // some fake IIFE code, so rollup can correctly scan its scope.
      // However, rollup will then insert bogus semicolons,
      // these `EmptyStatement`s, which are a syntax error and we want to
      // remove them. Well, we do that here…
      if (ts.isEmptyStatement(node)) {
        namespaces.unshift({
          name: "",
          exports: [],
          location,
        });
        continue;
      }
      // When generating multiple chunks, rollup links those via import
      // statements, obviously. But rollup uses full filenames with typescript extension,
      // which typescript does not like. So make sure to change those to javascript extension here.
      // `.d.ts` -> `.js`
      // `.d.cts` -> `.cjs`
      // `.d.mts` -> `.mjs`
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const { text } = node.moduleSpecifier;
        if (
          text.startsWith(".") && (
            text.endsWith(".d.ts")
            || text.endsWith(".d.cts")
            || text.endsWith(".d.mts")
          )
        ) {
          const start = node.moduleSpecifier.getStart() + 1; // +1 to account for the quote
          const end = node.moduleSpecifier.getEnd() - 1; // -1 to account for the quote
          namespaces.unshift({
            name: "",
            exports: [],
            location: {
              start,
              end,
            },
            textBeforeCodeAfter: text
              .replace(/\.d\.ts$/, ".js")
              .replace(/\.d\.cts$/, ".cjs")
              .replace(/\.d\.mts$/, ".mjs"),
          });
        }
      }

      // Remove redundant `{ Foo as Foo }` exports from a namespace which we
      // added in pre-processing to fix up broken renaming
      if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
        for (const stmt of node.body.statements) {
          if (ts.isExportDeclaration(stmt) && stmt.exportClause) {
            if (ts.isNamespaceExport(stmt.exportClause)) {
              continue;
            }
            for (const decl of stmt.exportClause.elements) {
              if (decl.propertyName && decl.propertyName.getText() == decl.name.getText()) {
                namespaces.unshift({
                  name: "",
                  exports: [],
                  location: {
                    start: decl.propertyName.getEnd(),
                    end: decl.name.getEnd(),
                  },
                });
              }
            }
          }
        }
      }

      if (ts.isClassDeclaration(node)) {
        itemTypes[node.name!.getText()] = { type: "class", generics: node.typeParameters };
      } else if (ts.isFunctionDeclaration(node)) {
        // a function has generics, but these don’t need to be specified explicitly,
        // since functions are treated as values.
        itemTypes[node.name!.getText()] = { type: "function" };
      } else if (ts.isInterfaceDeclaration(node)) {
        itemTypes[node.name.getText()] = { type: "interface", generics: node.typeParameters };
      } else if (ts.isTypeAliasDeclaration(node)) {
        itemTypes[node.name.getText()] = { type: "type", generics: node.typeParameters };
      } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
        itemTypes[node.name.getText()] = { type: "namespace" };
      } else if (ts.isEnumDeclaration(node)) {
        itemTypes[node.name.getText()] = { type: "enum" };
      }
      if (!ts.isVariableStatement(node)) {
        continue;
      }
      const { declarations } = node.declarationList;
      if (declarations.length !== 1) {
        continue;
      }
      const decl = declarations[0]!;
      const name = decl.name.getText();
      if (!decl.initializer || !ts.isCallExpression(decl.initializer)) {
        itemTypes[name] = { type: "var" };
        continue;
      }
      const obj = decl.initializer.arguments[0]!;
      if (
        !decl.initializer.expression.getFullText().includes("/*#__PURE__*/Object.freeze")
        || !ts.isObjectLiteralExpression(obj)
      ) {
        continue;
      }
      const exports: Array<Export> = [];
      for (const prop of obj.properties) {
        if (
          !ts.isPropertyAssignment(prop)
          || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
          || (prop.name.text !== "__proto__" && !ts.isIdentifier(prop.initializer))
        ) {
          throw new UnsupportedSyntaxError(prop, "Expected a property assignment");
        }
        if (prop.name.text === "__proto__") {
          continue;
        }
        exports.push({
          exportedName: prop.name.text,
          localName: prop.initializer.getText(),
        });
      }

      // sort in reverse order, since we will do string manipulation
      namespaces.unshift({
        name,
        exports,
        location,
      });
    }
    return { namespaces, itemTypes };
  }

  public fix() {
    const { namespaces, itemTypes } = this.findNamespaces();

    const namespaceCodes: Array<[Namespace["location"], string]> = [];
    for (const ns of namespaces) {
      let namespaceCode = "";

      const reexportCodes = [];
      for (const { exportedName, localName } of ns.exports) {
        if (exportedName === localName) {
          const { type, generics } = itemTypes[localName] || {};
          const variableName = `${ns.name}_${exportedName}`;
          switch (type) {
            case "namespace":
              // namespaces may contain both types and values
              reexportCodes.push(`import ${variableName} = ${localName};`);
              break;
            case "interface":
            case "type": {
              // an interface is just a type
              const typeParams = renderTypeParams(generics);
              reexportCodes.push(`type ${variableName}${typeParams.in} = ${localName}${typeParams.out};`);
              break;
            }
            case "enum":
            case "class": {
              // enums and classes are both types and values
              const typeParams = renderTypeParams(generics);
              reexportCodes.push(`type ${variableName}${typeParams.in} = ${localName}${typeParams.out};`);
              reexportCodes.push(`declare const ${variableName}: typeof ${localName};`);
              break;
            }
            default:
              // functions and vars are just values
              reexportCodes.push(`declare const ${variableName}: typeof ${localName};`);
              break;
          }
        }
      }
      namespaceCode = reexportCodes.length > 0
        ? reexportCodes.join("\n") + "\n"
        : "";
      if (ns.name) {
        namespaceCode += genNamespaceExport(ns);
      }
      namespaceCode += ns.textBeforeCodeAfter ?? "";

      namespaceCodes.push([ns.location, namespaceCode]);
    }

    return namespaceCodes;
  }
}

function renderTypeParams(typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>) {
  if (!typeParameters || !typeParameters.length) {
    return { in: "", out: "" };
  }

  return {
    in: `<${typeParameters.map((param) => param.getText()).join(", ")}>`,
    out: `<${typeParameters.map((param) => param.name.getText()).join(", ")}>`,
  };
}
