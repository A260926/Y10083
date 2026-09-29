import type { AnchorSnapshot, EventWithReceipts, TimelineItem, TimelineItemReceipt } from './types.js';
import { ALGO_VERSION, correctTimestamp } from './clock.js';

export interface SourceInfo {
  id: string;
  name: string;
}

export function buildTimeline(
  events: EventWithReceipts[],
  sources: SourceInfo[],
  anchors: AnchorSnapshot[],
): TimelineItem[] {
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));

  const items: TimelineItem[] = events.map((ev) => {
    const receiptViews: TimelineItemReceipt[] = ev.receipts.map((r) => {
      const est = correctTimestamp(r.source_id, r.observed_at_ms, anchors);
      return {
        receipt_id: r.id,
        source_id: r.source_id,
        source_name: sourceName.get(r.source_id) ?? r.source_id,
        received_at_ms: r.received_at_ms,
        observed_at_ms: r.observed_at_ms,
        corr_ms: est.corr_ms,
        half_width_ms: est.half_width_ms,
        basis: est.basis,
      };
    });

    const corrReceipts = receiptViews.filter(
      (v): v is TimelineItemReceipt & { corr_ms: number; half_width_ms: number } =>
        v.corr_ms !== null && v.half_width_ms !== null,
    );

    let corrMs: number | null = null;
    let lo: number | null = null;
    let hi: number | null = null;
    let hw: number | null = null;
    const unanchored = corrReceipts.length === 0;

    if (corrReceipts.length > 0) {
      lo = Math.min(...corrReceipts.map((v) => v.corr_ms - v.half_width_ms));
      hi = Math.max(...corrReceipts.map((v) => v.corr_ms + v.half_width_ms));
      corrMs = Math.round((lo + hi) / 2);
      hw = Math.max(corrMs - lo, hi - corrMs);
    }

    const obs = ev.receipts
      .map((r) => r.observed_at_ms)
      .filter((v): v is number => v !== null);
    const rawMin = obs.length ? Math.min(...obs) : null;
    const rawMax = obs.length ? Math.max(...obs) : null;

    return {
      event_id: ev.id,
      summary: ev.summary,
      conflict: ev.conflict === 1,
      corr_ms: corrMs,
      half_width_ms: hw,
      lo_ms: lo,
      hi_ms: hi,
      unanchored,
      raw_min_ms: rawMin,
      raw_max_ms: rawMax,
      receipts: receiptViews,
      tie_group: null,
      tie_size: 1,
    };
  });

  return orderItems(items);
}

export function orderItems(items: TimelineItem[]): TimelineItem[] {
  const anchored = items.filter((i) => !i.unanchored);
  const unanchored = items.filter((i) => i.unanchored);

  anchored.sort((a, b) => {
    if (a.lo_ms !== b.lo_ms) return (a.lo_ms ?? 0) - (b.lo_ms ?? 0);
    if (a.hi_ms !== b.hi_ms) return (a.hi_ms ?? 0) - (b.hi_ms ?? 0);
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  unanchored.sort((a, b) => {
    const ra = a.raw_min_ms ?? Number.POSITIVE_INFINITY;
    const rb = b.raw_min_ms ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });

  const groups: TimelineItem[][] = [];
  for (const item of anchored) {
    const last = groups[groups.length - 1];
    if (last && (last[last.length - 1].hi_ms as number) >= (item.lo_ms as number)) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }

  const ordered: TimelineItem[] = [];
  groups.forEach((group, idx) => {
    const groupNo = idx + 1;
    for (const item of group) {
      ordered.push({
        ...item,
        tie_group: group.length > 1 ? groupNo : null,
        tie_size: group.length,
      });
    }
  });
  for (const item of unanchored) ordered.push(item);
  return ordered;
}

export function algoInUse(): string {
  return ALGO_VERSION;
}
