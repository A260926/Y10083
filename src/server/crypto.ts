import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function shortHash(hex: string): string {
  return hex.slice(0, 12);
}
