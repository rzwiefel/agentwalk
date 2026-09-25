import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  AnalysisInfo,
  Occurrence,
  Ownership,
  ParserDiagnostic,
  ParserEdge,
  ParserGraph,
  ParserNode,
  Resolution,
  SourceLanguage,
  Span,
  VarKind,
} from './ir.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
let activeRootDir = process.cwd();
let normalizedPathCache = new Map<string, string>();
let relativePathCache = new Map<string, string>();

export interface AnalyzeOptions {
  rootDir: string;
  projectFile?: string;
  mode?: 'full' | 'incremental';
  previous?: ParserGraph;
  changedFiles?: string[];
}

interface ProjectContext {
  rootDir: string;
  projectFile?: string;
  options: ts.CompilerOptions;
  files: string[];
  fileSet: Set<string>;
  packageForFile: Map<string, PackageInfo>;
  packages: Map<string, PackageInfo>;
}

interface PackageInfo {
  root: string;
  name: string;
  manifest: string;
}

interface ResolutionResult {
  target: string;
  resolution: Resolution;
  packageName?: string;
  sourceFile?: string;
}

interface MutableState {
  context: ProjectContext;
  checker: ts.TypeChecker;
  nodes: Map<string, ParserNode>;
  edges: Map<string, ParserEdge>;
  symbolIds: Map<ts.Symbol, string>;
  declarationIds: Map<ts.Node, string>;
  sourceFiles: Map<string, ts.SourceFile>;
  moduleResolutions: Map<string, ResolutionResult>;
  diagnostics: ParserDiagnostic[];
}

export function analyzeProject(options: AnalyzeOptions): ParserGraph {
  normalizedPathCache = new Map();
  relativePathCache = new Map();
  const context = loadProject(options);
  activeRootDir = context.rootDir;
  const program = ts.createProgram({
    rootNames: context.files,
    options: context.options,
    host: compilerHost(context),
  });
  const checker = program.getTypeChecker();
  const state: MutableState = {
    context,
    checker,
    nodes: new Map(),
    edges: new Map(),
    symbolIds: new Map(),
    declarationIds: new Map(),
    sourceFiles: new Map(),
    moduleResolutions: new Map(),
    diagnostics: [],
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (isProjectSource(context, sourceFile.fileName)) {
      state.sourceFiles.set(normalizeAbsolute(sourceFile.fileName), sourceFile);
    }
  }
  collectNamespaces(state);
  collectDeclarations(state, program);
  collectRelationships(state, program);
  collectDiagnostics(state, program);

  const files = [...state.sourceFiles.keys()].map((file) => relativeFile(context.rootDir, file)).sort();
  const changedFiles = normalizeChangedFiles(context, options.changedFiles ?? []);
  const invalidatedFiles =
    options.mode === 'incremental'
      ? computeInvalidatedFiles(options.previous, changedFiles)
      : files;
  const analysis: AnalysisInfo = {
    mode: options.mode === 'incremental' ? 'incremental' : 'full',
    projectFile: context.projectFile ? relativeFile(context.rootDir, context.projectFile) : undefined,
    files,
    changedFiles,
    invalidatedFiles,
    ownership: buildOwnership(state),
  };

  const nodes = [...state.nodes.values()].sort(compareNodes);
  const edges = [...state.edges.values()].sort(compareEdges);
  const diagnostics = state.diagnostics.sort(compareDiagnostics);
  return {
    formatVersion: 1,
    root: '.',
    nodes,
    edges,
    diagnostics,
    analysis,
  };
}

function loadProject(options: AnalyzeOptions): ProjectContext {
  const rootDir = normalizeAbsolute(options.rootDir);
  const projectFile = options.projectFile
    ? normalizeAbsolute(options.projectFile)
    : findProjectFile(rootDir);
  let compilerOptions: ts.CompilerOptions;
  let files: string[];
  if (projectFile) {
    const config = ts.readConfigFile(projectFile, ts.sys.readFile);
    if (config.error) {
      throw new Error(formatTsDiagnostic(config.error, rootDir));
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(projectFile), undefined, projectFile);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map((diagnostic) => formatTsDiagnostic(diagnostic, rootDir)).join('\n'));
    }
    compilerOptions = {
      ...parsed.options,
      allowJs: parsed.options.allowJs ?? path.basename(projectFile) === 'jsconfig.json',
      checkJs: parsed.options.checkJs ?? false,
      types: parsed.options.types ?? ['node'],
    };
    files = parsed.fileNames.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  } else {
    compilerOptions = {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ['node'],
    };
    files = discoverSourceFiles(rootDir);
  }
  const packages = discoverPackages(rootDir);
  const packageForFile = new Map<string, PackageInfo>();
  for (const file of files) {
    const absolute = normalizeAbsolute(file);
    const matching = [...packages.values()]
      .filter((pkg) => absolute === pkg.root || absolute.startsWith(`${pkg.root}${path.sep}`))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (matching) packageForFile.set(absolute, matching);
  }
  return {
    rootDir,
    projectFile: projectFile && normalizeAbsolute(projectFile),
    options: compilerOptions,
    files: files.map(normalizeAbsolute).sort(),
    fileSet: new Set(
      files
        .map(normalizeAbsolute)
        .filter((file) => isWithinRoot(rootDir, file) && !file.split(path.sep).includes('node_modules')),
    ),
    packageForFile,
    packages,
  };
}

