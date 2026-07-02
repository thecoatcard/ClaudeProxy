import { ContextBuilder } from '@/lib/runtime/agent/context-builder';

describe('agent runtime context builder', () => {
  it('selects a bounded set of relevant files', async () => {
    const builder = new ContextBuilder();
    const context = await builder.build(
      {
        objective: 'Refactor the runtime messages route and planner',
        missingInformation: [],
        requiredTools: [],
        expectedOutputs: [],
        constraints: [],
      },
      {
        root: 'C:/repo',
        packageManager: 'npm',
        projectType: 'nextjs-api-gateway',
        language: 'typescript',
        framework: 'nextjs',
        configFiles: [],
        entryPoints: ['app/api/v1/messages/route.ts'],
      },
      {
        packageManager: 'npm',
        projectType: 'nextjs-api-gateway',
        language: 'typescript',
        framework: 'nextjs',
        architectureNotes: ['Uses Next.js app router structure.'],
        dependencyFiles: ['package.json'],
        buildSystem: ['build'],
        tests: ['tests/'],
        docker: [],
        ci: [],
        entryPoints: ['app/api/v1/messages/route.ts'],
        candidateContextFiles: ['lib/runtime/agent/messages-runtime.ts', 'docs/AGENT_RUNTIME_PLAN.md'],
        indexedFiles: [
          {
            path: 'app/api/v1/messages/route.ts',
            language: 'typescript',
            size: 200,
            hash: 'a',
            lastModifiedMs: 1,
            imports: ['lib/runtime/agent/messages-runtime.ts'],
            exports: ['POST'],
            symbols: [{ name: 'POST', kind: 'function', file: 'app/api/v1/messages/route.ts', exported: true, line: 1, references: 1, calls: ['AgentRuntime'] }],
            callTargets: ['AgentRuntime'],
            documentation: ['# messages route'],
          },
          {
            path: 'lib/runtime/agent/messages-runtime.ts',
            language: 'typescript',
            size: 250,
            hash: 'b',
            lastModifiedMs: 1,
            imports: ['lib/runtime/agent/runtime.ts'],
            exports: ['POST'],
            symbols: [{ name: 'AgentRuntime', kind: 'class', file: 'lib/runtime/agent/messages-runtime.ts', exported: true, line: 1, references: 2, calls: ['handle'] }],
            callTargets: ['handle'],
            documentation: ['# runtime bridge'],
          },
        ],
        symbols: [
          { name: 'POST', kind: 'function', file: 'app/api/v1/messages/route.ts', exported: true, line: 1, references: 1, calls: ['AgentRuntime'] },
          { name: 'AgentRuntime', kind: 'class', file: 'lib/runtime/agent/messages-runtime.ts', exported: true, line: 1, references: 2, calls: ['handle'] },
        ],
        graphs: {
          dependencyGraph: { 'app/api/v1/messages/route.ts': ['lib/runtime/agent/messages-runtime.ts'] },
          importGraph: { 'app/api/v1/messages/route.ts': ['lib/runtime/agent/messages-runtime.ts'] },
          callGraph: { 'lib/runtime/agent/messages-runtime.ts': ['handle'] },
          reverseDependencies: { 'lib/runtime/agent/messages-runtime.ts': ['app/api/v1/messages/route.ts'] },
        },
        projectStructure: {
          'app/api/v1/messages': ['route.ts'],
          'lib/runtime/agent': ['messages-runtime.ts'],
        },
        repositorySummary: ['Indexed 2 files', 'Captured 2 symbols'],
        cache: {
          cacheKey: 'cache',
          createdAt: 1,
          indexedAt: 1,
          fileCount: 2,
          reusedFiles: 0,
        },
      },
      [{ name: 'filesystem', source: 'runtime', permission: 'safe', enabled: true }],
    );

    expect(context.selectedFiles.length).toBeGreaterThan(0);
    expect(context.selectedFiles.length).toBeLessThanOrEqual(8);
    expect(context.summary).toContain('Objective: Refactor the runtime messages route and planner');
    expect(context.rankedItems[0]?.reasons.length).toBeGreaterThan(0);
  });
});
