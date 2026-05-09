import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  analyzeLongRunningProcessOutput,
  assessLongRunningProcessHistory,
  detectLongRunningProcessCommand,
  detectShellEnvironment,
  getTerminationGuidance,
} from '../lib/agent/process-supervisor';

function pair(id: string, command: string, output: string, isError = false) {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }],
    },
  ];
}

describe('process supervisor detection and analysis', () => {
  it('1. npm run dev detected', () => {
    const d = detectLongRunningProcessCommand('npm run dev -- --host 0.0.0.0');
    assert.equal(d.intent, 'LONG_RUNNING_PROCESS');
  });

  it('2. uvicorn detected', () => {
    const d = detectLongRunningProcessCommand('uvicorn app.main:app --reload --port 8000');
    assert.equal(d.intent, 'LONG_RUNNING_PROCESS');
  });

  it('3. cargo run detected', () => {
    const d = detectLongRunningProcessCommand('cargo run');
    assert.equal(d.intent, 'LONG_RUNNING_PROCESS');
  });

  it('4. dotnet run detected', () => {
    const d = detectLongRunningProcessCommand('dotnet run --project src/Web');
    assert.equal(d.intent, 'LONG_RUNNING_PROCESS');
  });

  it('5. docker compose up detected', () => {
    const d = detectLongRunningProcessCommand('docker compose up --build');
    assert.equal(d.intent, 'LONG_RUNNING_PROCESS');
  });

  it('6. startup success detected', () => {
    const a = analyzeLongRunningProcessOutput('Server started. Listening on http://localhost:3000');
    assert.equal(a.state, 'STARTED');
  });

  it('7. startup failure detected', () => {
    const a = analyzeLongRunningProcessOutput('Traceback (most recent call last): failed to start', true);
    assert.equal(a.state, 'FAILED');
  });

  it('8. build command ignored', () => {
    const d = detectLongRunningProcessCommand('npm run build');
    assert.equal(d.intent, 'NON_LONG_RUNNING');
  });

  it('9. lint command ignored', () => {
    const d = detectLongRunningProcessCommand('pnpm lint');
    assert.equal(d.intent, 'NON_LONG_RUNNING');
  });

  it('10. exit code 1 + ready = STARTED', () => {
    const a = analyzeLongRunningProcessOutput('exited with code 1\nready in 2s\nLocal: http://localhost:5173', true);
    assert.equal(a.state, 'STARTED');
  });

  it('11. port fallback + ready = STARTED', () => {
    const a = analyzeLongRunningProcessOutput('Port 3000 in use\nUsing available port 3002\nReady in 2s');
    assert.equal(a.state, 'STARTED');
    assert.equal(a.hasPortFallback, true);
  });

  it('12. Git Bash environment kill guidance correct', () => {
    const env = detectShellEnvironment('bash -lc "npm run dev"');
    assert.equal(env, 'git-bash');
    const g = getTerminationGuidance(env);
    assert.match(g, /cmd \/c taskkill/i);
  });

  it('13. PowerShell environment kill guidance correct', () => {
    const env = detectShellEnvironment('powershell -Command npm run dev');
    assert.equal(env, 'powershell');
    const g = getTerminationGuidance(env);
    assert.match(g, /taskkill \/F \/PID/i);
  });

  it('14. Unix environment kill guidance correct', () => {
    const env = detectShellEnvironment('/bin/sh -c "uvicorn app:app --reload"');
    assert.equal(env, 'unix');
    const g = getTerminationGuidance(env);
    assert.match(g, /kill -9/i);
  });

  it('injects long-running monitoring guidance from history assessment', () => {
    const messages = [
      ...pair('p1', 'npm run dev', 'Port 3000 already in use\nUsing available port 3002\nReady in 2s'),
    ];

    const assessment = assessLongRunningProcessHistory(messages);
    assert.equal(assessment.foundLongRunningCommand, true);
    assert.equal(assessment.lastAnalysis?.state, 'STARTED');
    // BUG-012 FIX: STARTED state suppresses guidance noise. Guidance is empty.
    assert.equal(assessment.guidance, '', 'STARTED state should produce no guidance (BUG-012)');
  });

  it('injects guidance for UNKNOWN process state (not STARTED)', () => {
    const messages = [
      ...pair('p1', 'npm run dev', 'Starting server...'),
    ];

    const assessment = assessLongRunningProcessHistory(messages);
    assert.equal(assessment.foundLongRunningCommand, true);
    assert.ok(assessment.lastAnalysis?.state !== 'STARTED');
    // Non-STARTED states SHOULD produce guidance.
    assert.match(assessment.guidance, /long-running process/i);
  });
});