function compilerHost(context: ProjectContext): ts.CompilerHost {
  const host = ts.createCompilerHost(context.options, true);
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      const resolved = ts.resolveModuleName(moduleName, containingFile, context.options, ts.sys).resolvedModule;
      if (!resolved || !isWithinRoot(context.rootDir, resolved.resolvedFileName)) return undefined;
      return resolved;
    });
  return host;
}

function findProjectFile(rootDir: string): string | undefined {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(rootDir, name);
    if (ts.sys.fileExists(candidate)) return candidate;
  }
  return undefined;
}

function discoverSourceFiles(rootDir: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(absolute);
    }
  };
  visit(rootDir);
  return result;
}

function discoverPackages(rootDir: string): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();
  const visit = (directory: string): void => {
    const manifest = path.join(directory, 'package.json');
    if (ts.sys.fileExists(manifest)) {
      let name: string | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name.length > 0) name = parsed.name;
      } catch {
        // The compiler diagnostics surface malformed source configuration; package metadata is optional.
      }
      packages.set(normalizeAbsolute(directory), {
        root: normalizeAbsolute(directory),
        name: name ?? `workspace:${relativeFile(rootDir, directory) || '.'}`,
        manifest: normalizeAbsolute(manifest),
      });
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(rootDir);
  return packages;
}

function collectNamespaces(state: MutableState): void {
  for (const [fileName, sourceFile] of state.sourceFiles) {
    const relative = relativeFile(state.context.rootDir, fileName);
    const module = moduleId(relative);
    const pkg = state.context.packageForFile.get(fileName);
    if (pkg) {
      const packageId = packageNamespaceId(pkg.name);
      addNode(state, {
        id: packageId,
        kind: 'namespace',
        label: pkg.name,
        namespace: packageId,
        fqn: pkg.name,
        external: false,
        occurrences: [],
      });
      addEdge(state, {
        kind: 'contains',
        source: packageId,
        target: module,
        resolution: 'resolved',
        confidence: 1,
        provenance: 'package-manifest',
        span: sourceSpan(sourceFile, sourceFile),
        text: pkg.name,
      });
    }
    addNode(state, {
      id: module,
      kind: 'namespace',
      label: path.basename(relative),
      namespace: module,
      fqn: relative,
      file: relative,
      span: sourceSpan(sourceFile, sourceFile),
      language: languageForFile(fileName),
      occurrences: [],
    });
  }
}

function collectDeclarations(state: MutableState, program: ts.Program): void {
  for (const sourceFile of state.sourceFiles.values()) {
    const module = moduleId(relativeFile(state.context.rootDir, sourceFile.fileName));
    const visit = (node: ts.Node, owner: string): void => {
      const declaration = declarationInfo(node);
      if (declaration?.name && ts.isIdentifier(declaration.name)) {
        const symbol = state.checker.getSymbolAtLocation(declaration.name);
        if (symbol) {
          const id = getOrCreateDeclaration(state, symbol, declaration.name, declaration.kind);
          addOccurrence(state.nodes.get(id)!, 'definition', sourceSpan(sourceFile, declaration.name), declaration.name.getText(sourceFile));
          addEdge(state, {
            kind: 'contains',
            source: state.declarationIds.get(node) ?? owner,
            target: id,
            resolution: 'resolved',
            confidence: 1,
            provenance: 'typescript-declaration',
            span: sourceSpan(sourceFile, declaration.name),
            text: declaration.name.getText(sourceFile),
          });
          ts.forEachChild(node, (child) => visit(child, id));
          return;
        }
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    };
    visit(sourceFile, module);
  }
  // Force symbol creation for exports whose declaration is in a .d.ts supplied by the compiler.
  for (const sourceFile of program.getSourceFiles()) {
    if (!isProjectSource(state.context, sourceFile.fileName)) continue;
    const moduleSymbol = state.checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol) {
      for (const symbol of state.checker.getExportsOfModule(moduleSymbol)) {
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        const name = declaration && declarationName(declaration);
        if (name) {
          getOrCreateDeclaration(state, symbol, name, declarationKind(declaration));
        }
      }
    }
  }
}

