import {
  buildPlatformShellGuidance,
  detectPlatformShellPatchRisks,
  inferShellPlatform,
} from '../lib/agent/tool-reliability-guard';

function assistantCommand(command: string) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'run_in_terminal', input: { command } }],
  };
}

describe('windows shell fallback', () => {
  test('detects windows platform from path markers', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'PS C:\\repo\\project>' }] },
      assistantCommand('sed -i "s/foo/bar/g" src/app.ts'),
    ];

    expect(inferShellPlatform(messages)).toBe('windows');
  });

  test('flags sed/awk patching on windows', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'C:\\repo\\project\\src\\app.ts' }] },
      assistantCommand('sed -i "s/foo/bar/g" src/app.ts'),
    ];

    const result = detectPlatformShellPatchRisks(messages);
    expect(result.platform).toBe('windows');
    expect(result.risks.length).toBeGreaterThan(0);

    const guidance = buildPlatformShellGuidance(result.platform, result.risks);
    expect(guidance).toContain('PowerShell-native');
  });

  test('flags powershell patching on unix', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '/home/user/repo/src/app.ts' }] },
      assistantCommand('Get-Content src/app.ts | Set-Content src/app.ts'),
    ];

    const result = detectPlatformShellPatchRisks(messages);
    expect(result.platform).toBe('unix');
    expect(result.risks.length).toBeGreaterThan(0);
  });
});
