export type ShellPlatform = 'windows' | 'unix' | 'unknown';

export interface ShellPatchRisk {
  command: string;
  reason: string;
}

export interface PythonPatchRisk {
  command: string;
  missingChecks: string[];
}

function collectAssistantCommands(messages: any[]): string[] {
  const cmds: string[] = [];
  for (const msg of messages || []) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const cmd = block.input?.command;
      if (typeof cmd === 'string' && cmd.trim()) {
        cmds.push(cmd.trim());
      }
    }
  }
  return cmds;
}

export function inferShellPlatform(messages: any[]): ShellPlatform {
  const haystack = JSON.stringify(messages || []);
  if (/\bPS\s+[A-Za-z]:\\/i.test(haystack) || /[A-Za-z]:\\/i.test(haystack)) return 'windows';
  if (/\/(home|usr|var|etc|tmp)\//.test(haystack)) return 'unix';
  return 'unknown';
}

export function detectPlatformShellPatchRisks(messages: any[]): {
  platform: ShellPlatform;
  risks: ShellPatchRisk[];
} {
  const platform = inferShellPlatform(messages);
  const commands = collectAssistantCommands(messages.slice(-20));
  const risks: ShellPatchRisk[] = [];

  for (const cmd of commands) {
    if (platform === 'windows' && /(^|\s)(sed|awk|perl\s+-pi)\b/i.test(cmd)) {
      risks.push({
        command: cmd.slice(0, 220),
        reason: 'POSIX patch command on Windows shell',
      });
    }
    if (platform === 'unix' && /\b(Get-Content|Set-Content|Select-String)\b|\bpowershell\b/i.test(cmd)) {
      risks.push({
        command: cmd.slice(0, 220),
        reason: 'PowerShell patch command on Unix shell',
      });
    }
  }

  return { platform, risks };
}

export function buildPlatformShellGuidance(platform: ShellPlatform, risks: ShellPatchRisk[]): string {
  if (risks.length === 0) return '';
  const header = platform === 'windows'
    ? '[PLATFORM_PATCH] Windows shell detected. Use PowerShell-native patching commands.'
    : platform === 'unix'
      ? '[PLATFORM_PATCH] Unix shell detected. Use bash/sed-compatible patching commands.'
      : '[PLATFORM_PATCH] Shell/platform mismatch detected. Use platform-native patching commands.';
  const body = risks
    .slice(0, 3)
    .map((r) => `• ${r.reason}: \`${r.command}\``)
    .join('\n');
  const recommendation = platform === 'windows'
    ? '• Avoid sed/awk/perl -pi. Prefer PowerShell replacements or apply_patch/write_file strategy.'
    : '• Avoid PowerShell cmdlets. Prefer sed/awk/bash patch flow.';
  return ['---', header, body, recommendation, '---'].join('\n');
}

export function detectPythonPatchValidationRisks(messages: any[]): PythonPatchRisk[] {
  const commands = collectAssistantCommands(messages.slice(-20));
  const risks: PythonPatchRisk[] = [];

  for (const cmd of commands) {
    if (!/\bpython(3)?\b/i.test(cmd)) continue;
    if (!/(re\.sub|re\.compile|str_replace|replace\(|write\(|open\()/i.test(cmd)) continue;

    const missingChecks: string[] = [];
    if (!/(py_compile|ast\.parse|compile\()/i.test(cmd)) missingChecks.push('syntax/compile check');
    if (!/re\.compile\(/i.test(cmd)) missingChecks.push('regex validation');
    if (missingChecks.length > 0) {
      risks.push({ command: cmd.slice(0, 220), missingChecks });
    }
  }

  return risks;
}

export function buildPythonPatchValidationGuidance(risks: PythonPatchRisk[]): string {
  if (risks.length === 0) return '';
  const lines = risks.slice(0, 3).map((r) => `• Missing ${r.missingChecks.join(' + ')} before running: \`${r.command}\``);
  return [
    '---',
    '[PY_PATCH_VALIDATE] Generated Python patch scripts must be validated before execution.',
    ...lines,
    '• Validate syntax/compile first, validate regex patterns, then execute patch script.',
    '---',
  ].join('\n');
}