function collectRelationships(state: MutableState, program: ts.Program): void {
  for (const sourceFile of state.sourceFiles.values()) {
    const module = moduleId(relativeFile(state.context.rootDir, sourceFile.fileName));
    const visit = (node: ts.Node, parentOwner: string): void => {
      const owner = state.declarationIds.get(node) ?? parentOwner;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        addModuleRelationship(state, sourceFile, module, node.moduleSpecifier, 'requires', 'import-declaration');
        collectImportMentions(state, sourceFile, owner, node);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addModuleRelationship(state, sourceFile, module, node.moduleSpecifier, 'reexports', 'export-declaration');
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
        addModuleRelationship(state, sourceFile, module, node.moduleReference.expression, 'requires', 'import-equals');
      } else if (isRequireCall(node)) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) {
          addModuleRelationship(state, sourceFile, module, argument, 'requires', 'commonjs-require');
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) collectCall(state, sourceFile, owner, node);
      if (ts.isTypeReferenceNode(node)) collectTypeMention(state, sourceFile, owner, node.typeName, 'type-reference');
      if (ts.isExpressionWithTypeArguments(node)) {
        const heritage = node.parent;
        const kind = ts.isHeritageClause(heritage) && heritage.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
        collectInheritance(state, sourceFile, owner, node, kind);
      }
      if (ts.isJsxOpeningLikeElement(node)) collectJsxMention(state, sourceFile, owner, node);
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        collectOverride(state, sourceFile, owner, node.name);
      }
      collectExportRelationships(state, sourceFile, module, node);
      ts.forEachChild(node, (child) => visit(child, owner));
    };
    visit(sourceFile, module);
  }
}

function collectDiagnostics(state: MutableState, program: ts.Program): void {
  const diagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file;
    const start = diagnostic.start ?? 0;
    const length = diagnostic.length ?? 0;
    state.diagnostics.push({
      code: String(diagnostic.code),
      category: diagnosticCategory(diagnostic.category),
      message: formatTsDiagnostic(diagnostic, state.context.rootDir),
      file: file && isProjectSource(state.context, file.fileName) ? relativeFile(state.context.rootDir, file.fileName) : undefined,
      span: file && isProjectSource(state.context, file.fileName)
        ? sourceSpan(file, file, start, start + length)
        : undefined,
    });
  }
}

function collectImportMentions(state: MutableState, sourceFile: ts.SourceFile, owner: string, node: ts.ImportDeclaration): void {
  const clause = node.importClause;
  if (!clause) return;
  const addAlias = (name: ts.Identifier, importedName: string): void => {
    const local = state.checker.getSymbolAtLocation(name);
    const target = local && resolveAliasedSymbol(state.checker, local);
    const targetId = target ? getOrCreateSymbolTarget(state, target, name, sourceFile) : unresolvedVarId(importedName);
    if (!state.nodes.has(targetId)) ensurePlaceholder(state, targetId, importedName, target ? 'external' : 'external', target ? 'resolved' : 'unresolved');
    addOccurrence(state.nodes.get(targetId)!, 'import', sourceSpan(sourceFile, name), name.text, { importedName });
    addEdge(state, {
      kind: 'mentions',
      source: owner,
      target: targetId,
      resolution: target ? resolutionForSymbol(state, target) : 'unresolved',
      confidence: target ? 0.98 : 0.3,
      provenance: 'typescript-import-binding',
      span: sourceSpan(sourceFile, name),
      text: name.text,
      detail: { importedName },
    });
  };
  if (clause.name) addAlias(clause.name, 'default');
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) addAlias(element.name, element.propertyName?.text ?? element.name.text);
  }
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) addAlias(clause.namedBindings.name, '*');
}

function collectExportRelationships(state: MutableState, sourceFile: ts.SourceFile, module: string, node: ts.Node): void {
  if (ts.isExportAssignment(node)) {
    const target = ts.isIdentifier(node.expression) ? symbolTargetAt(state, node.expression) : undefined;
    if (target) addEdge(state, edgeFromNode(state, sourceFile, 'exports', module, target, node, 'typescript-export-assignment'));
  }
  const exported = hasExportModifier(node);
  if (exported) {
    const info = declarationInfo(node);
    if (info?.name && ts.isIdentifier(info.name)) {
      const target = symbolTargetAt(state, info.name);
      if (target) addEdge(state, edgeFromNode(state, sourceFile, 'exports', module, target, node, 'typescript-export-modifier'));
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const target = symbolTargetAt(state, declaration.name);
        if (target) addEdge(state, edgeFromNode(state, sourceFile, 'exports', module, target, declaration, 'typescript-export-modifier'));
      }
    }
  }
  if (ts.isExportDeclaration(node) && !node.moduleSpecifier) {
    for (const element of node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : []) {
      const target = symbolTargetAt(state, element.propertyName ?? element.name);
      if (target) addEdge(state, edgeFromNode(state, sourceFile, 'exports', module, target, element, 'typescript-named-export'));
    }
  }
}

