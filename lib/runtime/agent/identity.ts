import { createHash } from 'node:crypto';

export function runtimeActorId(token: string) {
  return `actor_${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
}
