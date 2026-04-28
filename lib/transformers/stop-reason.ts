export function mapStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'TOOL_CALLS': return 'tool_use';
    case 'SAFETY': return 'end_turn'; // Anthropic spec says just end_turn or sometimes stop_reason error, but plan says end_turn (and log)
    case 'RECITATION': return 'end_turn';
    default: return 'end_turn';
  }
}