function collectCall(state: MutableState, sourceFile: ts.SourceFile, owner: string, node: ts.CallExpression | ts.NewExpression): void {
  const expression = node.expression;
  const signature = state.checker.getResolvedSignature(node);
  const symbol = state.checker.getSymbolAtLocation(expression);
  const targetSymbol = symbol && resolveAliasedSymbol(state.checker, symbol);
  const declaration = signature?.declaration ?? targetSymbol?.valueDeclaration ?? targetSymbol?.declarations?.[0];
  let target: string | undefined;
  let resolution: Resolution = 'unresolved';
  if (declaration && targetSymbol) {
    target = getOrCreateSymbolTarget(state, targetSymbol, declaration as ts.Node, sourceFile);
    resolution = resolutionForSymbol(state, targetSymbol);
    if (targetSymbol.declarations && targetSymbol.declarations.length > 1) resolution = 'ambiguous';
  } else if (targetSymbol) {
    target = getOrCreateSymbolTarget(state, targetSymbol, expression, sourceFile);
    resolution = resolutionForSymbol(state, targetSymbol);
  } else if (ts.isPropertyAccessExpression(expression)) {
    target = unresolvedVarId(expression.name.text);
  } else if (ts.isIdentifier(expression)) {
    target = unresolvedVarId(expression.text);
  }
  if (!target) return;
  if (!state.nodes.has(target)) ensurePlaceholder(state, target, expression.getText(sourceFile), 'external', resolution);
  addEdge(state, {
    kind: 'calls',
    source: owner,
    target,
    resolution,
    confidence: resolution === 'resolved' ? 0.95 : resolution === 'ambiguous' ? 0.55 : 0.25,
    provenance: 'typescript-call-signature',
    span: sourceSpan(sourceFile, node),
    text: node.getText(sourceFile),
  });
}

function collectTypeMention(state: MutableState, sourceFile: ts.SourceFile, owner: string, typeName: ts.EntityName, provenance: string): void {
  const target = symbolTargetAt(state, typeName);
  const label = typeName.getText(sourceFile);
  const targetId = target ?? unresolvedVarId(label);
  if (!state.nodes.has(targetId)) ensurePlaceholder(state, targetId, label, 'external', target ? 'external' : 'unresolved');
  addOccurrence(state.nodes.get(targetId)!, 'type-reference', sourceSpan(sourceFile, typeName), label);
  addEdge(state, {
    kind: 'mentions',
    source: owner,
    target: targetId,
    resolution: target ? resolutionForTarget(state, target) : 'unresolved',
    confidence: target ? 0.92 : 0.25,
    provenance,
    span: sourceSpan(sourceFile, typeName),
    text: label,
    detail: { referenceKind: 'type' },
  });
}

function collectInheritance(
  state: MutableState,
  sourceFile: ts.SourceFile,
  owner: string,
  node: ts.ExpressionWithTypeArguments,
  kind: 'extends' | 'implements',
): void {
  const target = symbolTargetAt(state, node.expression);
  const label = node.expression.getText(sourceFile);
  const targetId = target ?? unresolvedVarId(label);
  if (!state.nodes.has(targetId)) ensurePlaceholder(state, targetId, label, 'external', target ? 'external' : 'unresolved');
  addEdge(state, {
    kind,
    source: owner,
    target: targetId,
    resolution: target ? resolutionForTarget(state, target) : 'unresolved',
    confidence: target ? 0.98 : 0.25,
    provenance: 'typescript-heritage-clause',
    span: sourceSpan(sourceFile, node),
    text: node.getText(sourceFile),
  });
}

