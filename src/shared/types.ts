export const ALGO_VERSION = 'piecewise-offset-v1';

export interface EventPayload {
  id: string;
  type?: string;
  observedAt: string | number;
  detail: unknown;
}

export interface CanonicalEvent {
  id: string;
  type: string;
  observedAt: string;
  detail: unknown;
}

export interface Receipt {
  source: string;
  receivedAt: string;
  rawDigest: string;
  lineIndex: number | null;
}

export interface EventRecord {
  eventKey: string;
  canonical: CanonicalEvent;
  contentDigest: string;
  primarySource: string;
  receipts: Receipt[];
  conflict: boolean;
}

export interface TimeAnchor {
  anchorId: string;
  source: string;
  observedAt: string | number;
  referenceAt: string;
  note?: string;
}

export interface AnchorInput {
  anchorId?: string;
  source: string;
  observedAt: string | number;
  referenceAt: string;
  note?: string;
}

export interface AnchorDiff {
  onlyInBase: AnchorView[];
  onlyInSubmitted: AnchorView[];
  changed: { anchorId: string; base: AnchorView; submitted: AnchorView }[];
}

export interface AnchorView {
  anchorId: string;
  source: string;
  observedAt: string;
  observedKind: 'absolute' | 'wallclock';
  referenceAt: string;
  note: string;
}

export interface Revision {
  revisionId: string;
  parentId: string | null;
  basedOn: string | null;
  anchorDigest: string;
  anchors: AnchorView[];
  algoVersion: string;
  createdAt: string;
  note: string;
}

export interface TimelineRow {
  eventKey: string;
  eventId: string;
  type: string;
  primarySource: string;
  sources: string[];
  conflict: boolean;
  observed: {
    raw: string | number;
    kind: 'absolute' | 'wallclock';
    unwrappedMs: number;
    display: string;
  };
  correction: {
    source: string | null;
    correctedMs: number;
    lowerMs: number;
    upperMs: number;
    halfWidthMs: number;
    extrapolated: boolean;
    basisAnchorIds: string[];
    algoVersion: string;
  } | null;
  detail: unknown;
  contentDigest: string;
}

export interface Hypothesis {
  hypothesisId: string;
  title: string;
  evidence: string;
  confidenceNote: string;
  eventKeys: string[];
  createdAt: string;
}

export interface QuarantineItem {
  quarantineId: string;
  source: string;
  receivedAt: string;
  rawLine: string;
  reason: string;
  lineIndex: number | null;
}

export interface ExportBundle {
  format: 'event-evidence-puzzle/v1';
  exportedAt: string;
  events: {
    eventKey: string;
    canonical: CanonicalEvent;
    contentDigest: string;
    primarySource: string;
    receipts: Receipt[];
    conflict: boolean;
  }[];
  revisions: Revision[];
  hypotheses: Hypothesis[];
  quarantine: QuarantineItem[];
  manifest: {
    bodyDigest: string;
    counts: { events: number; receipts: number; revisions: number; hypotheses: number; quarantine: number };
    anchorsPerRevision: Record<string, number>;
  };
}
