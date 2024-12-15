import ts from "typescript";

type NamedExport = {
  localName: string;
  exportedName: string;
  kind: "type" | "value";
};
type ExportDeclaration = {
  location: {
    start: number;
    end: number;
  };
  exports: Array<NamedExport>;
};

export class ExportsFinder {
  private readonly DEBUG = !!process.env.DTS_EXPORTS_FIXER_DEBUG;
  constructor(private readonly source: ts.SourceFile) {}

  public findExports() {
    const { rawExports, values, types } = this.getExportsAndLocals();
    return rawExports
      .map(rawExport => {
        const elements = rawExport.elements.map(e => {
          const exportedName = e.name.text;
          const localName = e.propertyName?.text ?? e.name.text;
          const kind = types.some((node) =>
              node.getText() === localName
            ) && !values.some((node) => node.getText() === localName)
            ? ("type" as const)
            : ("value" as const);
          this.DEBUG && console.log(`export ${localName} as ${exportedName} is a ${kind}`);
          return {
            exportedName,
            localName,
            kind,
          };
        });
        return {
          location: {
            start: rawExport.getStart(),
            end: rawExport.getEnd(),
          },
          exports: elements,
        };
      })
      .sort((a, b) => a.location.start - b.location.start)
      .map(decl =>
        [
          decl.location,
          this.getExportPart(decl.exports),
        ] as const
      );
  }

  private getExportsAndLocals(statements: Iterable<ts.Node> = this.source.statements) {
    const rawExports: Array<ts.NamedExports> = [];
    const values: Array<ts.Identifier> = [];
    const types: Array<ts.Identifier> = [];

    const recurseInto = (subStatements: Iterable<ts.Node>) => {
      const { rawExports: subExports, values: subValues, types: subTypes } = this.getExportsAndLocals(subStatements);
      rawExports.push(...subExports);
      values.push(...subValues);
      types.push(...subTypes);
    };

    for (const statement of statements) {
      this.DEBUG && console.log(statement.getText(), statement.kind);
      if (ts.isImportDeclaration(statement)) {
        continue;
      }
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        this.DEBUG && console.log(`${statement.name.getFullText()} is a type`);
        types.push(statement.name);
        continue;
      }
      if (
        ts.isEnumDeclaration(statement)
        || ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isVariableStatement(statement)
      ) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              this.DEBUG && console.log(`${declaration.name.getFullText()} is a value (from var statement)`);
              values.push(declaration.name);
            }
          }
        } else {
          if (statement.name) {
            this.DEBUG && console.log(`${statement.name.getFullText()} is a value (from declaration)`);
            values.push(statement.name);
          }
        }
        continue;
      }
      if (ts.isModuleBlock(statement)) {
        const subStatements = statement.statements;
        recurseInto(subStatements);
        continue;
      }
      if (ts.isModuleDeclaration(statement)) {
        if (statement.name && ts.isIdentifier(statement.name)) {
          this.DEBUG && console.log(`${statement.name.getFullText()} is a value (from module declaration)`);
          values.push(statement.name);
        }
        recurseInto(statement.getChildren());
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        if (statement.moduleSpecifier) {
          continue;
        }
        if (statement.isTypeOnly) {
          // no fixup neccessary
          continue;
        }
        const exportClause = statement.exportClause;
        if (!exportClause || !ts.isNamedExports(exportClause)) {
          continue;
        }
        rawExports.push(exportClause);
        continue;
      }
      this.DEBUG && console.log("unhandled statement", statement.getFullText(), statement.kind);
    }
    return { rawExports, values, types };
  }

  private createNamedExport(exportSpec: NamedExport, elideType = false) {
    return `${!elideType && exportSpec.kind === "type" ? "type " : ""}${exportSpec.localName}${
      exportSpec.localName === exportSpec.exportedName ? "" : ` as ${exportSpec.exportedName}`
    }`;
  }

  private getExportPart(exports: ExportDeclaration["exports"]) {
    const isTypeOnly = exports.every((e) => e.kind === "type")
      && exports.length > 0;
    return `${isTypeOnly ? "type " : ""}{ ${
      exports.map((exp) => this.createNamedExport(exp, isTypeOnly)).join(", ")
    } }`;
  }
}