function collectJsxMention(
  state: MutableState,
  sourceFile: ts.SourceFile,
  owner: string,
  node: ts.JsxOpeningLikeElement,
): void {
  const tag = node.tagName;
  const label = tag.getText(sourceFile);
  const intrinsic = ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
  const target = intrinsic ? undefined : symbolTargetAt(state, tag);
  const targetId = target ?? (intrinsic ? `var:jsx-intrinsic:${label}` : unresolvedVarId(label));
  if (!state.nodes.has(targetId)) {
    addNode(state, {
      id: targetId,
      kind: 'var',
      varKind: intrinsic ? 'jsx-intrinsic' : 'external',
      label,
      fqn: label,
      external: true,
      occurrences: [],
    });
  }
  addOccurrence(state.nodes.get(targetId)!, 'jsx-tag', sourceSpan(sourceFile, tag), label, {
    jsxKind: intrinsic ? 'intrinsic' : 'component',
  });
  addEdge(state, {
    kind: 'mentions',
    source: owner,
    target: targetId,
    resolution: intrinsic ? 'external' : target ? resolutionForTarget(state, target) : 'unresolved',
    confidence: intrinsic || target ? 0.95 : 0.25,
    provenance: 'typescript-jsx-tag',
    span: sourceSpan(sourceFile, tag),
    text: label,
    detail: { jsxKind: intrinsic ? 'intrinsic' : 'component' },
  });
}

function collectOverride(state: MutableState, sourceFile: ts.SourceFile, owner: string, name: ts.Identifier): void {
  const method = name.parent;
  if (!ts.isMethodDeclaration(method) || !hasModifier(method, ts.SyntaxKind.OverrideKeyword)) return;
  const classDecl = method.parent;
  if (!ts.isClassLike(classDecl)) return;
  const classType = state.checker.getTypeAtLocation(classDecl);
  for (const baseType of state.checker.getBaseTypes(classType as ts.InterfaceType) ?? []) {
    const baseMember = state.checker.getPropertyOfType(baseType, name.text);
    if (!baseMember) continue;
    const target = getOrCreateSymbolTarget(state, baseMember, name, sourceFile);
    addEdge(state, {
      kind: 'overrides',
      source: owner,
      target,
      resolution: 'resolved',
      confidence: 0.98,
      provenance: 'typescript-override-modifier',
      span: sourceSpan(sourceFile, method),
      text: method.getText(sourceFile),
    });
  }
}

function addModuleRelationship(
  state: MutableState,
  sourceFile: ts.SourceFile,
  source: string,
  specifier: ts.StringLiteral,
  kind: 'requires' | 'reexports',
  provenance: string,
): void {
  const resolution = resolveModule(state, sourceFile.fileName, specifier.text);
  const target = resolution.sourceFile
    ? moduleId(relativeFile(state.context.rootDir, resolution.sourceFile))
    : resolution.resolution === 'external'
      ? packageNamespaceId(resolution.packageName ?? specifier.text)
      : unresolvedModuleId(specifier.text);
  if (!state.nodes.has(target)) {
    addNode(state, {
      id: target,
      kind: 'namespace',
      label: resolution.packageName ?? specifier.text,
      namespace: target,
      fqn: resolution.packageName ?? specifier.text,
      external: resolution.resolution === 'external',
      packageName: resolution.packageName,
      occurrences: [],
    });
  }
  addEdge(state, {
    kind: kind === 'reexports' ? 'reexports' : 'requires',
    source,
    target,
    resolution: resolution.resolution,
    confidence: resolution.resolution === 'resolved' || resolution.resolution === 'external' ? 0.99 : 0.25,
    provenance,
    span: sourceSpan(sourceFile, specifier),
    text: specifier.text,
  });
}

function resolveModule(state: MutableState, containingFile: string, specifier: string): ResolutionResult {
  const cacheKey = `${containingFile}\0${specifier}`;
  const cached = state.moduleResolutions.get(cacheKey);
  if (cached) return cached;
  const result = ts.resolveModuleName(specifier, containingFile, state.context.options, ts.sys).resolvedModule;
  let resolution: ResolutionResult;
  if (result?.resolvedFileName) {
    const resolved = normalizeAbsolute(result.resolvedFileName);
    if (!isWithinRoot(state.context.rootDir, resolved)) {
      resolution = isBareSpecifier(specifier)
        ? { target: specifier, resolution: 'external', packageName: packageNameFromSpecifier(specifier) }
        : { target: specifier, resolution: 'unresolved' };
    } else if (state.sourceFiles.has(resolved)) {
      resolution = { target: resolved, resolution: 'resolved', sourceFile: resolved };
    } else {
      const pkg = packageNameFromPath(state.context, resolved);
      resolution = { target: pkg ?? specifier, resolution: 'external', packageName: pkg ?? packageNameFromSpecifier(specifier) };
    }
  } else {
    resolution = isBareSpecifier(specifier)
      ? { target: specifier, resolution: 'external', packageName: packageNameFromSpecifier(specifier) }
      : { target: specifier, resolution: 'unresolved' };
  }
  state.moduleResolutions.set(cacheKey, resolution);
  return resolution;
}

