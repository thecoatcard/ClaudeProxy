import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type {
  RepositoryFileIndex,
  RepositoryGraph,
  RepositoryInsights,
  RepositorySymbol,
  WorkspaceContext,
} from './contracts';
import { RepositoryCache } from './repository-cache';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.py', '.go', '.md']);
const ROOT_SCAN_DIRS = ['app', 'lib', 'src', 'tests', 'pages', 'components', 'docs'];
const MAX_INDEXED_FILES = 500;


async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, relativeDir = '', results: string[] = []): Promise<string[]> {
  const absoluteDir = path.join(root, relativeDir);
  // Security: verify the resolved directory is within the workspace root
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(absoluteDir);
  if (!resolvedDir.startsWith(resolvedRoot)) {
    return results; // Silently skip — path traversal attempt
  }
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git' || entry.name === '.runtime-artifacts') continue;
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, relativePath, results);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === 'package.json' || entry.name.endsWith('.md')) {
      results.push(path.normalize(relativePath));
    }
  }

  return results;
}

function sha1(value: string) {
  return createHash('sha1').update(value).digest('hex');
}

function lineOf(sourceFile: ts.SourceFile, position: number) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function normalizeImport(source: string, filePath: string) {
  if (!source.startsWith('.')) return source;
  return path.normalize(path.join(path.dirname(filePath), source));
}

function summarizeDocs(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#') || line.startsWith('//') || line.startsWith('* ') || line.startsWith('"""'))
    .slice(0, 6);
}

function indexSourceFile(filePath: string, content: string): RepositoryFileIndex {
  const ext = path.extname(filePath).toLowerCase();
  let language = 'text';
  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: RepositorySymbol[] = [];
  const callTargets = new Set<string>();

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mts' || ext === '.cts') {
    language = ext.includes('ts') ? 'typescript' : 'javascript';
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(normalizeImport(node.moduleSpecifier.text, filePath));
      }

      if (ts.isExportAssignment(node)) {
        exports.push('default');
      }

      if (
        ts.isFunctionDeclaration(node)
        || ts.isClassDeclaration(node)
        || ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
        || ts.isVariableStatement(node)
      ) {
        const name = 'name' in node && node.name && ts.isIdentifier(node.name)
          ? node.name.text
          : ts.isVariableStatement(node)
            ? node.declarationList.declarations
                .map((declaration) => (ts.isIdentifier(declaration.name) ? declaration.name.text : 'anonymous'))
                .join(', ')
            : 'anonymous';

        const kind: RepositorySymbol['kind'] =
          ts.isFunctionDeclaration(node) ? 'function'
            : ts.isClassDeclaration(node) ? 'class'
              : ts.isInterfaceDeclaration(node) ? 'interface'
                : ts.isTypeAliasDeclaration(node) ? 'type'
                  : 'variable';
        const exported = !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        const localCalls = new Set<string>();

        node.forEachChild((child) => {
          ts.forEachChild(child, function walkDescendant(descendant) {
            if (ts.isCallExpression(descendant)) {
              const expression = descendant.expression.getText(sourceFile);
              localCalls.add(expression);
              callTargets.add(expression);
            }
            ts.forEachChild(descendant, walkDescendant);
          });
        });

        const symbol: RepositorySymbol = {
          name,
          kind,
          file: filePath,
          exported,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          references: localCalls.size,
          calls: Array.from(localCalls).sort(),
        };
        symbols.push(symbol);
        if (exported) {
          exports.push(name);
        }
      }

      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const localCalls = new Set<string>();
        node.forEachChild((child) => {
          ts.forEachChild(child, function walkDescendant(descendant) {
            if (ts.isCallExpression(descendant)) {
              const expression = descendant.expression.getText(sourceFile);
              localCalls.add(expression);
              callTargets.add(expression);
            }
            ts.forEachChild(descendant, walkDescendant);
          });
        });

        symbols.push({
          name: node.name.text,
          kind: 'method',
          file: filePath,
          exported: false,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          references: localCalls.size,
          calls: Array.from(localCalls).sort(),
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  } else if (ext === '.py') {
    language = 'python';
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const defMatch = line.match(/^\s*def\s+([a-zA-Z0-9_]+)\s*\(/);
      if (defMatch) {
        symbols.push({
          name: defMatch[1],
          kind: 'function',
          file: filePath,
          exported: !defMatch[1].startsWith('_'),
          line: i + 1,
          references: 0,
          calls: [],
        });
        exports.push(defMatch[1]);
      }
      const classMatch = line.match(/^\s*class\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          file: filePath,
          exported: !classMatch[1].startsWith('_'),
          line: i + 1,
          references: 0,
          calls: [],
        });
        exports.push(classMatch[1]);
      }
      const importMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_\.]+)\s+)?import\s+([a-zA-Z0-9_,\s]+)/);
      if (importMatch) {
        imports.push(importMatch[1] || importMatch[2].trim());
      }
      const callMatch = line.match(/([a-zA-Z0-9_]+)\s*\(/g);
      if (callMatch) {
        callMatch.forEach(c => callTargets.add(c.replace('(', '').trim()));
      }
    });
  } else if (ext === '.go') {
    language = 'go';
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const funcMatch = line.match(/^\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(/);
      if (funcMatch) {
        symbols.push({
          name: funcMatch[1],
          kind: 'function',
          file: filePath,
          exported: /^[A-Z]/.test(funcMatch[1]),
          line: i + 1,
          references: 0,
          calls: [],
        });
        if (/^[A-Z]/.test(funcMatch[1])) exports.push(funcMatch[1]);
      }
      const structMatch = line.match(/^\s*type\s+([a-zA-Z0-9_]+)\s+struct/);
      if (structMatch) {
        symbols.push({
          name: structMatch[1],
          kind: 'class',
          file: filePath,
          exported: /^[A-Z]/.test(structMatch[1]),
          line: i + 1,
          references: 0,
          calls: [],
        });
        if (/^[A-Z]/.test(structMatch[1])) exports.push(structMatch[1]);
      }
      const importMatch = line.match(/^\s*import\s+"([^"]+)"/);
      if (importMatch) {
        imports.push(importMatch[1]);
      }
      const callMatch = line.match(/([a-zA-Z0-9_]+)\s*\(/g);
      if (callMatch) {
        callMatch.forEach(c => callTargets.add(c.replace('(', '').trim()));
      }
    });
  }

  if (symbols.length === 0) {
    symbols.push({
      name: path.basename(filePath),
      kind: 'file',
      file: filePath,
      exported: false,
      line: 1,
      references: callTargets.size,
      calls: Array.from(callTargets).sort(),
    });
  }

  return {
    path: filePath,
    language,
    size: content.length,
    hash: sha1(content),
    lastModifiedMs: 0,
    imports: Array.from(new Set(imports)).sort(),
    exports: Array.from(new Set(exports)).sort(),
    symbols,
    callTargets: Array.from(callTargets).sort(),
    documentation: summarizeDocs(content),
  };
}

