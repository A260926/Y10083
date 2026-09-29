import { ALGO_VERSION, type AnchorView, type TimeAnchor } from './types.js';

export const DAY_MS = 86_400_000;

export type ObservedKind = 'absolute' | 'wallclock';

export interface ParsedObserved {
  kind: ObservedKind;
  ms: number;
  display: string;
}

const WALL_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const WALL_RE_MM = /^(\d{2}):(\d{2})$/;

export function parseObserved(value: string | number): ParsedObserved {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'absolute', ms: Math.trunc(value), display: new Date(value).toISOString() };
  }
  if (typeof value !== 'string') throw new Error('observedAt 必须是 ISO 字符串、HH:MM[:SS] 墙钟或毫秒数');
  const trimmed = value.trim();

  const epoch = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(epoch) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { kind: 'absolute', ms: Math.trunc(epoch), display: new Date(epoch).toISOString() };
  }

  const m = WALL_RE.exec(trimmed);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = m[3] ? Number(m[3]) : 0;
    const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
    if (hh > 23 || mm > 59 || ss > 59) throw new Error(`非法墙钟时间: ${trimmed}`);
    return { kind: 'wallclock', ms: hh * 3_600_000 + mm * 60_000 + ss * 1000 + ms, display: trimmed };
  }
  if (WALL_RE_MM.test(trimmed)) throw new Error(`非法墙钟时间: ${trimmed}`);

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`无法解析时间: ${trimmed}`);
  return { kind: 'absolute', ms: parsed, display: new Date(parsed).toISOString() };
}

export function parseReferenceAt(value: string): number {
  if (typeof value !== 'string') throw new Error('referenceAt 必须是 ISO 时间字符串');
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) throw new Error(`无法解析参考时间: ${value}`);
  return ms;
}

export interface OrderedAnchor {
  anchorId: string;
  source: string;
  observedMs: number;
  observedRawMs: number;
  kind: ObservedKind;
  referenceMs: number;
  dayShift: number;
  offset: number;
  note: string;
}

/**
 * 两阶段展开锚点（规则固定、可解释、可复现）：
 * 阶段 A：按参考时间排序，从首个锚点的 floor 日偏移开始；
 * 阶段 B：每个后续锚点在“相对上一点流逝非负”的候选日期中选流逝最小者。
 * 时钟回卷（钟面从 00:xx 跳回 23:xx）因此表现为同夜内的短流逝，不会被推进一天。
 */
export function buildSourceModel(anchors: TimeAnchor[]): OrderedAnchor[] {
  const ordered = anchors
    .map((a) => ({ raw: a, observed: parseObserved(a.observedAt), referenceMs: parseReferenceAt(a.referenceAt) }))
    .sort((x, y) => x.referenceMs - y.referenceMs || x.observed.ms - y.observed.ms);

  const out: OrderedAnchor[] = [];
  for (const item of ordered) {
    let dayShift = 0;
    let observedMs = item.observed.ms;
    if (item.observed.kind === 'wallclock') {
      if (out.length === 0) {
        dayShift = Math.floor((item.referenceMs - item.observed.ms) / DAY_MS) * DAY_MS;
      } else {
        const prev = out[out.length - 1];
        const baseShift = Math.floor((prev.observedMs - item.observed.ms) / DAY_MS) * DAY_MS;
        let chosen = baseShift;
        let chosenElapsed = Infinity;
        for (let k = -6; k <= 6; k++) {
          const candidateShift = baseShift + k * DAY_MS;
          const elapsed = item.observed.ms + candidateShift - prev.observedMs;
          if (elapsed < 0) continue;
          if (elapsed < chosenElapsed) {
            chosenElapsed = elapsed;
            chosen = candidateShift;
          }
        }
        if (chosenElapsed === Infinity) {
          for (let k = -6; k <= 6; k++) {
            const candidateShift = baseShift + k * DAY_MS;
            const elapsed = Math.abs(item.observed.ms + candidateShift - prev.observedMs);
            if (elapsed < chosenElapsed) {
              chosenElapsed = elapsed;
              chosen = candidateShift;
            }
          }
        }
        dayShift = chosen;
      }
      observedMs = item.observed.ms + dayShift;
    }

    out.push({
      anchorId: item.raw.anchorId,
      source: item.raw.source,
      observedMs,
      observedRawMs: item.observed.ms,
      kind: item.observed.kind,
      referenceMs: item.referenceMs,
      dayShift,
      offset: item.referenceMs - observedMs,
      note: item.raw.note ?? ''
    });
  }
  return out;
}
/**
 * 展开事件裸钟面值（规则与锚点阶段 B 一致，可解释）：
 * 锚点已按参考时间排序。事件的参考时刻未知，但它的观测时刻必然落在
 * 某个“相邻锚点观测区间”里（或首/末锚点之外）。对每个区间，用区间两端
 * 锚点的日偏移枚举候选，使候选值夹在两端观测绝对时刻之间；
 * 外推区间直接采用首/末锚点的日偏移。这样的候选在每段内至多一个。
 */