function getOrCreateDeclaration(
  state: MutableState,
  symbol: ts.Symbol,
  name: ts.Identifier | undefined,
  kind: VarKind,
  preferredDeclaration?: ts.Declaration,
): string {
  const existing = state.symbolIds.get(symbol);
  if (existing) return existing;
  const declaration = preferredDeclaration ?? symbol.valueDeclaration ?? symbol.declarations?.[0];
  const declarationSourceFile = declaration?.getSourceFile();
  const sourceFile = name?.getSourceFile() ?? declarationSourceFile;
  if (!sourceFile || !declaration) {
    return getOrCreateExternalSymbol(state, symbol, declarationSourceFile?.fileName);
  }
  if (!isProjectSource(state.context, sourceFile.fileName)) {
    return getOrCreateExternalSymbol(state, symbol, declarationSourceFile?.fileName);
  }
  const identityDeclaration = declarationSourceFile && isProjectSource(state.context, declarationSourceFile.fileName)
    ? declaration
    : name?.parent ?? preferredDeclaration ?? declaration;
  const relative = relativeFile(state.context.rootDir, sourceFile.fileName);
  const module = moduleId(relative);
  const offset = identityDeclaration.getStart(sourceFile);
  const suffix = symbol.declarations && symbol.declarations.length > 1 ? `@${offset}` : '';
  const id = `var:${module}#${symbol.name}${suffix}`;
  state.symbolIds.set(symbol, id);
  state.declarationIds.set(identityDeclaration, id);
  addNode(state, {
    id,
    kind: 'var',
    varKind: kind,
    label: symbol.name,
    namespace: module,
    fqn: `${relative}#${symbol.name}${suffix}`,
    file: relative,
    span: sourceSpan(sourceFile, identityDeclaration),
    language: languageForFile(sourceFile.fileName),
    external: false,
    occurrences: [],
  });
  return id;
}

function getOrCreateSymbolTarget(state: MutableState, symbol: ts.Symbol, node: ts.Node, _fallbackFile: ts.SourceFile): string {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const projectDeclaration = symbol.declarations?.find((candidate) => isProjectSource(state.context, candidate.getSourceFile().fileName));
  if (projectDeclaration) {
    return getOrCreateDeclaration(state, symbol, declarationName(projectDeclaration), declarationKind(projectDeclaration), projectDeclaration);
  }
  return getOrCreateExternalSymbol(state, symbol, declaration?.getSourceFile()?.fileName);
}

function getOrCreateExternalSymbol(state: MutableState, symbol: ts.Symbol, fileName?: string): string {
  const identity = externalModuleIdentity(fileName);
  const id = `var:external:${identity.module}:${symbol.name}`;
  if (!state.nodes.has(id)) {
    addNode(state, {
      id,
      kind: 'var',
      varKind: 'external',
      label: symbol.name,
      fqn: symbol.name,
      external: true,
      packageName: identity.packageName,
      occurrences: [],
    });
  }
  return id;
}

function symbolTargetAt(state: MutableState, node: ts.Node): string | undefined {
  const symbol = state.checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return getOrCreateSymbolTarget(state, resolveAliasedSymbol(state.checker, symbol), node, node.getSourceFile());
}

function resolutionForSymbol(state: MutableState, symbol: ts.Symbol): Resolution {
  return symbol.declarations?.some((declaration) => isProjectSource(state.context, declaration.getSourceFile().fileName))
    ? 'resolved'
    : 'external';
}

function resolutionForTarget(state: MutableState, target: string): Resolution {
  return state.nodes.get(target)?.external ? 'external' : 'resolved';
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function declarationInfo(node: ts.Node): { name?: ts.Node; kind: VarKind } | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration: {
      const declaration = node as ts.FunctionDeclaration;
      return { name: declaration.name ?? undefined, kind: 'function' };
    }
    case ts.SyntaxKind.ClassDeclaration: {
      const declaration = node as ts.ClassDeclaration;
      return { name: declaration.name ?? undefined, kind: 'class' };
    }
    case ts.SyntaxKind.InterfaceDeclaration:
      return { name: (node as ts.InterfaceDeclaration).name, kind: 'interface' };
    case ts.SyntaxKind.TypeAliasDeclaration:
      return { name: (node as ts.TypeAliasDeclaration).name, kind: 'type' };
    case ts.SyntaxKind.EnumDeclaration:
      return { name: (node as ts.EnumDeclaration).name, kind: 'enum' };
    case ts.SyntaxKind.VariableDeclaration:
      return { name: (node as ts.VariableDeclaration).name, kind: 'variable' };
    case ts.SyntaxKind.MethodDeclaration:
      return { name: (node as ts.MethodDeclaration).name, kind: 'method' };
    case ts.SyntaxKind.MethodSignature:
      return { name: (node as ts.MethodSignature).name, kind: 'method' };
    case ts.SyntaxKind.PropertyDeclaration:
      return { name: (node as ts.PropertyDeclaration).name, kind: 'property' };
    case ts.SyntaxKind.PropertySignature:
      return { name: (node as ts.PropertySignature).name, kind: 'property' };
    case ts.SyntaxKind.Parameter:
      return { name: (node as ts.ParameterDeclaration).name, kind: 'parameter' };
    default:
      return undefined;
  }
}

