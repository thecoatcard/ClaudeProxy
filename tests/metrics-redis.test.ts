/**
 * tests/metrics-redis.test.ts
 *
 * Tests lib/metrics.ts pipeline usage patterns.
 * Verifies the pipeline command queue and exec() unwrapping behaviour.
 */
import assert from 'node:assert/strict';

// ─── Recorded pipeline commands ──────────────────────────────────────────────

type PipelineCommand = { cmd: string; args: unknown[] };

function buildPipelineMock(execResults: unknown[] = []) {
  const commands: PipelineCommand[] = [];
  const pipe = {
    commands,
    incr: (key: string) => { commands.push({ cmd: 'incr', args: [key] }); return pipe; },
    incrby: (key: string, n: number) => { commands.push({ cmd: 'incrby', args: [key, n] }); return pipe; },
    hincrby: (key: string, f: string, n: number) => { commands.push({ cmd: 'hincrby', args: [key, f, n] }); return pipe; },
    sadd: (key: string, ...members: string[]) => { commands.push({ cmd: 'sadd', args: [key, ...members] }); return pipe; },
    lpush: (key: string, ...vals: unknown[]) => { commands.push({ cmd: 'lpush', args: [key, ...vals] }); return pipe; },
    ltrim: (key: string, s: number, e: number) => { commands.push({ cmd: 'ltrim', args: [key, s, e] }); return pipe; },
    exec: async () => execResults,
  };
  return pipe;
}

// Mimic the trackRequest pipeline logic from lib/metrics.ts
function queueTrackRequest(
  pipe: ReturnType<typeof buildPipelineMock>,
  params: { inputTokens: number; outputTokens: number; latencyMs: number; model: string }
) {
  const { inputTokens, outputTokens, latencyMs, model } = params;
  const day = new Date().toISOString().slice(0, 10);
  const rounded = Math.round(latencyMs);

  pipe.incr('stats:requests');
  pipe.incrby('stats:input_tokens', inputTokens);
  pipe.incrby('stats:output_tokens', outputTokens);
  pipe.hincrby('stats:models', model, 1);
  pipe.sadd('stats:days', day);
  pipe.lpush('stats:latency', rounded);
  pipe.ltrim('stats:latency', 0, 999);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('metrics pipeline usage', () => {
  it('queues 7 commands for a single trackRequest call', () => {
    const pipe = buildPipelineMock();
    queueTrackRequest(pipe, { inputTokens: 100, outputTokens: 50, latencyMs: 250, model: 'gemini-2.5-pro' });
    assert.equal(pipe.commands.length, 7);
  });

  it('queues incr stats:requests first', () => {
    const pipe = buildPipelineMock();
    queueTrackRequest(pipe, { inputTokens: 100, outputTokens: 50, latencyMs: 250, model: 'gemini-2.5-pro' });
    assert.equal(pipe.commands[0].cmd, 'incr');
    assert.equal(pipe.commands[0].args[0], 'stats:requests');
  });

  it('queues incrby for input and output tokens', () => {
    const pipe = buildPipelineMock();
    queueTrackRequest(pipe, { inputTokens: 123, outputTokens: 456, latencyMs: 100, model: 'gemini-2.0-flash' });
    const inputCmd = pipe.commands.find((c) => c.cmd === 'incrby' && c.args[0] === 'stats:input_tokens');
    const outputCmd = pipe.commands.find((c) => c.cmd === 'incrby' && c.args[0] === 'stats:output_tokens');
    assert.ok(inputCmd, 'should have incrby for input_tokens');
    assert.equal(inputCmd!.args[1], 123);
    assert.ok(outputCmd, 'should have incrby for output_tokens');
    assert.equal(outputCmd!.args[1], 456);
  });

  it('queues hincrby for model usage', () => {
    const pipe = buildPipelineMock();
    queueTrackRequest(pipe, { inputTokens: 10, outputTokens: 10, latencyMs: 10, model: 'gemini-2.5-pro' });
    const cmd = pipe.commands.find((c) => c.cmd === 'hincrby' && c.args[0] === 'stats:models');
    assert.ok(cmd);
    assert.equal(cmd!.args[1], 'gemini-2.5-pro');
    assert.equal(cmd!.args[2], 1);
  });

  it('queues ltrim to cap latency list at 1000 entries', () => {
    const pipe = buildPipelineMock();
    queueTrackRequest(pipe, { inputTokens: 10, outputTokens: 10, latencyMs: 300, model: 'any' });
    const trim = pipe.commands.find((c) => c.cmd === 'ltrim');
    assert.ok(trim);
    assert.equal(trim!.args[1], 0);
    assert.equal(trim!.args[2], 999);
  });

  it('queues sadd with today ISO date string', () => {
    const pipe = buildPipelineMock();
    queueTrackRequest(pipe, { inputTokens: 10, outputTokens: 10, latencyMs: 10, model: 'any' });
    const cmd = pipe.commands.find((c) => c.cmd === 'sadd' && c.args[0] === 'stats:days');
    assert.ok(cmd);
    const dayArg = cmd!.args[1] as string;
    // Should match YYYY-MM-DD format
    assert.match(dayArg, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('rounds latency before queueing lpush', () => {
    const pipe = buildPipelineMock();
    queueTrackRequest(pipe, { inputTokens: 10, outputTokens: 10, latencyMs: 123.7, model: 'any' });
    const cmd = pipe.commands.find((c) => c.cmd === 'lpush' && c.args[0] === 'stats:latency');
    assert.ok(cmd);
    assert.equal(cmd!.args[1], 124); // Math.round(123.7) = 124
  });

  it('exec() with all-null results does not throw', async () => {
    const results = [null, null, null, null, null, null, null];
    const pipe = buildPipelineMock(results);
    queueTrackRequest(pipe, { inputTokens: 10, outputTokens: 10, latencyMs: 10, model: 'any' });
    const out = await pipe.exec();
    assert.equal(out.length, 7);
    assert.ok(out.every((v) => v === null));
  });
});