function buildGraphs(indexedFiles: RepositoryFileIndex[]): RepositoryGraph {
  const dependencyGraph: Record<string, string[]> = {};
  const importGraph: Record<string, string[]> = {};
  const callGraph: Record<string, string[]> = {};
  const reverseDependencies: Record<string, string[]> = {};
  const crossReferences: Record<string, string[]> = {};

  // Track symbol names and their declaring files
  const symbolDeclaringFile = new Map<string, string>();
  for (const file of indexedFiles) {
    for (const sym of file.symbols) {
      symbolDeclaringFile.set(sym.name, file.path);
    }
  }

  for (const file of indexedFiles) {
    dependencyGraph[file.path] = file.imports;
    importGraph[file.path] = file.imports;
    callGraph[file.path] = file.callTargets;

    for (const dependency of file.imports) {
      reverseDependencies[dependency] = Array.from(
        new Set([...(reverseDependencies[dependency] ?? []), file.path]),
      ).sort();
    }

    for (const call of file.callTargets) {
      const declaringFile = symbolDeclaringFile.get(call);
      if (declaringFile && declaringFile !== file.path) {
        crossReferences[call] = Array.from(
          new Set([...(crossReferences[call] ?? []), file.path]),
        ).sort();
      }
    }
  }

  return { dependencyGraph, importGraph, callGraph, reverseDependencies, crossReferences };
}

function buildProjectStructure(files: string[]) {
  const structure: Record<string, string[]> = {};
  for (const file of files) {
    const dir = path.dirname(file);
    structure[dir] = [...(structure[dir] ?? []), path.basename(file)].sort();
  }
  return structure;
}

export class RepositoryAnalyzer {
  constructor(private readonly cache = new RepositoryCache()) {}

  async analyze(workspace: WorkspaceContext): Promise<RepositoryInsights> {
    const rootEntries = await readdir(workspace.root).catch(() => [] as string[]);
    const packageJsonPath = path.join(workspace.root, 'package.json');
    const packageJson = await readFile(packageJsonPath, 'utf8')
      .then((value) => JSON.parse(value) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      })
      .catch(() => null);