function declarationKind(node: ts.Node): VarKind {
  return declarationInfo(node)?.kind ?? 'external';
}

function declarationName(node: ts.Node): ts.Identifier | undefined {
  if (!('name' in node)) return undefined;
  const name = (node as ts.NamedDeclaration).name;
  return name && ts.isIdentifier(name) ? name : undefined;
}

function edgeFromNode(
  state: MutableState,
  sourceFile: ts.SourceFile,
  kind: Extract<ParserEdge['kind'], 'exports' | 'reexports'>,
  source: string,
  target: string,
  node: ts.Node,
  provenance: string,
): ParserEdge {
  const span = sourceSpan(sourceFile, node);
  return {
    id: `${kind}:${source}->${target}:${span.file}:${span.start}`,
    kind,
    source,
    target,
    resolution: resolutionForTarget(state, target),
    confidence: 0.98,
    provenance,
    span,
    text: node.getText(sourceFile),
  };
}

function addNode(state: MutableState, node: ParserNode): void {
  const existing = state.nodes.get(node.id);
  if (!existing) {
    state.nodes.set(node.id, node);
  } else {
    existing.occurrences.push(...node.occurrences);
  }
}

function addOccurrence(node: ParserNode, role: string, span: Span, text: string, detail?: Record<string, string>): void {
  node.occurrences.push({ role, span, text, detail });
}

function addEdge(state: MutableState, edge: Omit<ParserEdge, 'id'> & { id?: string }): void {
  const id =
    edge.id ??
    `${edge.kind}:${edge.source}->${edge.target}:${edge.span.file}:${edge.span.start}:${edge.span.end}:${edge.detail?.referenceKind ?? ''}`;
  if (!state.edges.has(id)) state.edges.set(id, { ...edge, id });
}

function ensurePlaceholder(state: MutableState, id: string, label: string, varKind: VarKind, resolution: Resolution): void {
  if (state.nodes.has(id)) return;
  addNode(state, {
    id,
    kind: id.startsWith('namespace:') ? 'namespace' : 'var',
    varKind: id.startsWith('namespace:') ? undefined : varKind,
    label,
    namespace: id.startsWith('namespace:') ? id : undefined,
    fqn: label,
    external: resolution === 'external',
    occurrences: [],
  });
}

