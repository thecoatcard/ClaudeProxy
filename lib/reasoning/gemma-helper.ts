// lib/reasoning/gemma-helper.ts
//
// Gemma 4 lightweight reasoning helper.
//
// Uses gemma-4-31b-it as a fast, lightweight helper model for tasks that
// need structured reasoning but don't require the full power of the main model:
//
//   1. Operational state compression (summarize long state to short guidance)
//   2. Dependency compatibility reasoning (is this version safe?)
//   3. Error interpretation (what is actually wrong here?)
//   4. Recovery planning (what should the model do next?)
//   5. Contradiction analysis (why is this loop happening?)
//
// Architecture note:
//   - Gemma is NOT a fallback to the main model chain.
//   - It is a helper called at request preparation time.
//   - Results are injected into systemInstruction as concise hints.
//   - Max 1 call per request turn to avoid latency spikes.
//   - Hard timeout of 8 seconds — guidance is best-effort.
//
// Edge-runtime safe. Uses fetch + Gemini API directly.

const GEMMA_MODEL = 'gemma-4-31b-it';
const GEMMA_TIMEOUT_MS = 8000;
const GEMMA_MAX_OUTPUT_TOKENS = 512;

export interface GemmaReasoningRequest {
  task: 'compress_state' | 'analyze_error' | 'plan_recovery' | 'check_dependency' | 'explain_contradiction';
  context: string;
  /** Additional structured data for the task. */
  data?: Record<string, unknown>;
}

export interface GemmaReasoningResult {
  success: boolean;
  output: string;
  tokenCount?: number;
  /** Whether the result should be injected as guidance. */
  injectAsGuidance: boolean;
}

// ─── Prompt templates ──────────────────────────────────────────────────────────

function buildPrompt(req: GemmaReasoningRequest): string {
  switch (req.task) {
    case 'compress_state':
      return `You are a concise technical assistant. Compress the following AI agent operational state into a 3-5 bullet summary that highlights only the most important constraints for the next action. Be specific and actionable. Do not include unimportant details.

OPERATIONAL STATE:
${req.context}

Respond with ONLY the bullet points. No intro, no explanation. Example format:
• Shell: PowerShell on Windows. No Unix commands.
• Project root: C:/Users/dev/myapp
• Known missing: src/components/Button.tsx
• Blocked: interactive CLI wizards (run non-interactively with --yes flags)`;

    case 'analyze_error':
      return `You are a senior software engineer. Analyze this tool error and identify the ROOT CAUSE in one sentence. Then suggest the single most likely correct fix.

ERROR:
${req.context}

${req.data?.command ? `COMMAND THAT FAILED: ${req.data.command}` : ''}

Response format:
ROOT CAUSE: [one sentence]
FIX: [specific actionable fix, no guessing]
DOCS NEEDED: [yes/no — should we search official docs first?]`;

    case 'plan_recovery':
      return `You are an expert at debugging software failures. Given this repeated error context, propose a concrete recovery plan with numbered steps. Do NOT suggest retrying the same approach.

REPEATED ERROR:
${req.context}

Respond with:
RECOVERY PLAN:
1. [first step]
2. [second step]
3. [third step]
(max 4 steps, be specific)`;

    case 'check_dependency':
      return `You are a dependency compatibility expert. Given this package and version information, identify any known incompatibilities or breaking changes.

PACKAGES:
${req.context}

For each risky package respond with:
PACKAGE: [name]
RISK: [low/medium/high/critical]
REASON: [one sentence]
SAFE VERSION: [version or "verify latest"]

If no risks, respond: ALL CLEAR`;

    case 'explain_contradiction':
      return `You are a debugging expert. An AI agent is caught in a contradiction loop — it keeps oscillating between opposing actions. Analyze why and suggest how to break the cycle.

CONTRADICTION:
${req.context}

Respond with:
ROOT CAUSE: [why is this happening?]
BREAK CYCLE: [what fundamentally different approach should be taken?]
SEARCH FOR: [what should be web-searched to resolve this?]`;

    default:
      return req.context;
  }
}

// ─── Gemini API call (non-streaming) ──────────────────────────────────────────

async function callGemmaWithTimeout(
  prompt: string,
  apiKey: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMMA_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: GEMMA_MAX_OUTPUT_TOKENS,
          topP: 0.9,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemma API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Key selection ─────────────────────────────────────────────────────────────

async function getGemmaKey(): Promise<string | null> {
  // Import lazily to avoid circular deps
  try {
    const { getHealthiestKeyObj } = await import('../key-manager');
    const keyObj = await getHealthiestKeyObj();
    return keyObj?.key ?? null;
  } catch {
    // Fallback: try env directly
    const envKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    return envKey ?? null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a lightweight reasoning task via Gemma 4.
 * Always returns a result — failure produces success=false with empty output.
 * Never throws.
 */
export async function runGemmaReasoning(
  req: GemmaReasoningRequest,
): Promise<GemmaReasoningResult> {
  try {
    const apiKey = await getGemmaKey();
    if (!apiKey) {
      return { success: false, output: '', injectAsGuidance: false };
    }

    const prompt = buildPrompt(req);
    const output = await callGemmaWithTimeout(prompt, apiKey);

    if (!output) {
      return { success: false, output: '', injectAsGuidance: false };
    }

    return {
      success: true,
      output,
      injectAsGuidance: true,
    };
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    if (!isTimeout) {
      console.warn('[GemmaHelper] reasoning error:', err?.message ?? err);
    }
    return { success: false, output: '', injectAsGuidance: false };
  }
}

/**
 * Compress an operational state string into a short bullet summary.
 * Fast, best-effort. Returns the raw state if Gemma fails.
 */
export async function compressOperationalState(
  rawGuidance: string,
  maxLines = 5,
): Promise<string> {
  if (!rawGuidance || rawGuidance.length < 200) return rawGuidance;

  const result = await runGemmaReasoning({
    task: 'compress_state',
    context: rawGuidance,
  });

  if (!result.success || !result.output) return rawGuidance;

  // Keep the Gemma output but wrap it in context markers
  return [
    '',
    '---',
    '[GATEWAY OPERATIONAL CONTEXT — COMPRESSED]',
    result.output
      .split('\n')
      .slice(0, maxLines + 2)
      .join('\n'),
    '---',
    '',
  ].join('\n');
}

/**
 * Analyze a tool error to identify root cause and suggested fix.
 * Returns empty string on failure.
 */
export async function analyzeToolError(
  errorText: string,
  command?: string,
): Promise<string> {
  const result = await runGemmaReasoning({
    task: 'analyze_error',
    context: errorText.slice(0, 1500),
    data: command ? { command } : undefined,
  });

  if (!result.success || !result.output) return '';

  return [
    '',
    '[GEMMA ERROR ANALYSIS]',
    result.output,
    '',
  ].join('\n');
}

/**
 * Get a recovery plan for a repeated failure.
 * Returns empty string on failure.
 */
export async function planRecovery(errorContext: string): Promise<string> {
  const result = await runGemmaReasoning({
    task: 'plan_recovery',
    context: errorContext.slice(0, 1200),
  });

  if (!result.success || !result.output) return '';

  return [
    '',
    '[GEMMA RECOVERY PLAN]',
    result.output,
    '',
  ].join('\n');
}
