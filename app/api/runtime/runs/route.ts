import { NextResponse } from 'next/server';
import { z } from 'zod';
import { dependencyError, runtimeOwner, sessionToRun } from './http';
import { getAgentSessionRepository } from '@/lib/runtime/agent/session-service';
import { WorkspaceManager } from '@/lib/runtime/agent/workspace-manager';
import { RepositoryAnalyzer } from '@/lib/runtime/agent/repository-analyzer';
import { PermissionManager } from '@/lib/runtime/agent/permission-manager';
import { ToolRegistry } from '@/lib/runtime/agent/tool-registry';
import { ContextBuilder } from '@/lib/runtime/agent/context-builder';
import { MemoryManager } from '@/lib/runtime/agent/memory-manager';
import { Planner } from '@/lib/runtime/agent/planner';

export const dynamic = 'force-dynamic';

const createRunSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
}).strict();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.coerce.number().int().nonnegative().optional(),
}).strict();

export async function POST(req: Request) {
  const adminOwner = await runtimeOwner(req);
  if (!adminOwner) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createRunSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const repository = await getAgentSessionRepository();
    const workspace = await new WorkspaceManager().initialize();
    const analysis = await new RepositoryAnalyzer().analyze(workspace);
    const tools = new ToolRegistry(new PermissionManager()).build({});
    const goal = {
      objective: parsed.data.objective,
      missingInformation: [],
      requiredTools: tools.map((tool) => tool.name),
      expectedOutputs: ['runtime session'],
      constraints: ['Session created through runtime control plane.'],
    };
    const context = await new ContextBuilder(new MemoryManager()).build(goal, workspace, analysis, tools);
    const memory = new MemoryManager().initialize(goal, analysis, context);
    const tasks = new Planner().buildPlan(goal, analysis, tools);
    const session = await repository.create({
      ownerId: adminOwner,
      requestedModel: 'control-plane',
      goal,
      workspace,
      tasks,
      memory,
    });
    const run = sessionToRun(session);
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    if ((error as Error).name === 'MongoConfigurationError') {
      return dependencyError();
    }
    throw error;
  }
}

export async function GET(req: Request) {
  const ownerId = await runtimeOwner(req);
  if (!ownerId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    before: url.searchParams.get('before') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const repository = await getAgentSessionRepository();
    const runs = (await repository.listAll(parsed.data.limit, parsed.data.before)).map(sessionToRun);
    return NextResponse.json({ runs });
  } catch (error) {
    if ((error as Error).name === 'MongoConfigurationError') {
      return dependencyError();
    }
    throw error;
  }
}
