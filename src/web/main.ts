interface State {
  sources: Array<{ id: string; name: string; kind: string }>;
  anchors: Array<{ id: number; source_id: string; observed_at_ms: number; true_at_ms: number; note: string }>;
  revisions: Array<{ id: number; label: string; algo_version: string; anchors_signature: string; base_revision_id: number | null; created_at_ms: number }>;
  hypotheses: Array<{ id: number; title: string; basis: string; confidence: string; event_ids: string[] }>;
  quarantine_count: number;
}
interface TimelineReceipt {
  receipt_id: number;
  source_id: string;
  source_name: string;
  received_at_ms: number;
  observed_at_ms: number | null;
  corr_ms: number | null;
  half_width_ms: number | null;
  basis: string;
}
interface TimelineItem {
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
  receipts: TimelineReceipt[];
  tie_group: number | null;
  tie_size: number;
}
interface TimelineResponse {
  revision: {
    id: number;
    label: string;
    algo_version: string;
    anchors_signature: string;
    anchors: any[];
    base_revision_id: number | null;
    created_at_ms: number;
  };
  items: TimelineItem[];
}
interface QuarantineRow {
  id: number;
  line_no: number | null;
  source_id: string | null;
  reason: string;
  raw_text: string;
  raw_sha: string;
  received_at_ms: number;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function fmt(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
}
function fmtRange(lo: number | null, hi: number | null): string {
  if (lo === null || hi === null) return '—';
  return `${fmt(lo)} → ${fmt(hi)}`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
async function api(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.message ?? res.statusText), { status: res.status, body });
  return body;
}
function setResult(id: string, text: string, ok = false): void {
  const el = $(id);
  el.textContent = text;
  el.className = 'result' + (ok ? ' ok' : ' err');
}
function clearResult(id: string): void {
  const el = $(id);
  el.textContent = '';
  el.className = 'result';
}

let state: State | null = null;
let currentRevisionId: number | null = null;
let eventRawText = new Map<string, string>();

async function loadState(): Promise<void> {
  state = await api('/api/state');
  renderRevisionSelect();
  renderAnchors();
  renderHypotheses();
  renderQuarantine();
  await loadEvents();
}

async function loadEvents(): Promise<void> {
  const { events } = await api('/api/events');
  eventRawText = new Map();
  for (const ev of events) {
    for (const r of ev.receipts) {
      eventRawText.set(`${ev.id}:${r.id}`, r.raw_text);
    }
  }
}

function renderRevisionSelect(): void {
  const select = $<HTMLSelectElement>('revision-select');
  const previous = currentRevisionId ?? Number(select.value);
  select.innerHTML = '';
  for (const rev of state!.revisions) {
    const opt = document.createElement('option');
    opt.value = String(rev.id);
    opt.textContent = `#${rev.id} ${rev.label}`;
    select.appendChild(opt);
  }
  const exists = state!.revisions.some((r) => r.id === previous);
  currentRevisionId = exists ? previous : state!.revisions.at(-1)?.id ?? null;
  if (currentRevisionId !== null) select.value = String(currentRevisionId);
}

function renderAnchors(): void {
  const el = $('anchors-list');
  if (state!.anchors.length === 0) {
    el.innerHTML = '<p class="hint">暂无锚点。</p>';
    return;
  }
  el.innerHTML = state!.anchors
    .map(
      (a) => `<div class="anchor-chip"><b>${escapeHtml(a.source_id)}</b> 锚点 #${a.id}<br/>
      观测 ${fmt(a.observed_at_ms)} → 真实 ${fmt(a.true_at_ms)}（偏移 ${a.true_at_ms - a.observed_at_ms} ms）<br/>
      <span class="hint">${escapeHtml(a.note || '')}</span></div>`,
    )
    .join('');
}

function renderHypotheses(): void {
  const el = $('hypotheses-list');
  if (state!.hypotheses.length === 0) {
    el.innerHTML = '<p class="hint">暂无假设。</p>';
    return;
  }
  el.innerHTML = state!.hypotheses
    .map(
      (h) => `<div class="hyp-card">
      <b>${escapeHtml(h.title)}</b> <span class="conf-${h.confidence}">[${h.confidence}]</span>
      <div class="hint">${escapeHtml(h.basis)}</div>
      <div class="members">成员：${h.event_ids.map(escapeHtml).join(', ')}</div>
    </div>`,
    )
    .join('');
}

async function renderQuarantine(): Promise<void> {
  const el = $('quarantine-list');
  const { quarantine } = await api('/api/quarantine');
  if (quarantine.length === 0) {
    el.innerHTML = '<p class="hint">隔离区为空。</p>';
    return;
  }
  el.innerHTML = (quarantine as QuarantineRow[])
    .map(
      (q) => `<div class="quarantine-row">
      <div><span class="reason">${escapeHtml(q.reason)}</span> · 批次行 ${q.line_no ?? '—'} · 接收 ${fmt(q.received_at_ms)}</div>
      <div class="hint">raw_sha256: ${q.raw_sha}</div>
      <code class="raw-json">${escapeHtml(q.raw_text)}</code>
    </div>`,
    )
    .join('');
}

