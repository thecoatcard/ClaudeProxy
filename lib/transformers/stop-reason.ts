export function mapStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'TOOL_CALLS': return 'tool_use';
    case 'SAFETY': return 'content_filter';
    case 'RECITATION': return 'content_filter';
    default: return 'end_turn';
  }
}
