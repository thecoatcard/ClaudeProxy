export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
