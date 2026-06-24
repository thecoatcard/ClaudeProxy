// Failure classification and alternative strategy generation for failed tool calls.
// Pure function — no I/O, no Node APIs. Edge-runtime safe.
//
// Given a tool name and the error text from a tool_result, this module:
//   1. Classifies the failure into a known category.
//   2. States the root cause in plain text.
//   3. Prohibits the exact retry.
//   4. Generates concrete alternative steps.
//
// Used by BehaviorAuditor to enrich loop-detector guidance with actionable recovery.

export type FailureClass =
  | 'missing_parent_dir'    // ENOENT writing into a dir that doesn't exist
  | 'missing_file'          // ENOENT reading a file that doesn't exist
  | 'permission_denied'     // EACCES / Permission denied
  | 'command_not_found'     // bash: cmd: not found / not recognized
  | 'bad_path'              // path contains illegal characters, escapes, or is empty
  | 'wrong_arguments'       // invalid argument / unexpected type
  | 'syntax_error'          // SyntaxError / parse error
  | 'transient_error'       // timeout / network error
  | 'unknown';

export interface RetryStrategy {
  failureClass: FailureClass;
  rootCause: string;
  prohibition: string;
  alternativeSteps: string[];
}

const CLASSIFICATION_RULES: Array<{
  pattern: RegExp;
  failureClass: FailureClass;
  rootCause: (match: RegExpMatchArray) => string;
  alternativeSteps: string[];
}> = [
  {
    pattern: /enoent.*no such file or directory.*['"](.*)['"]/i,
    failureClass: 'missing_parent_dir',
    rootCause: (m) => `The parent directory of '${m[1]}' does not exist.`,
    alternativeSteps: [
      'First create the parent directory with a mkdir (recursive) call.',
      'Then retry the write operation with the same path.',
      'Verify the directory was created by listing it before writing.',
    ],
  },
  {
    pattern: /no such file or directory/i,
    failureClass: 'missing_file',
    rootCause: () => 'The target path does not exist.',
    alternativeSteps: [
      'List the parent directory to confirm which files are present.',
      'Check whether a previous write step succeeded before assuming the file exists.',
      'Use a relative or absolute path that you have verified exists.',
    ],
  },
  {
    pattern: /enoent/i,
    failureClass: 'missing_file',
    rootCause: () => 'File or directory not found (ENOENT).',
    alternativeSteps: [
      'Verify the path is correct.',
      'Ensure upstream steps that create this path have actually succeeded.',
    ],
  },
  {
    pattern: /permission denied|eacces|access denied/i,
    failureClass: 'permission_denied',
    rootCause: () => 'The process does not have permission to access this path.',
    alternativeSteps: [
      'Try a path within a directory you own (e.g. home or working directory).',
      'Do not retry with the same path — the permission constraint will persist.',
    ],
  },
  {
    pattern: /command not found|not recognized as (an )?internal or external command|is not recognized/i,
    failureClass: 'command_not_found',
    rootCause: (m) => `The command is not available in this environment.`,
    alternativeSteps: [
      'Check whether the command needs to be installed first.',
      'Try an alternative tool or command that achieves the same goal.',
      'Use a full absolute path to the executable if available.',
    ],
  },
  {
    pattern: /syntaxerror|syntax error|parse error|unexpected token/i,
    failureClass: 'syntax_error',
    rootCause: () => 'The arguments contain a syntax error.',
    alternativeSteps: [
      'Review the argument values for missing quotes, brackets, or escape sequences.',
      'Validate JSON arguments before sending them.',
    ],
  },
  {
    pattern: /invalid (input|argument|parameter|option)|unexpected.*argument|wrong (type|number)/i,
    failureClass: 'wrong_arguments',
    rootCause: () => 'The tool was called with incorrect arguments.',
    alternativeSteps: [
      'Refer to the tool\'s input_schema and verify every required field is present.',
      'Check that argument types match (string vs number, array vs scalar).',
      'Remove any extra fields not accepted by the tool.',
    ],
  },
  {
    pattern: /timeout|timed out|etimedout/i,
    failureClass: 'transient_error',
    rootCause: () => 'The operation timed out.',
    alternativeSteps: [
      'Retry with a smaller scope (e.g. process fewer files, a shorter command).',
      'Break the work into smaller steps.',
    ],
  },
];

const BAD_PATH_PATTERNS: RegExp[] = [
  /\.\.[/\\]/,
  /[/\\]{2,}/,
  /\0/,
];

export function classifyFailure(toolName: string, errorText: string): RetryStrategy {
  if (!errorText) {
    return {
      failureClass: 'unknown',
      rootCause: 'No error text was captured.',
      prohibition: `Do not retry ${toolName} identically — the prior call produced no useful error.`,
      alternativeSteps: ['Inspect the call arguments and verify your assumptions before retrying.'],
    };
  }

  for (const rule of CLASSIFICATION_RULES) {
    const match = errorText.match(rule.pattern);
    if (match) {
      return {
        failureClass: rule.failureClass,
        rootCause: rule.rootCause(match),
        prohibition: `Do not call ${toolName} again with the same arguments.`,
        alternativeSteps: rule.alternativeSteps,
      };
    }
  }

  return {
    failureClass: 'unknown',
    rootCause: `Unclassified error from ${toolName}: ${errorText.slice(0, 200)}`,
    prohibition: `Do not repeat the identical ${toolName} call.`,
    alternativeSteps: [
      'Read the full error message and identify any path, permission, or argument problems.',
      'Change at least one parameter, or use a different tool.',
    ],
  };
}

/** Format a RetryStrategy into a concise text fragment for systemInstruction injection. */
export function formatStrategy(strategy: RetryStrategy): string {
  return [
    `Root cause: ${strategy.rootCause}`,
    `Prohibition: ${strategy.prohibition}`,
    'Required steps:',
    ...strategy.alternativeSteps.map((s, i) => `  ${i + 1}. ${s}`),
  ].join('\n');
}