function buildOwnership(state: MutableState): Ownership[] {
  const byFile = new Map<string, Ownership>();
  const add = (file: string): Ownership => {
    const current = byFile.get(file);
    if (current) return current;
    const created = { file, nodeIds: [], edgeIds: [] };
    byFile.set(file, created);
    return created;
  };
  for (const node of state.nodes.values()) {
    if (node.file) add(node.file).nodeIds.push(node.id);
    for (const occurrence of node.occurrences) add(occurrence.span.file).nodeIds.push(node.id);
  }
  for (const edge of state.edges.values()) add(edge.span.file).edgeIds.push(edge.id);
  return [...byFile.values()]
    .map((ownership) => ({
      ...ownership,
      nodeIds: [...new Set(ownership.nodeIds)].sort(),
      edgeIds: [...new Set(ownership.edgeIds)].sort(),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function computeInvalidatedFiles(previous: ParserGraph | undefined, changedFiles: string[]): string[] {
  if (!previous) return [...changedFiles].sort();
  const namespaceFiles = new Map(previous.nodes.filter((node) => node.kind === 'namespace' && node.file).map((node) => [node.id, node.file!]));
  const affected = new Set(changedFiles);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of previous.edges) {
      if (edge.kind !== 'requires') continue;
      const targetFile = namespaceFiles.get(edge.target);
      const sourceFile = namespaceFiles.get(edge.source);
      if (targetFile && sourceFile && affected.has(targetFile) && !affected.has(sourceFile)) {
        affected.add(sourceFile);
        changed = true;
      }
    }
  }
  return [...affected].sort();
}

function normalizeChangedFiles(context: ProjectContext, changed: string[]): string[] {
  return [...new Set(changed.map((file) => relativeFile(context.rootDir, normalizeAbsolute(path.isAbsolute(file) ? file : path.join(context.rootDir, file)))))]
    .sort();
}

function isProjectSource(context: ProjectContext, fileName: string): boolean {
  return context.fileSet.has(fileName) || context.fileSet.has(normalizeAbsolute(fileName));
}

function sourceSpan(sourceFile: ts.SourceFile, node: ts.Node, startOverride?: number, endOverride?: number): Span {
  const start = startOverride ?? node.getStart(sourceFile);
  const end = endOverride ?? node.getEnd();
  const begin = sourceFile.getLineAndCharacterOfPosition(Math.max(0, start));
  const finish = sourceFile.getLineAndCharacterOfPosition(Math.max(0, end));
  return {
    file: relativeFileFromSource(sourceFile),
    start,
    end,
    row: begin.line + 1,
    col: begin.character + 1,
    endRow: finish.line + 1,
    endCol: finish.character + 1,
  };
}

function relativeFileFromSource(sourceFile: ts.SourceFile): string {
  return relativeFile(activeRootDir, normalizeAbsolute(sourceFile.fileName));
}

function normalizeAbsolute(fileName: string): string {
  const cached = normalizedPathCache.get(fileName);
  if (cached) return cached;
  const normalized = path.resolve(fileName);
  normalizedPathCache.set(fileName, normalized);
  return normalized;
}

function relativeFile(rootDir: string, fileName: string): string {
  const normalizedRoot = normalizeAbsolute(rootDir);
  const normalizedFile = normalizeAbsolute(fileName);
  const cacheKey = `${normalizedRoot}\0${normalizedFile}`;
  const cached = relativePathCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const relative = path.relative(normalizedRoot, normalizedFile).replaceAll(path.sep, '/');
  relativePathCache.set(cacheKey, relative);
  return relative;
}

function isWithinRoot(rootDir: string, fileName: string): boolean {
  const relative = path.relative(normalizeAbsolute(rootDir), normalizeAbsolute(fileName));
  return relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
}

function moduleId(relative: string): string {
  return `namespace:module:${relative}`;
}

function packageNamespaceId(name: string): string {
  return `namespace:package:${name}`;
}

function unresolvedVarId(name: string): string {
  return `var:unresolved:${name}`;
}

function languageForFile(fileName: string): SourceLanguage {
  return JS_EXTENSIONS.has(path.extname(fileName).toLowerCase()) ? 'javascript' : 'typescript';
}

function packageNameFromPath(context: ProjectContext, fileName: string): string | undefined {
  const matching = [...context.packages.values()].filter((pkg) => fileName.startsWith(`${pkg.root}${path.sep}`)).sort((a, b) => b.root.length - a.root.length)[0];
  return matching?.name;
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function unresolvedModuleId(specifier: string): string {
  return `namespace:unresolved:${encodeURIComponent(specifier)}`;
}

function externalModuleIdentity(fileName?: string): { module: string; packageName?: string } {
  if (!fileName) return { module: 'unknown' };
  const normalized = normalizeAbsolute(fileName);
  const parts = normalized.split(path.sep);
  const nodeModules = parts.lastIndexOf('node_modules');
  if (nodeModules >= 0 && nodeModules + 1 < parts.length) {
    const first = parts[nodeModules + 1];
    const packageEnd = first.startsWith('@') ? nodeModules + 3 : nodeModules + 2;
    if (packageEnd <= parts.length) {
      const packageName = parts.slice(nodeModules + 1, packageEnd).join('/');
      const modulePath = parts.slice(packageEnd).join('/');
      return {
        module: modulePath ? `${packageName}/${modulePath}` : packageName,
        packageName,
      };
    }
  }
  return { module: path.basename(normalized) };
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !path.isAbsolute(specifier);
}

function isRequireCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require';
}

function hasExportModifier(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function compareNodes(a: ParserNode, b: ParserNode): number {
  return a.id.localeCompare(b.id);
}

function compareEdges(a: ParserEdge, b: ParserEdge): number {
  return a.id.localeCompare(b.id);
}

function compareDiagnostics(a: ParserDiagnostic, b: ParserDiagnostic): number {
  return `${a.file ?? ''}:${a.span?.start ?? 0}:${a.code}`.localeCompare(`${b.file ?? ''}:${b.span?.start ?? 0}:${b.code}`);
}

function diagnosticCategory(category: ts.DiagnosticCategory): ParserDiagnostic['category'] {
  return category === ts.DiagnosticCategory.Error
    ? 'error'
    : category === ts.DiagnosticCategory.Warning
      ? 'warning'
      : category === ts.DiagnosticCategory.Suggestion
        ? 'suggestion'
        : 'message';
}

function formatTsDiagnostic(diagnostic: ts.Diagnostic, rootDir: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').replaceAll('\\', '/');
  const portableRoot = normalizeAbsolute(rootDir).replaceAll('\\', '/');
  return message.replaceAll(`${portableRoot}/`, '');
}
