import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import {
  forceReloadRouting,
  getEffectiveRoutingRegistry,
  getRoutingDiagnostics,
  saveRoutingRegistry,
} from '@/lib/model-router';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const registry = await getEffectiveRoutingRegistry();
  const diagnostics = await getRoutingDiagnostics();
  return NextResponse.json({
    models: registry,
    routing: diagnostics,
  });
}

export async function POST(req: Request) {
  if (!(await validateAdminKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const { models } = await req.json();
  const diagnostics = await saveRoutingRegistry(models);
  // Double-check that in-process cache was refreshed.
  await forceReloadRouting();
  return NextResponse.json({
    success: true,
    message: `Routing updated and reloaded (source=${diagnostics.source}, version=${diagnostics.version}).`,
    routing: diagnostics,
  });
}
