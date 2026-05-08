export function mapStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'STOP':          return 'end_turn';
    case 'MAX_TOKENS':    return 'max_tokens';
    case 'FUNCTION_CALL': return 'tool_use';  // Gemini's actual finish reason for tool calls
    case 'TOOL_CALLS':    return 'tool_use';  // kept for safety (older API versions)
    case 'SAFETY':        return 'content_filter';
    case 'RECITATION':    return 'content_filter';
    default:              return 'end_turn';
  }
}