async function loadTimeline(): Promise<void> {
  if (currentRevisionId === null) return;
  const data: TimelineResponse = await api(`/api/timeline/${currentRevisionId}`);
  const meta = $('revision-meta');
  meta.innerHTML = `
    <div class="meta-item">修订：<b>#${data.revision.id} ${escapeHtml(data.revision.label)}</b> · 算法版本 ${data.revision.algo_version}</div>
    <div class="meta-item">锚点集合签名：<code>${data.revision.anchors_signature}</code> · 锚点数 ${data.revision.anchors.length} · 基于修订 #${data.revision.base_revision_id ?? '无'} · 创建 ${fmt(data.revision.created_at_ms)}</div>`;
  $('conflict-banner').hidden = true;

  const body = $('timeline-body');
  body.innerHTML = data.items
    .map((item, idx) => {
      const rawTimes = item.receipts
        .map((r) => `${escapeHtml(r.source_name)}: ${fmt(r.observed_at_ms)}`)
        .join('<br/>');
      const tieBadge =
        item.tie_group !== null
          ? `<span class="badge badge-tie" title="区间与并列组内其他事件重叠，不暗示先后关系">并列组 ${item.tie_group}（${item.tie_size} 个）</span>`
          : '';
      const conflictBadge = item.conflict
        ? `<span class="badge badge-conflict" title="同一 event_id 存在不同内容的收据">内容冲突</span>`
        : '';
      const unanchoredBadge = item.unanchored
        ? `<span class="badge badge-unanchored" title="该事件的来源在本修订中没有锚点">未校时</span>`
        : '';
      const receipts = item.receipts
        .map((r) => {
          const raw = eventRawText.get(`${item.event_id}:${r.receipt_id}`) ?? '';
          return `<div class="receipt">
            <span class="src">${escapeHtml(r.source_name)}</span> · 收据 #${r.receipt_id} · 接收 ${fmt(r.received_at_ms)}
            ${r.corr_ms !== null ? `· 校正 ${fmt(r.corr_ms)} ±${r.half_width_ms}ms` : ''}
            <span class="basis">依据：${escapeHtml(r.basis)}</span>
            <code class="raw-json">${escapeHtml(raw)}</code>
          </div>`;
        })
        .join('');
      return `<tr class="${item.tie_group !== null ? 'tie-row' : ''}">
        <td>${idx + 1}</td>
        <td><b>${escapeHtml(item.event_id)}</b>${conflictBadge}${unanchoredBadge}</td>
        <td class="summary-cell">${tieBadge}${escapeHtml(item.summary)}</td>
        <td>${rawTimes || '—'}</td>
        <td>${fmt(item.corr_ms)}${item.half_width_ms !== null ? ` ±${item.half_width_ms}ms` : ''}</td>
        <td>${fmtRange(item.lo_ms, item.hi_ms)}</td>
        <td>${item.tie_group !== null ? `#${item.tie_group}` : ''}</td>
        <td><div class="receipts">${receipts}</div></td>
      </tr>`;
    })
    .join('');
}

async function refreshAll(): Promise<void> {
  await loadState();
  await loadTimeline();
}

function currentAnchorSnapshot(): any[] {
  return state!.anchors.map((a) => ({
    source_id: a.source_id,
    observed_at_ms: a.observed_at_ms,
    true_at_ms: a.true_at_ms,
    note: a.note,
  }));
}

function bind(): void {
  $<HTMLSelectElement>('revision-select').addEventListener('change', async (ev) => {
    currentRevisionId = Number((ev.target as HTMLSelectElement).value);
    await loadTimeline();
  });
  $('btn-refresh').addEventListener('click', () => refreshAll().catch(showFatal));

  $('btn-import').addEventListener('click', async () => {
    const ndjson = $<HTMLTextAreaElement>('ndjson-input').value;
    const source = $<HTMLInputElement>('import-source').value.trim();
    clearResult('import-result');
    try {
      const { result } = await api('/api/import', {
        method: 'POST',
        body: JSON.stringify({ ndjson, source: source || undefined }),
      });
      const q = result.quarantine
        .map((x: any) => `行 ${x.line_no}: ${x.reason}`)
        .join('\n');
      setResult(
        'import-result',
        `接收 ${result.accepted}，重复收据 ${result.duplicates}，隔离 ${result.rejected}${
          result.conflicts.length ? `，冲突事件：${result.conflicts.join(', ')}` : ''
        }${q ? '\n' + q : ''}`,
        result.rejected === 0,
      );
      $<HTMLTextAreaElement>('ndjson-input').value = '';
      await refreshAll();
    } catch (err) {
      setResult('import-result', (err as Error).message);
    }
  });

  $('btn-single').addEventListener('click', async () => {
    const event = $<HTMLTextAreaElement>('single-input').value;
    clearResult('single-result');
    try {
      const { result } = await api('/api/events', { method: 'POST', body: JSON.stringify({ event }) });
      setResult(
        'single-result',
        `接收 ${result.accepted}，重复 ${result.duplicates}，隔离 ${result.rejected}${
          result.conflicts.length ? `，冲突：${result.conflicts.join(', ')}` : ''
        }${result.quarantine.length ? '\n' + result.quarantine.map((q: any) => q.reason).join('\n') : ''}`,
      );
      $<HTMLTextAreaElement>('single-input').value = '';
      await refreshAll();
    } catch (err) {
      setResult('single-result', (err as Error).message);
    }
  });

  $('btn-anchor').addEventListener('click', async () => {
    clearResult('anchor-result');
    try {
      const body = {
        source_id: $<HTMLInputElement>('anchor-source').value.trim(),
        observed_at: $<HTMLInputElement>('anchor-observed').value.trim(),
        true_at: $<HTMLInputElement>('anchor-true').value.trim(),
        note: $<HTMLInputElement>('anchor-note').value.trim(),
      };
      await api('/api/anchors', { method: 'POST', body: JSON.stringify(body) });
      setResult('anchor-result', '锚点已保存（不会改动任何旧修订）。', true);
      for (const id of ['anchor-source', 'anchor-observed', 'anchor-true', 'anchor-note'])
        ($(id) as HTMLInputElement).value = '';
      await refreshAll();
    } catch (err) {
      setResult('anchor-result', (err as Error).message);
    }
  });

  $('btn-new-revision').addEventListener('click', async () => {
    clearResult('new-revision-result');
    try {
      const body = {
        label:
          $<HTMLInputElement>('new-revision-label').value.trim() ||
          `修订 @ ${new Date().toISOString()}`,
        anchors: currentAnchorSnapshot(),
        expected_previous_revision_id: currentRevisionId,
      };
      const out = await api('/api/revisions', { method: 'POST', body: JSON.stringify(body) });
      setResult('new-revision-result', `已生成修订 #${out.revision.id}，旧修订原样保留。`, true);
      $<HTMLInputElement>('new-revision-label').value = '';
      currentRevisionId = out.revision.id;
      await refreshAll();
    } catch (err: any) {
      if (err.status === 409 && err.body?.error === 'REVISION_CONFLICT') {
        const banner = $('conflict-banner');
        banner.hidden = false;
        const diff = (err.body.anchor_diff as any[])
          .map(
            (d) =>
              `${d.source_id}@观测${fmt(d.observed_at_ms)}：你的真实时间 ${
                d.requested_true_at_ms !== null ? fmt(d.requested_true_at_ms) : '（无）'
              }，最新修订 ${d.latest_true_at_ms !== null ? fmt(d.latest_true_at_ms) : '（无）'}${
                d.true_delta_ms !== null ? `，差 ${d.true_delta_ms}ms` : ''
              }`,
          )
          .join('<br/>');
        banner.innerHTML = `<b>版本冲突保护：</b>${escapeHtml(err.body.message)}<br/>双方锚点差异：<br/>${diff}`;
        setResult('new-revision-result', `409：${err.body.message}`);
        await refreshAll();
      } else {
        setResult('new-revision-result', (err as Error).message);
      }
    }
  });

  $('btn-hyp').addEventListener('click', async () => {
    clearResult('hyp-result');
    try {
      const eventIds = $<HTMLInputElement>('hyp-events')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const body = {
        title: $<HTMLInputElement>('hyp-title').value.trim(),
        basis: $<HTMLTextAreaElement>('hyp-basis').value.trim(),
        confidence: $<HTMLSelectElement>('hyp-confidence').value,
        event_ids: eventIds,
      };
      await api('/api/hypotheses', { method: 'POST', body: JSON.stringify(body) });
      setResult('hyp-result', '假设已保存，不影响任何原事件与修订。', true);
      for (const id of ['hyp-title', 'hyp-basis', 'hyp-events']) ($(id) as HTMLInputElement).value = '';
      await refreshAll();
    } catch (err) {
      setResult('hyp-result', (err as Error).message);
    }
  });

  $('btn-export').addEventListener('click', async () => {
    const bundle = await api('/api/export');
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `evidence-export-rev${currentRevisionId ?? 'all'}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $<HTMLInputElement>('replay-file').addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const result = await api('/api/replay', { method: 'POST', body: JSON.stringify(bundle) });
      const allMatch = result.result.verified.sort_signatures.every((s: any) => s.match);
      alert(
        `重放完成：${JSON.stringify(result.result.imported)}\n排序签名全部一致：${allMatch}\n来源链 raw_sha 匹配：${result.result.verified.source_chain.matched}/${result.result.verified.source_chain.receipt_count}`,
      );
      currentRevisionId = null;
      await refreshAll();
    } catch (err: any) {
      alert('重放被拒绝（manifest 校验失败，未改动当前数据）：\n' + (err.body?.message ?? err.message));
    }
    input.value = '';
  });

  $('btn-reseed').addEventListener('click', async () => {
    await api('/api/reset', { method: 'POST' });
    await api('/api/seed', { method: 'POST' });
    currentRevisionId = null;
    await refreshAll();
  });
}

function showFatal(err: unknown): void {
  // eslint-disable-next-line no-alert
  alert((err as Error).message);
}

bind();
refreshAll().catch(showFatal);
