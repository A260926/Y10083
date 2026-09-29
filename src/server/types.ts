export type Confidence = 'low' | 'medium' | 'high';

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  created_at: string;
}

export interface ReceiptRow {
  id: number;
  event_id: string;
  source_id: string;
  raw_text: string;
  raw_sha: string;
  observed_at_ms: number | null;
  received_at_ms: number;
  batch_id: number | null;
  line_no: number | null;
}

export interface EventRow {
  id: string;
  content_canonical: string;
  content_sha: string;
  summary: string;
  first_receipt_id: number;
  conflict: 0 | 1;
}

export interface EventWithReceipts extends EventRow {
  receipts: ReceiptRow[];
}

export interface AnchorRow {
  id: number;
  source_id: string;
  observed_at_ms: number;
  true_at_ms: number;
  note: string;
  created_at: string;
}

export interface AnchorSnapshot {
  anchor_id?: number;
  source_id: string;
  observed_at_ms: number;
  true_at_ms: number;
  note?: string;
}

export interface RevisionRow {
  id: number;
  label: string;
  algo_version: string;
  anchors_json: string;
  anchors_signature: string;
  base_revision_id: number | null;
  created_at: string;
}

export interface TimelineItemReceipt {
  receipt_id: number;
  source_id: string;
  source_name: string;
  received_at_ms: number;
  observed_at_ms: number | null;
  corr_ms: number | null;
  half_width_ms: number | null;
  basis: string;
}

export interface TimelineItem {
  event_id: string;
  summary: string;
  conflict: boolean;
  corr_ms: number | null;
  half_width_ms: number | null;
  lo_ms: number | null;
  hi_ms: number | null;
  unanchored: boolean;
  raw_min_ms: number | null;
  raw_max_ms: number | null;
  receipts: TimelineItemReceipt[];
  tie_group: number | null;
  tie_size: number;
}

export interface HypothesisRow {
  id: number;
  title: string;
  basis: string;
  confidence: Confidence;
  created_at: string;
}

export interface QuarantineRow {
  id: number;
  batch_id: number | null;
  line_no: number | null;
  source_id: string | null;
  raw_text: string;
  raw_sha: string;
  reason: string;
  received_at_ms: number;
}
