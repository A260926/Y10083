interface TimelineRow {
  rank: number;
  eventKey: string;
  eventId: string;
  type: string;
  primarySource: string;
  sources: string[];
  conflict: boolean;
  tieKeys: string[];
  correctedDisplay: string | null;
  intervalDisplay: string | null;
  observed: { raw: string | number; kind: string; display: string };
  correction: {
    source: string | null;
    halfWidthMs: number;
    extrapolated: boolean;
    basisAnchorIds: string[];
    algoVersion: string;
  } | null;
}

interface TimelineResponse {
  revision: { revisionId: string; note: string; algoVersion: string; anchors: { anchorId: string; source: string; observedAt: string; referenceAt: string; note: string }[] } | null;
  head: string | null;
  revisions: { revisionId: string; note: string; createdAt: string }[];
  rows: TimelineRow[];
}

interface QuarantineItem {
  quarantineId: string;
  source: string;
  receivedAt: string;
  rawLine: string;
  reason: string;
  lineIndex: number | null;
}

interface Hypothesis {
  hypothesisId: string;
  title: string;
  evidence: string;
  confidenceNote: string;
  eventKeys: string[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json as T;
}

function setStatus(message: string, kind: '' | 'ok' | 'err' = '') {
  const el = $('global-status');
  el.textContent = message;
  el.className = `status ${kind}`;
  if (kind) window.setTimeout(() => {
    el.textContent = '';
    el.className = 'status';
  }, 6000);
}

function esc(value: unknown): string {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function loadTimeline(revisionId?: string) {
  const query = revisionId ? `?revision=${encodeURIComponent(revisionId)}` : '';
  const data = await api<TimelineResponse>(`/api/timeline${query}`);
  renderRevisionPicker(data, revisionId);
  renderTimeline(data);
}

function renderRevisionPicker(data: TimelineResponse, selected?: string) {
  const select = $('revision-select') as HTMLSelectElement;
  const current = selected ?? data.head ?? '';
  select.innerHTML = data.revisions
    .map((r) => `<option value="${esc(r.revisionId)}" ${r.revisionId === current ? 'selected' : ''}>${esc(r.revisionId)} — ${esc(r.note)}</option>`)
    .join('');

  const detail = $('revision-detail');
  if (data.revision) {
    detail.innerHTML =
      `<span>算法版本 <code>${esc(data.revision.algoVersion)}</code></span>` +
      `<span>锚点 ${data.revision.anchors.length} 个：${data.revision.anchors
        .map((a) => `<code>${esc(a.anchorId)}</code>`)
        .join(' ')}</span>` +
      `<span>说明：${esc(data.revision.note)}</span>`;
  }
}

function renderTimeline(data: TimelineResponse) {
  const tbody = document.querySelector('#timeline-table tbody')!;
  const tieGroups = new Map<string, number>();
  data.rows.forEach((r) => {
    if (r.tieKeys.length > 1) tieGroups.set(r.eventKey, 1);
  });
  tbody.innerHTML = data.rows
    .map((row) => {
      const tie = row.tieKeys.length > 1;
      const badges = [
        tie ? '<span class="badge badge-tie">并列</span>' : '',
        row.conflict ? '<span class="badge badge-conflict">ID 冲突</span>' : '',
        row.correction?.extrapolated ? '<span class="badge badge-ext">外推</span>' : '',
        !row.correction ? '<span class="badge badge-uncal">未校时</span>' : ''
      ].join('');
      const sources = row.sources.map((s) => `<span class="src-chip">${esc(s)}</span>`).join('');
      const basis = row.correction
        ? `<span class="basis">${esc(row.correction.source)} · 锚点 ${row.correction.basisAnchorIds.map(esc).join(', ')}</span>`
        : '<span class="basis">该来源无锚点</span>';
      return `<tr class="${tie ? 'tie' : ''}">
        <td>${row.rank}</td>
        <td><strong>${esc(row.eventId)}</strong>${badges}</td>
        <td>${esc(row.type)}</td>
        <td>${esc(row.observed.display)}</td>
        <td>${row.correctedDisplay ? esc(row.correctedDisplay) : '—'}</td>
        <td>${row.correction ? `${esc(row.intervalDisplay ?? '')} <span class="basis">${row.intervalDisplay ? `[${formatMs(row.correction!.halfWidthMs)}]` : ''}</span>` : '—'}</td>
        <td><span class="sources">${sources}</span></td>
        <td>${basis}</td>
      </tr>`;
    })
    .join('');
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function loadQuarantine() {
  const data = await api<{ quarantine: QuarantineItem[] }>('/api/quarantine');
  const el = $('quarantine-list');
  el.innerHTML = data.quarantine.length
    ? data.quarantine
        .map(
          (q) => `<div class="quarantine-item">
          <strong>${esc(q.source)}</strong> · 第 ${q.lineIndex ?? '—'} 行 · ${esc(q.receivedAt)}
          <div class="basis">${esc(q.reason)}</div>
          <pre>${esc(q.rawLine)}</pre>
        </div>`
        )
        .join('')
    : '<p class="hint">暂无隔离记录</p>';
}

async function loadHypotheses() {
  const data = await api<{ hypotheses: Hypothesis[] }>('/api/hypotheses');
  $('hypotheses-list').innerHTML = data.hypotheses
    .map(
      (h) => `<div class="hyp-card">
      <h4>${esc(h.title)}</h4>
      <p>${esc(h.evidence)}</p>
      <p class="basis">置信：${esc(h.confidenceNote)}</p>
      <p class="ev-key">${h.eventKeys.map(esc).join(' · ')}</p>
    </div>`
    )
    .join('');
}

function bind() {
  $('revision-select').addEventListener('change', (e) => {
    loadTimeline((e.target as HTMLSelectElement).value).catch((err) => setStatus(err.message, 'err'));
  });

  $('batch-btn').addEventListener('click', async () => {
    try {
      const source = ($('batch-source') as HTMLInputElement).value.trim();
      const ndjson = ($('batch-input') as HTMLTextAreaElement).value;
      const report = await api<{ accepted: unknown[]; rejected: { reason?: string }[] }>('/api/events/batch', {
        method: 'POST',
        body: JSON.stringify({ source, ndjson })
      });
      setStatus(`导入完成：接受 ${report.accepted.length} 条，隔离 ${report.rejected.length} 条`, 'ok');
      await refreshAll();
    } catch (err) {
      setStatus((err as Error).message, 'err');
    }
  });

  $('one-btn').addEventListener('click', async () => {
    try {
      const source = ($('batch-source') as HTMLInputElement).value.trim();
      const raw = ($('one-input') as HTMLTextAreaElement).value;
      const result = await api<{ ok: boolean; reason?: string }>('/api/events/one', {
        method: 'POST',
        body: JSON.stringify({ source, raw })
      });
      setStatus(result.ok ? '单条事件已接收' : `已进入隔离区：${result.reason ?? ''}`, result.ok ? 'ok' : 'err');
      await refreshAll();
    } catch (err) {
      setStatus((err as Error).message, 'err');
    }
  });

  $('hyp-btn').addEventListener('click', async () => {
    try {
      await api('/api/hypotheses', {
        method: 'POST',
        body: JSON.stringify({
          title: ($('hyp-title') as HTMLInputElement).value,
          evidence: ($('hyp-evidence') as HTMLTextAreaElement).value,
          confidenceNote: ($('hyp-confidence') as HTMLTextAreaElement).value,
          eventKeys: ($('hyp-events') as HTMLInputElement).value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        })
      });
      setStatus('假设已保存（仅保存依据，不改动事件）', 'ok');
      await loadHypotheses();
    } catch (err) {
      setStatus((err as Error).message, 'err');
    }
  });

  $('export-btn').addEventListener('click', async () => {
    const bundle = await api<unknown>('/api/export');
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'evidence-bundle.json';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('已导出含 manifest 的证据包', 'ok');
  });

  $('import-file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      const result = await api<{ report: unknown }>('/api/replay', { method: 'POST', body: JSON.stringify(bundle) });
      setStatus(`重放完成：${JSON.stringify(result.report)}`, 'ok');
      await refreshAll();
    } catch (err) {
      setStatus((err as Error).message, 'err');
    }
  });
}

async function refreshAll() {
  await Promise.all([loadTimeline(($('revision-select') as HTMLSelectElement).value || undefined), loadQuarantine()]);
}

export {};

bind();
void Promise.all([loadTimeline(), loadQuarantine(), loadHypotheses()]).catch((err: Error) => setStatus(err.message, 'err'));
