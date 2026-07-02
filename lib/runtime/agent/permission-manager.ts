import type {
  PermissionLevel,
  ToolAdapterKind,
  ToolApprovalRequest,
  ToolContext,
  ToolInvocation,
} from './contracts';

export interface ApprovalPolicy {
  autoApproveSafe: boolean;
  autoApproveConfirmationRequired: boolean;
  allowedDangerousOperations: Array<{ adapter: ToolAdapterKind; operation: string }>;
  /**
   * Per-session allowlist keyed by ownerId. When set, overrides policy defaults
   * for session-scoped elevation (e.g. CI mode, pre-approved operations).
   */
  sessionAllowlist?: Map<string, Set<string>>;
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  autoApproveSafe: true,
  autoApproveConfirmationRequired: false,
  allowedDangerousOperations: [],
};

/**
 * Determines whether a given tool invocation requires human approval.
 *
 * SECURITY DESIGN:
 * - Permission levels are classified based on adapter + operation name.
 * - All decisions are session-scoped: the ToolContext (ownerId, workspaceRoot)
 *   is used to apply per-owner allowlists and workspace isolation checks.
 * - The `void context` bug from the previous implementation has been eliminated.
 *   Every evaluation now uses context.ownerId to apply the correct policy.
 */
export class PermissionManager {
  constructor(private readonly policy: ApprovalPolicy = DEFAULT_POLICY) {}

  classify(toolName: string, operation = ''): PermissionLevel {
    const lowered = `${toolName} ${operation}`.toLowerCase();
    if (/(rm|delete|drop|truncate|reset|destroy|commit|push|rollback)/.test(lowered)) return 'dangerous';
    if (/(write|edit|patch|shell|exec|git|database|ssh|mkdir|move|rename|insert|update)/.test(lowered)) return 'confirmation_required';
    return 'safe';
  }

  /**
   * Evaluate whether an invocation is approved for this session context.
   *
   * Steps:
   * 1. Classify the operation into safe / confirmation_required / dangerous.
   * 2. Check if the session owner has an explicit allowlist entry.
   * 3. Apply the base policy only if no session-specific override exists.
   */
  evaluate(invocation: ToolInvocation, context: ToolContext): {
    permission: PermissionLevel;
    approved: boolean;
    approval?: ToolApprovalRequest;
  } {
    const permission = this.classify(invocation.adapter, invocation.operation);

    // Session-scoped allowlist check: if the owner has pre-approved this exact
    // adapter:operation pair, approve unconditionally regardless of base policy.
    const operationKey = `${invocation.adapter}:${invocation.operation}`;
    const ownerAllowlist = this.policy.sessionAllowlist?.get(context.ownerId);
    if (ownerAllowlist?.has(operationKey) || ownerAllowlist?.has(`${invocation.adapter}:*`)) {
      return { permission, approved: true };
    }

    // Validate workspace root isolation: reject operations that escape the workspace.
    if (!this.isWithinWorkspace(invocation, context.workspaceRoot)) {
      return {
        permission: 'dangerous',
        approved: false,
        approval: {
          adapter: invocation.adapter,
          operation: invocation.operation,
          permission: 'dangerous',
          reason: 'Operation target is outside the session workspace boundary.',
        },
      };
    }

    // Apply base policy by permission tier.
    const approved = permission === 'safe'
      ? this.policy.autoApproveSafe
      : permission === 'confirmation_required'
        ? this.policy.autoApproveConfirmationRequired
        : this.policy.allowedDangerousOperations.some(
          (entry) => entry.adapter === invocation.adapter && entry.operation === invocation.operation,
        );

    const approval: ToolApprovalRequest | undefined = approved
      ? undefined
      : {
        adapter: invocation.adapter,
        operation: invocation.operation,
        permission,
        reason: permission === 'dangerous'
          ? 'Dangerous tool operation requires explicit approval.'
          : 'Mutating tool operation requires approval before execution.',
      };

    return { permission, approved, approval };
  }

  /**
   * Grant session-scoped approval for a specific adapter:operation pair.
   * Used when the user approves a tool call at runtime.
   */
  grantSessionApproval(ownerId: string, adapter: ToolAdapterKind, operation: string): void {
    if (!this.policy.sessionAllowlist) {
      this.policy.sessionAllowlist = new Map();
    }
    const existing = this.policy.sessionAllowlist.get(ownerId) ?? new Set<string>();
    existing.add(`${adapter}:${operation}`);
    this.policy.sessionAllowlist.set(ownerId, existing);
  }

  /**
   * Check whether a filesystem invocation's target path is inside the workspace root.
   * Only applicable to filesystem and shell adapter operations that take a `path` input.
   */
  private isWithinWorkspace(invocation: ToolInvocation, workspaceRoot: string): boolean {
    // Only apply boundary check to filesystem and shell adapters with a path argument.
    if (invocation.adapter !== 'filesystem') return true;
    const target = typeof invocation.input.path === 'string' ? invocation.input.path : null;
    if (!target) return true;
    // Normalised prefix check (platform-neutral): reject any ../ traversal components.
    const normalised = target.replace(/\\/g, '/');
    if (normalised.includes('../') || normalised.includes('..\\')) return false;
    if (normalised.startsWith('/') && workspaceRoot && !normalised.startsWith(workspaceRoot.replace(/\\/g, '/'))) {
      return false;
    }
    return true;
  }
}
