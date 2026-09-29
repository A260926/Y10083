let counter = 0;

export function idWithTime(prefix: string, seed: string, nowIso: string): string {
  const stamp = BigInt(Date.parse(nowIso)).toString(36);
  counter = (counter + 1) % 1_000_000;
  let h = 2166136261;
  const data = `${prefix}:${seed}:${nowIso}:${counter}`;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}_${stamp}_${(h >>> 0).toString(36)}${counter.toString(36)}`;
}
