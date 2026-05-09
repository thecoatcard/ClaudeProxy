/**
 * lib/memory/subagent-retrieval.ts
 *
 * Part 11: Provides scoped retrieval for subagents.
 * Each subagent role gets context relevant to its domain:
 *   - DB subagent → schema retrieval
 *   - UI subagent → component retrieval
 *   - API subagent → route retrieval
 */

import { VectorIndex, type SearchResult } from './vector-index';
import { retrieveContext, formatRetrievalContext } from './retrieval-pipeline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentRetrievalConfig {
  /** Subagent role or description */
  role: string;
  /** The task description for this subagent */
  taskDescription: string;
  /** Optional type filter for retrieval */
  typeFilter?: 'file' | 'task' | 'error' | 'decision' | 'architecture';
  /** Max results for this subagent */
  topK?: number;
}

// ---------------------------------------------------------------------------
// Role-based query augmentation
// ---------------------------------------------------------------------------

const ROLE_QUERY_HINTS: Record<string, string[]> = {
  planner: ['architecture', 'system design', 'structure', 'schema'],
  coder: ['implementation', 'function', 'component', 'api route'],
  verifier: ['test', 'validation', 'assertion', 'error handling'],
  merger: ['integration', 'orchestration', 'merge', 'combine'],
  database: ['prisma', 'schema', 'migration', 'database', 'model'],
  ui: ['component', 'page', 'layout', 'css', 'style', 'react'],
  api: ['route', 'endpoint', 'handler', 'middleware', 'api'],
};

/**
 * Get scoped retrieval context for a subagent.
 *
 * Augments the task description with role-specific hints
 * to improve retrieval relevance.
 */
export async function getSubagentContext(
  config: SubagentRetrievalConfig,
  vectorIndex: VectorIndex
): Promise<string> {
  if (vectorIndex.size === 0) return '';

  // Build augmented query from task + role hints
  const roleKey = detectRole(config.role);
  const hints = ROLE_QUERY_HINTS[roleKey] ?? [];
  const augmentedQuery = [
    config.taskDescription,
    ...hints.slice(0, 2),
  ].join(' ');

  const context = await retrieveContext(
    augmentedQuery,
    vectorIndex,
    config.topK ?? 3 // Subagents get fewer results than main context
  );

  return formatRetrievalContext(context);
}

/**
 * Detect the role category from a role string or description.
 */
function detectRole(role: string): string {
  const lower = role.toLowerCase();
  if (lower.includes('plan')) return 'planner';
  if (lower.includes('code') || lower.includes('implement') || lower.includes('build')) return 'coder';
  if (lower.includes('verify') || lower.includes('test') || lower.includes('check')) return 'verifier';
  if (lower.includes('merge') || lower.includes('combine')) return 'merger';
  if (lower.includes('database') || lower.includes('db') || lower.includes('prisma') || lower.includes('schema')) return 'database';
  if (lower.includes('ui') || lower.includes('component') || lower.includes('frontend') || lower.includes('react')) return 'ui';
  if (lower.includes('api') || lower.includes('route') || lower.includes('endpoint')) return 'api';
  return 'coder'; // default
}