function unwrapWallEvent(rawMs: number, chain: OrderedAnchor[]): number {
  if (chain.length === 1) return rawMs + chain[0].dayShift;

  // 内插优先：按参考时间从早到晚找第一个能容纳该钟面值的锚点区间。
  // 同一钟面值在时钟回跳场景下会出现两次，先发生的一次归入更早的参考段。
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const lo = Math.min(a.observedMs, b.observedMs);
    const hi = Math.max(a.observedMs, b.observedMs);
    const baseShift = Math.floor((lo - rawMs) / DAY_MS) * DAY_MS;
    for (let k = -6; k <= 6; k++) {
      const candidate = rawMs + baseShift + k * DAY_MS;
      if (candidate >= lo && candidate <= hi) return candidate;
    }
  }

  // 外推：早于首锚点则贴首日域，晚于末锚点则贴末日域
  const before = rawMs + chain[0].dayShift;
  const after = rawMs + chain[chain.length - 1].dayShift;
  const firstMs = Math.min(...chain.map((a) => a.observedMs));
  const lastMs = Math.max(...chain.map((a) => a.observedMs));
  if (Math.abs(before - firstMs) <= Math.abs(after - lastMs)) return before;
  return after;
}


function mod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

export interface CorrectionResult {
  correctedMs: number;
  halfWidthMs: number;
  extrapolated: boolean;
  basisAnchorIds: string[];
  algoVersion: string;
  source: string;
}

const SLOP_MS = 1_000;
const EXTRA_EXTRAPOLATE_MS = 2_000;

export function correctObserved(
  observedValue: string | number,
  source: string,
  anchorsBySource: Map<string, OrderedAnchor[]>
): CorrectionResult | null {
  const parsed = parseObserved(observedValue);
  const allAnchors = anchorsBySource.get(source);
  if (!allAnchors || allAnchors.length === 0) return null;
  const chain = allAnchors.filter((a) => a.kind === 'wallclock');
  const valueMs =
    parsed.kind === 'wallclock'
      ? chain.length > 0
        ? unwrapWallEvent(parsed.ms, chain)
        : parsed.ms
      : parsed.ms;

  const byObserved = [...allAnchors].sort((a, b) => a.observedMs - b.observedMs);

  if (byObserved.length === 1) {
    const only = byObserved[0];
    return result(valueMs + only.offset, SLOP_MS + EXTRA_EXTRAPOLATE_MS, true, [only.anchorId], source);
  }

  let lo = byObserved[0];
  let hi = byObserved[byObserved.length - 1];
  let extrapolated = false;
  if (valueMs < lo.observedMs || valueMs > hi.observedMs) extrapolated = true;

  for (let i = 0; i < byObserved.length - 1; i++) {
    const a = byObserved[i];
    const b = byObserved[i + 1];
    if (valueMs >= a.observedMs && valueMs <= b.observedMs) {
      lo = a;
      hi = b;
      break;
    }
  }
  if (valueMs < byObserved[0].observedMs) {
    lo = byObserved[0];
    hi = byObserved[1];
  } else if (valueMs > byObserved[byObserved.length - 1].observedMs) {
    hi = byObserved[byObserved.length - 1];
    lo = byObserved[byObserved.length - 2];
  }

  const span = hi.observedMs - lo.observedMs;
  const fraction = span === 0 ? 0 : (valueMs - lo.observedMs) / span;
  const offset = lo.offset + fraction * (hi.offset - lo.offset);
  // 漂移量 = 观测流逝与参考流逝之差；时钟跳变直接把它暴露为大不确定度。
  const drift = Math.abs(hi.referenceMs - lo.referenceMs - span);
  const slop = SLOP_MS + drift / 2 + (extrapolated ? EXTRA_EXTRAPOLATE_MS : 0);
  const halfWidthMs = Math.max(1, Math.round(slop));

  const basis = lo.anchorId === hi.anchorId ? [lo.anchorId] : [lo.anchorId, hi.anchorId].sort();
  return result(Math.round(valueMs + offset), halfWidthMs, extrapolated, basis, source);
}

function result(correctedMs: number, halfWidthMs: number, extrapolated: boolean, basisAnchorIds: string[], source: string): CorrectionResult {
  return { correctedMs, halfWidthMs, extrapolated, basisAnchorIds: [...new Set(basisAnchorIds)], algoVersion: ALGO_VERSION, source };
}

export function overlap(a: { lowerMs: number; upperMs: number }, b: { lowerMs: number; upperMs: number }): boolean {
  return a.lowerMs <= b.upperMs && b.lowerMs <= a.upperMs;
}

export function anchorViewFrom(a: TimeAnchor): AnchorView {
  const parsed = parseObserved(a.observedAt);
  return {
    anchorId: a.anchorId,
    source: a.source,
    observedAt: parsed.display,
    observedKind: parsed.kind,
    referenceAt: new Date(parseReferenceAt(a.referenceAt)).toISOString(),
    note: a.note ?? ''
  };
}
