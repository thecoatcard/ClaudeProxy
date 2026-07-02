import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSession, ValidationResult } from './contracts';
import type { ToolExecutor } from './tool-executor';
import type { SessionManager } from './session-manager';

export class ValidationEngine {
  constructor(
    private readonly tools?: ToolExecutor,
    private readonly sessions?: SessionManager,
  ) {}

  private async getAvailableScripts(workspaceRoot: string): Promise<Record<string, string>> {
    try {
      const packageJsonPath = path.join(workspaceRoot, 'package.json');
      const raw = await readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed?.scripts ?? {};
    } catch {
      return {};
    }
  }

  async validate(session: AgentSession): Promise<ValidationResult> {
    const checks: string[] = ['session_integrity', 'task_completion'];
    const details: string[] = [];

    if (!session.completedTasks.includes('model-execution')) {
      return {
        status: 'failed',
        checks,
        details: ['Model execution did not complete before validation.'],
      };
    }

    if (session.modifiedFiles.length === 0) {
      details.push('No runtime-managed file mutations were recorded for this session.');
      return {
        status: 'skipped',
        checks,
        details,
      };
    }

    checks.push('workspace_mutation_check');
    details.push(`Runtime-managed modifications were recorded for ${session.modifiedFiles.length} files.`);

    const scripts = await this.getAvailableScripts(session.workspace.root);
    const pm = session.workspace.packageManager === 'unknown' ? 'npm' : session.workspace.packageManager;

    if (this.tools) {
      // 1. Run formatter / linter validation check if lint script exists
      if (scripts.lint) {
        checks.push('linter_validation');
        const result = await this.tools.execute(
          session,
          {
            adapter: 'shell',
            operation: 'exec',
            input: {
              command: `${pm} run lint`,
              timeoutMs: 45_000,
            },
          },
          {
            sessionId: session.id,
            ownerId: session.ownerId,
            workspaceRoot: session.workspace.root,
            requestId: `validation-lint-${session.id}`,
          },
          this.sessions,
        );
        details.push(`Lint check status: ${result.status}`);
        if (result.status !== 'success') {
          return {
            status: 'failed',
            checks,
            details: [...details, result.error ?? 'Linter checks failed.'],
          };
        }
      }

      // 2. Run compiler check if build script exists
      if (scripts.build) {
        checks.push('compiler_validation');
        const result = await this.tools.execute(
          session,
          {
            adapter: 'shell',
            operation: 'exec',
            input: {
              command: `${pm} run build`,
              timeoutMs: 60_000,
            },
          },
          {
            sessionId: session.id,
            ownerId: session.ownerId,
            workspaceRoot: session.workspace.root,
            requestId: `validation-build-${session.id}`,
          },
          this.sessions,
        );
        details.push(`Compile check status: ${result.status}`);
        if (result.status !== 'success') {
          return {
            status: 'failed',
            checks,
            details: [...details, result.error ?? 'Compiler check failed.'],
          };
        }
      }

      // 3. Run unit tests if test script or command exists
      const testCmd = session.workspace.testCommand || (scripts.test ? `${pm} run test` : null);
      if (testCmd) {
        checks.push('unit_test_validation');
        const result = await this.tools.execute(
          session,
          {
            adapter: 'shell',
            operation: 'exec',
            input: {
              command: testCmd,
              timeoutMs: 60_000,
            },
          },
          {
            sessionId: session.id,
            ownerId: session.ownerId,
            workspaceRoot: session.workspace.root,
            requestId: `validation-test-${session.id}`,
          },
          this.sessions,
        );
        checks.push('runtime_tool_validation');
        details.push(`Runtime tool validation result: ${result.status}`);
        if (result.status === 'success') {
          details.push('Validation checks completed successfully.');
        } else if (result.status === 'approval_required') {
          details.push('Validation checks require approval.');
        } else {
          return {
            status: 'failed',
            checks,
            details: [...details, result.error ?? 'Validation tests failed.'],
          };
        }
      }
    }

    return {
      status: 'passed',
      checks,
      details,
    };
  }
}
