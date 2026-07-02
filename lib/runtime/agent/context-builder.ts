import path from 'node:path';
import type {
  AgentGoal,
  RepositoryInsights,
  RuntimeContextEnvelope,
  RuntimeMemory,
  ToolCapability,
  WorkspaceContext,
} from './contracts';
import { MemoryManager } from './memory-manager';

function tokenize(value: string) {
  return value.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

function overlapScore(tokens: Set<string>, values: string[]) {
  return values.reduce((score, value) => score + (tokens.has(value.toLowerCase()) ? 1 : 0), 0);
}

export class ContextBuilder {
  constructor(private readonly memoryManager?: MemoryManager) {}

  async build(
    goal: AgentGoal,
    workspace: WorkspaceContext,
    analysis: RepositoryInsights,
    tools: ToolCapability[],
    memory?: RuntimeMemory,
  ): Promise<RuntimeContextEnvelope> {
    const objectiveTokens = new Set(tokenize(goal.objective));
    const retrievedMemory = memory && this.memoryManager
      ? await this.memoryManager.retrieve(memory, goal.objective, 10, analysis).catch(() => [])
      : [];
    const memoryHints = memory
      ? [
          ...memory.projectFacts,
          ...memory.semanticFacts,
          ...memory.conversationFacts,
          ...memory.longTermFacts,
          ...memory.toolExecutionFacts,
          ...retrievedMemory,
        ].map((entry) => entry.value)
      : [];

    const rankedItems = analysis.indexedFiles
      .map((file) => {
        let score = 0;
        const reasons: string[] = [];
        const relatedSymbols = file.symbols
          .filter((symbol) => objectiveTokens.has(symbol.name.toLowerCase()) || tokenize(symbol.name).some((token) => objectiveTokens.has(token)))
          .map((symbol) => symbol.name);

        if (analysis.entryPoints.includes(file.path)) {
          score += 4;
          reasons.push('entry-point');
        }

        if (analysis.candidateContextFiles.includes(file.path)) {
          score += 2;
          reasons.push('candidate-context');
        }

        const symbolScore = relatedSymbols.length * 2;
        if (symbolScore > 0) {
          score += symbolScore;
          reasons.push('symbol-match');

          // Add a boost for symbols with high cross-reference counts
          let xrefCount = 0;
          for (const sym of relatedSymbols) {
            xrefCount += (analysis.graphs.crossReferences?.[sym] ?? []).length;
          }
          if (xrefCount > 0) {
            score += Math.min(xrefCount, 5);
            reasons.push('cross-reference-boost');
          }
        }

        const importScore = overlapScore(objectiveTokens, file.imports.flatMap(tokenize));
        if (importScore > 0) {
          score += importScore;
          reasons.push('dependency-match');
        }

        const docScore = overlapScore(objectiveTokens, file.documentation.flatMap(tokenize));
        if (docScore > 0) {
          score += docScore;
          reasons.push('documentation-match');
        }

        const reverseDependencyScore = (analysis.graphs.reverseDependencies[file.path] ?? []).length;
        if (reverseDependencyScore > 0) {
          score += Math.min(reverseDependencyScore, 3);
          reasons.push('reverse-dependency');
        }

        const callScore = overlapScore(objectiveTokens, file.callTargets.flatMap(tokenize));
        if (callScore > 0) {
          score += callScore;
          reasons.push('call-graph-match');
        }

        const memoryScore = overlapScore(new Set(memoryHints.flatMap(tokenize)), [...tokenize(file.path), ...file.exports.flatMap(tokenize)]);
        if (memoryScore > 0) {
          score += Math.min(memoryScore, 3);
          reasons.push('memory-match');
        }

        if (file.path.includes('runtime') || file.path.includes('agent')) {
          score += 1;
          reasons.push('runtime-surface');
        }

        return {
          file: path.normalize(file.path),
          score,
          reasons,
          relatedSymbols: Array.from(new Set(relatedSymbols)).slice(0, 6),
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .slice(0, 12);

    const selectedFiles = rankedItems.slice(0, 8).map((item) => item.file);
    const tokenBudget = Math.max(1800, 6000 - selectedFiles.length * 320);

    return {
      summary: [
        `Objective: ${goal.objective}`,
        `Workspace: ${workspace.root}`,
        `Project: ${analysis.projectType} on ${analysis.framework}/${analysis.language}`,
        `Indexed files: ${analysis.indexedFiles.length}, symbols: ${analysis.symbols.length}`,
        `Selected files: ${selectedFiles.join(', ') || 'none'}`,
      ].join('\n'),
      selectedFiles,
      rankedItems,
      repositoryFacts: [...analysis.architectureNotes, ...analysis.repositorySummary].slice(0, 12),
      toolSummary: tools.map((tool) => `${tool.name}:${tool.permission}:${tool.enabled ? 'enabled' : 'disabled'}`),
      memorySummary: [
        ...memoryHints.slice(-8),
        ...((memory?.retrievals ?? []).flatMap((item) => item.matched).slice(-6)),
      ],
      tokenBudget,
    };
  }
}
