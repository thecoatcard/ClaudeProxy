// lib/agent/background-task-tracker.ts
//
// Background task dependency enforcer.
//
// Certain commands (create-next-app, npx create-*, cargo init, etc.) must
// FULLY COMPLETE before the model attempts follow-up operations such as:
//   - mkdir inside the new directory
//   - cd into the new directory
//   - write files into the project
//   - run npm install inside the project
//
// This module compares the current command against an active background task
// list and blocks dependent actions until the upstream task has confirmed
// completion via startup signals or an explicit "done" indicator.
//
// Edge-runtime safe. Pure functions + OperationalState. No I/O.

import type { OperationalState, BackgroundTask } from '../context/operational-state';

export interface BlockingCheckResult {
  /** Whether the proposed command is blocked. */
  blocked: boolean;
  /** Human-readable reason for the block. */
  reason: string;
  /** The upstream task that must complete first. */
  blockedBy: string | null;
  /** Guidance to inject into systemInstruction when blocked. */
  guidance: string;
}

// ─── Dependency rules ──────────────────────────────────────────────────────────

interface DependencyRule {
  /** Pattern matching the upstream background task command. */
  upstreamPattern: RegExp;
  /** Patterns matching commands that MUST wait for the upstream task. */
  dependentPatterns: RegExp[];
  /** Human-readable dependency description. */
  description: string;
}

const DEPENDENCY_RULES: DependencyRule[] = [
  {
    upstreamPattern: /(?:npx?\s+)?create-next-app\b|next\s+new\b/i,
    dependentPatterns: [
      /\bmkdir\b/i,
      /\bcd\s+\S/i,
      /\bnpm\s+install\b|\bnpm\s+i\b/i,
      /write_file|create_file/i,
    ],
    description: 'create-next-app must finish before directory or file operations inside the project',
  },
  {
    upstreamPattern: /(?:npx?\s+)?create-react-app\b/i,
    dependentPatterns: [/\bcd\b/i, /\bnpm\b/i, /write_file|create_file/i],
    description: 'create-react-app must finish before working inside the project',
  },
  {
    upstreamPattern: /(?:npx?\s+)?create-t3-app\b/i,
    dependentPatterns: [/\bcd\b/i, /\bnpm\b/i, /write_file|create_file/i],
    description: 'create-t3-app must finish before working inside the project',
  },
  {
    upstreamPattern: /\bcargo\s+new\b|\bcargo\s+init\b/i,
    dependentPatterns: [/\bcd\b/i, /\bcargo\s+add\b/i, /write_file|create_file/i],
    description: 'cargo new/init must finish before working inside the Rust project',
  },
  {
    upstreamPattern: /\bnpm\s+install\b|\bnpm\s+i\b(?!\s*-)/i,
    dependentPatterns: [
      /\bnpm\s+run\b/i,
      /\bnpx\b/i,
      /\bbuild\b/i,
    ],
    description: 'npm install must complete before running build or npx commands',
  },
  {
    upstreamPattern: /\bpip\s+install\b/i,
    dependentPatterns: [/\bpython\s+-m\b/i, /\bpytest\b/i, /\buvicorn\b/i, /\bgunicorn\b/i],
    description: 'pip install must complete before running Python programs',
  },
  {
    upstreamPattern: /\bgo\s+mod\s+tidy\b|\bgo\s+get\b/i,
    dependentPatterns: [/\bgo\s+build\b/i, /\bgo\s+run\b/i, /\bgo\s+test\b/i],
    description: 'go mod tidy/get must complete before building or running Go programs',
  },
  {
    upstreamPattern: /\bdocker\s+build\b/i,
    dependentPatterns: [/\bdocker\s+run\b/i, /\bdocker\s+push\b/i, /\bdocker[-\s]compose\s+up\b/i],
    description: 'docker build must complete before running the image',
  },
];

// ─── Running task checks ──────────────────────────────────────────────────────

/**
 * Check if the proposed command depends on a task that hasn't completed.
 *
 * @param proposedCommand  The command string the model wants to execute.
 * @param state            Current operational state.
 */
export function checkTaskBlockers(
  proposedCommand: string,
  state: OperationalState,
): BlockingCheckResult {
  const NONE: BlockingCheckResult = { blocked: false, reason: '', blockedBy: null, guidance: '' };

  // Check active background tasks that are still unknown or running
  const pendingTasks = state.active_background_tasks.filter(
    t => t.status === 'unknown' || t.status === 'running',
  );

  for (const task of pendingTasks) {
    for (const rule of DEPENDENCY_RULES) {
      if (!rule.upstreamPattern.test(task.command)) continue;
      // This task matches an upstream rule — check if proposed command is a dependent
      const isDependent = rule.dependentPatterns.some(p => p.test(proposedCommand));
      if (!isDependent) continue;

      if (task.status === 'unknown') {
        return {
          blocked: true,
          reason: `${rule.description}. The upstream task '${task.command}' has not yet confirmed completion.`,
          blockedBy: task.command,
          guidance: buildBlockingGuidance(task, rule.description),
        };
      }
    }
  }

  // Also check for sequencing issues based purely on command patterns (no task in state)
  // E.g. if the model tries to cd into a project directory immediately after starting create-next-app
  for (const rule of DEPENDENCY_RULES) {
    // Find the most recent tool_chain entry that matches the upstream rule
    const chainHit = state.tool_chain_state
      .slice()
      .reverse()
      .find(entry => rule.upstreamPattern.test(entry.intent ?? entry.tool));

    if (!chainHit || chainHit.succeeded) continue; // Only block if upstream failed or in-progress
    const isDependent = rule.dependentPatterns.some(p => p.test(proposedCommand));
    if (!isDependent) continue;

    return {
      blocked: true,
      reason: `${rule.description}. The upstream step appears to have failed.`,
      blockedBy: chainHit.tool,
      guidance: buildBlockingGuidance(null, rule.description),
    };
  }

  return NONE;
}

function buildBlockingGuidance(task: BackgroundTask | null, description: string): string {
  const lines: string[] = [
    '',
    '[BACKGROUND TASK DEPENDENCY BLOCK]',
    `BLOCKED: ${description}.`,
  ];
  if (task) {
    lines.push(`  Upstream task: ${task.command}`);
    lines.push(`  Status: ${task.status.toUpperCase()}`);
    if (task.startupSignals.length) {
      lines.push(`  Wait for one of these signals before proceeding: ${task.startupSignals.join(', ')}`);
    }
  }
  lines.push('Do NOT proceed with dependent operations until the upstream task has completed.');
  lines.push('Check the tool output / terminal output for a completion signal.');
  return lines.join('\n');
}

/**
 * Public alias — builds a guidance string for a blocked dependency.
 * Returns empty string if the command is not blocked.
 */
export function buildDependencyGuidance(
  proposedCommand: string,
  state: OperationalState,
): string {
  const result = checkTaskBlockers(proposedCommand, state);
  return result.blocked ? result.guidance : '';
}

/**
 * Register a new background task in the state.
 * Call this after detecting a long-running command to ensure ordering is enforced.
 */
export function registerBackgroundTask(
  state: OperationalState,
  command: string,
  process: string,
  startupSignals: string[],
  expectedArtifacts: string[] = [],
): OperationalState {
  const task: BackgroundTask = {
    command,
    process,
    status: 'unknown',
    startupSignals,
    expectedArtifacts,
    startedAt: new Date().toISOString(),
  };
  return {
    ...state,
    active_background_tasks: [...state.active_background_tasks.slice(-9), task],
  };
}
