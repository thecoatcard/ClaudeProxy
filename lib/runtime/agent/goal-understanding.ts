import type { AgentGoal } from './contracts';

type RequestMessage = {
  role?: string;
  content?: unknown;
};

type RuntimeRequestBody = {
  messages?: RequestMessage[];
};

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('\n');
}

export class GoalUnderstandingService {
  understand(body: RuntimeRequestBody): AgentGoal {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const userMessages = messages.filter((message) => message?.role === 'user');
    const objective = userMessages.map((message) => flattenContent(message.content)).join('\n\n').trim()
      || 'Respond to the current request';

    const lowered = objective.toLowerCase();
    const requiredTools = [
      /\b(test|build|compile|lint|fix|refactor|implement)\b/.test(lowered) ? 'shell' : null,
      /\b(file|folder|repository|codebase|project|source)\b/.test(lowered) ? 'filesystem' : null,
      /\b(commit|branch|diff|pull request|git)\b/.test(lowered) ? 'git' : null,
      /\b(browser|website|page|dom)\b/.test(lowered) ? 'browser' : null,
    ].filter((value): value is string => Boolean(value));

    const expectedOutputs = [
      /\bfix|implement|refactor|edit|write|build\b/.test(lowered) ? 'code changes' : null,
      /\bexplain|review|analy[sz]e|report\b/.test(lowered) ? 'structured response' : null,
      /\btest|verify|validate\b/.test(lowered) ? 'verification results' : null,
    ].filter((value): value is string => Boolean(value));

    return {
      objective,
      missingInformation: objective ? [] : ['No user objective was found in the request messages.'],
      requiredTools,
      expectedOutputs,
      constraints: [
        'All repository context must be selected by the runtime.',
        'The runtime must plan before any model call.',
        'The model is execution-only and not the orchestrator.',
      ],
    };
  }
}