    const scanRoots = ROOT_SCAN_DIRS.filter((dir) => rootEntries.includes(dir));
    const sourceFiles = (await Promise.all(scanRoots.map((dir) => collectFiles(workspace.root, dir))))
      .flat()
      .slice(0, MAX_INDEXED_FILES);

    const fileStats = await Promise.all(sourceFiles.map(async (file) => {
      const absolutePath = path.join(workspace.root, file);
      const fileStat = await stat(absolutePath).catch(() => null);
      return `${file}:${fileStat?.mtimeMs ?? 0}:${fileStat?.size ?? 0}`;
    }));
    const fingerprint = this.cache.fingerprint([
      workspace.root,
      workspace.language,
      packageJson?.dependencies ? Object.keys(packageJson.dependencies).join(',') : '',
      ...fileStats,
    ]);

    const cached = this.cache.get(workspace.root, fingerprint);
    if (cached) {
      return {
        ...cached,
        cache: {
          ...cached.cache,
          reusedFiles: cached.cache.fileCount,
          indexedAt: Date.now(),
        },
      };
    }

    const indexedFiles = await Promise.all(sourceFiles.map(async (file) => {
      const absolutePath = path.join(workspace.root, file);
      const content = await readFile(absolutePath, 'utf8').catch(() => '');
      const fileStat = await stat(absolutePath).catch(() => null);
      const indexed = indexSourceFile(file, content);
      indexed.lastModifiedMs = fileStat?.mtimeMs ?? 0;
      return indexed;
    }));

    const graphs = buildGraphs(indexedFiles);
    const symbols = indexedFiles.flatMap((file) => file.symbols);
    const candidateContextFiles = [
      ...workspace.entryPoints,
      ...indexedFiles
        .filter((file) => file.path.includes('runtime') || file.path.includes('messages') || file.path.endsWith('.md'))
        .map((file) => file.path),
    ].slice(0, 24);

    const insights: RepositoryInsights = {
      packageManager: workspace.packageManager,
      projectType: workspace.projectType,
      language: workspace.language,
      framework: workspace.framework,
      architectureNotes: [
        rootEntries.includes('app') ? 'Uses app-routed Next.js API surfaces.' : null,
        rootEntries.includes('lib') ? 'Core runtime and gateway logic live under lib/.' : null,
        rootEntries.includes('tests') ? 'Repository includes test coverage under tests/.' : null,
        packageJson?.dependencies?.mongodb ? 'MongoDB is available for durable orchestration state.' : null,
        packageJson?.dependencies?.ioredis ? 'Redis is available for cache and coordination concerns.' : null,
      ].filter((value): value is string => Boolean(value)),
      dependencyFiles: ['package.json', 'package-lock.json', 'tsconfig.json', 'jest.config.ts'].filter((file) => rootEntries.includes(file)),
      buildSystem: packageJson?.scripts
        ? Object.keys(packageJson.scripts).filter((name) => ['build', 'dev', 'start', 'test', 'lint'].includes(name))
        : [],
      tests: sourceFiles.filter((file) => file.startsWith('tests')).slice(0, 50),
      docker: [
        await exists(path.join(workspace.root, 'Dockerfile')) ? 'Dockerfile' : null,
        await exists(path.join(workspace.root, 'docker-compose.yml')) ? 'docker-compose.yml' : null,
      ].filter((value): value is string => Boolean(value)),
      ci: [await exists(path.join(workspace.root, '.github', 'workflows')) ? '.github/workflows' : null].filter((value): value is string => Boolean(value)),
      entryPoints: workspace.entryPoints,
      candidateContextFiles: Array.from(new Set(candidateContextFiles)).map((file) => path.normalize(file)),
      indexedFiles,
      symbols,
      graphs,
      projectStructure: buildProjectStructure(sourceFiles),
      repositorySummary: [
        `Indexed ${indexedFiles.length} repository files.`,
        `Captured ${symbols.length} symbols across runtime, API, and test surfaces.`,
        `Dependency edges: ${Object.values(graphs.dependencyGraph).reduce((sum, current) => sum + current.length, 0)}.`,
      ],
      cache: {
        cacheKey: fingerprint,
        createdAt: Date.now(),
        indexedAt: Date.now(),
        fileCount: indexedFiles.length,
        reusedFiles: 0,
      },
    };

    this.cache.set(workspace.root, fingerprint, insights);
    return insights;
  }
}
