import { sha256Hex } from './crypto.js';
import type { AnchorSnapshot } from './types.js';

export const ALGO_VERSION = 'piecewise-linear-v1';

const EPSILON_MS = 500;

export interface ClockEstimate {
  corr_ms: number | null;
  half_width_ms: number | null;
  basis: string;
}

interface SortedAnchor {
  x: number;
  y: number;
  source: string;
  note?: string;
}

function anchorsFor(anchors: AnchorSnapshot[], sourceId: string): SortedAnchor[] {
  return anchors
    .filter((a) => a.source_id === sourceId)
    .map((a) => ({ x: a.observed_at_ms, y: a.true_at_ms, source: a.source_id, note: a.note }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

function estimateAt(x: number, list: SortedAnchor[]): ClockEstimate {
  if (list.length === 0) {
    return { corr_ms: null, half_width_ms: null, basis: '来源无锚点，未校时' };
  }
  if (list.length === 1) {
    const a = list[0];
    return {
      corr_ms: x + (a.y - a.x),
      half_width_ms: EPSILON_MS,
      basis: `piecewise-linear-v1 单锚点常数偏移=${a.y - a.x}ms（锚点#${a.source}@${a.x}）`,
    };
  }
  let basis: string;
  let corr: number;
  let hw: number;
  if (x <= list[0].x) {
    const a = list[0];
    const b = list[1];
    corr = x + (a.y - a.x);
    hw = EPSILON_MS + (a.x - x);
    basis = `piecewise-linear-v1 首段外推：使用锚点(${a.x}→${a.y})所在首段，偏移=${a.y - a.x}ms，外推距离=${a.x - x}ms`;
  } else if (x >= list[list.length - 1].x) {
    const a = list[list.length - 2];
    const b = list[list.length - 1];
    corr = x + (b.y - b.x);
    hw = EPSILON_MS + (x - b.x);
    basis = `piecewise-linear-v1 末段外推：使用锚点(${b.x}→${b.y})所在末段，偏移=${b.y - b.x}ms，外推距离=${x - b.x}ms`;
  } else {
    let i = 0;
    while (i < list.length - 1 && x > list[i + 1].x) i++;
    const a = list[i];
    const b = list[i + 1];
    if (b.x === a.x) {
      corr = x + (b.y - b.x);
      hw = EPSILON_MS;
      basis = `piecewise-linear-v1 等时锚点退化常数偏移=${b.y - b.x}ms`;
    } else {
      const t = (x - a.x) / (b.x - a.x);
      const yTrue = a.y + t * (b.y - a.y);
      corr = yTrue;
      hw = EPSILON_MS;
      basis = `piecewise-linear-v1 段内插值：锚点(${a.x}→${a.y})与(${b.x}→${b.y})之间，t=${t.toFixed(6)}`;
    }
  }
  return { corr_ms: Math.round(corr), half_width_ms: hw, basis };
}

export function correctTimestamp(
  sourceId: string,
  observedAtMs: number | null,
  anchors: AnchorSnapshot[],
): ClockEstimate {
  if (observedAtMs === null || !Number.isFinite(observedAtMs)) {
    return { corr_ms: null, half_width_ms: null, basis: '缺少来源观测时间，未校时' };
  }
  return estimateAt(observedAtMs, anchorsFor(anchors, sourceId));
}

export function anchorSignature(anchors: AnchorSnapshot[]): string {
  const canonical = canonicalStable(
    [...anchors]
      .map((a) => ({
        s: a.source_id,
        o: a.observed_at_ms,
        t: a.true_at_ms,
      }))
      .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.o - b.o || a.t - b.t)),
  );
  return sha256Hex(canonical);
}

export function canonicalStable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStable).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStable(obj[k])).join(',') + '}';
}

export function parseTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isInteger(n) ? n : Math.round(n * 1000);
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
