import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as TypeScript from "typescript/unstable/ast";

type IdentifierLocation = {
  path: string; line: number; name: string; kind: string; declaration_text: string; scope: string;
};
type InventoryInput = {
  sources: Record<string, string>;
  dependencyRoot: string;
  typescriptVersion: string;
};

const inventoryInput = JSON.parse(await Bun.stdin.text()) as InventoryInput;
const dependencyRequire = createRequire(path.join(inventoryInput.dependencyRoot, "package.json"));
const compilerRoot = path.join(inventoryInput.dependencyRoot, "node_modules/typescript");
const compilerPackage = dependencyRequire(path.join(compilerRoot, "package.json")) as { version: string };
if (compilerPackage.version !== inventoryInput.typescriptVersion) {
  throw new Error(`TypeScript ${inventoryInput.typescriptVersion} required; found ${compilerPackage.version}`);
}
const compiler = await import(pathToFileURL(path.join(compilerRoot, "dist/ast/index.js")).href) as typeof TypeScript;
const { API } = await import(pathToFileURL(path.join(compilerRoot, "dist/api/async/api.js")).href) as
  typeof import("typescript/unstable/async");
const { createVirtualFileSystem } = await import(pathToFileURL(path.join(compilerRoot, "dist/api/fs.js")).href) as
  typeof import("typescript/unstable/fs");
const locations: IdentifierLocation[] = [];
const virtualRoot = "/quality-declaration-inventory";
const virtualSources = Object.fromEntries(Object.entries(inventoryInput.sources).map(([sourcePath, sourceText]) =>
  [path.posix.join(virtualRoot, sourcePath), sourceText]
));
const projectPath = path.posix.join(virtualRoot, "tsconfig.json");
virtualSources[projectPath] = JSON.stringify({
  compilerOptions: { allowJs: true, noLib: true, noResolve: true },
  files: Object.keys(inventoryInput.sources),
});
const compilerSession = new API({ cwd: virtualRoot, fs: createVirtualFileSystem(virtualSources) });
const snapshot = await compilerSession.updateSnapshot({ openProjects: [projectPath] });
const project = snapshot.getProject(projectPath);
if (!project) throw new Error("TypeScript did not create the inspection project");

try {
for (const [sourcePath, sourceText] of Object.entries(inventoryInput.sources)) {
  const virtualPath = path.posix.join(virtualRoot, sourcePath);
  const parsedFile = await project.program.getSourceFile(virtualPath);
  if (!parsedFile || parsedFile.text !== sourceText) throw new Error(`TypeScript did not inspect the supplied ${sourcePath}`);
  const sourceFile: TypeScript.SourceFile = parsedFile;
  const parseDiagnostics = await project.program.getSyntacticDiagnostics(virtualPath);
  if (parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse ${sourcePath}: ${parseDiagnostics.map((issue) => issue.text).join("; ")}`);
  }

  function recordIdentifier(identifier: TypeScript.Identifier, kind: string, declaration = identifier.parent): void {
    const scopeNames: string[] = [];
    let ancestor: TypeScript.Node | undefined = declaration.parent;
    while (ancestor) {
      if (compiler.isFunctionDeclaration(ancestor) || compiler.isClassDeclaration(ancestor) ||
          compiler.isFunctionExpression(ancestor) || compiler.isClassExpression(ancestor)) {
        if (ancestor.name) scopeNames.push(ancestor.name.text);
      }
      ancestor = ancestor.parent;
    }
    locations.push({
      path: sourcePath,
      line: sourceFile.getLineAndCharacterOfPosition(identifier.getStart(sourceFile)).line + 1,
      name: identifier.text,
      kind,
      declaration_text: declaration.getText(sourceFile),
      scope: scopeNames.reverse().join("/"),
    });
  }

  function recordBinding(binding: TypeScript.BindingName, kind: string, declaration: TypeScript.Node): void {
    if (compiler.isIdentifier(binding)) recordIdentifier(binding, kind, declaration);
    else {
      for (const element of binding.elements) {
        if (compiler.isBindingElement(element) && element.name) recordBinding(element.name, kind, declaration);
      }
    }
  }

  function visitDeclaration(node: TypeScript.Node): void {
    if (compiler.isVariableDeclaration(node) || compiler.isParameterDeclaration(node)) {
      if (node.name) recordBinding(node.name, compiler.isParameterDeclaration(node) ? "parameter" : "variable", node);
    } else if (
      compiler.isFunctionDeclaration(node) || compiler.isFunctionExpression(node) ||
      compiler.isClassDeclaration(node) || compiler.isClassExpression(node) ||
      compiler.isInterfaceDeclaration(node) || compiler.isTypeAliasDeclaration(node) ||
      compiler.isEnumDeclaration(node) || compiler.isModuleDeclaration(node) ||
      compiler.isTypeParameterDeclaration(node) || compiler.isImportEqualsDeclaration(node)
    ) {
      if (node.name && compiler.isIdentifier(node.name)) recordIdentifier(node.name, "declaration");
    } else if (compiler.isImportSpecifier(node)) {
      recordIdentifier(node.name, node.propertyName ? "import-alias" : "import-binding", node);
    } else if (compiler.isNamespaceImport(node)) {
      recordIdentifier(node.name, "import-alias");
    } else if (compiler.isImportClause(node) && node.name) {
      recordIdentifier(node.name, "import-alias");
    }
    node.forEachChild(visitDeclaration);
  }
  visitDeclaration(sourceFile);
}
} finally {
  await snapshot.dispose();
  await compilerSession.close();
}
process.stdout.write(JSON.stringify(locations));
