import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Hex } from '../shared/digest.js';
import { anchorViewFrom } from '../shared/time.js';
import { importBatch, importOne } from './store.js';
import { addHypothesis } from './hypotheses.js';
import { ALGO_VERSION, type AnchorInput } from '../shared/types.js';

const ORDER_BATCH = [
  '{"id":"INC-1","type":"deploy","observedAt":"23:05","detail":{"service":"svc-order","action":"v2.14.0 rollout"}}',
  '{"id":"INC-2","type":"alert","observedAt":"23:58:30","detail":{"service":"svc-order","message":"latency p99 rising"}}',
  '{"id":"INC-3","type":"checkout","observedAt":"00:00:40","detail":{"service":"svc-order","status":"ok","amount":199}}',
  '{"id":"INC-8","type":"db-timeout","observedAt":"00:02:10","detail":{"service":"svc-order","poolWaitMs":8120}}',
  '{"id":"INC-5","type":"metric","observedAt":"00:04","detail":{"service":"svc-order","metric":"errorRate","value":0.07}}',
  '{"id":"INC-BAD-1","observedAt":"23:50","detail": BROKEN}',
  '{"id":"INC-BAD-2","observedAt":"not-a-time","detail":{"why":"bad timestamp"}}'
].join('\n');

const PAY_DUP = '{"id":"INC-5","type":"metric","observedAt":"00:04","detail":{"service":"svc-order","metric":"errorRate","value":0.07}}';

const PAY_BATCH = [
  '{"id":"INC-9","type":"payment","observedAt":"2026-03-13T15:40:05Z","detail":{"gateway":"acquirer-a","event":"gateway degraded"}}',
  '{"id":"INC-4","type":"payment","observedAt":"2026-03-13T16:01:10Z","detail":{"gateway":"acquirer-a","event":"charge retried"}}',
  '{"id":"INC-3","type":"checkout","observedAt":"2026-03-13T16:00:50Z","detail":{"service":"svc-pay","status":"mismatch","amount":199}}',
  PAY_DUP,
  '{oops this is not json at all'
].join('\n');

const REV1_ANCHORS: AnchorInput[] = [
  { anchorId: 'anc-o1', source: 'svc-order', observedAt: '23:00', referenceAt: '2026-03-13T15:00:30Z', note: 'NTP 同步后基线：order 钟慢 30s' },
  { anchorId: 'anc-o3', source: 'svc-order', observedAt: '00:10', referenceAt: '2026-03-13T16:09:00Z', note: '对时锚点：order 钟相对真实时间偏移；初版未分段' },
  { anchorId: 'anc-p1', source: 'svc-pay', observedAt: '2026-03-13T15:51:10Z', referenceAt: '2026-03-13T15:51:40Z', note: 'pay 钟慢 30s' },
  { anchorId: 'anc-m1', source: 'svc-ops', observedAt: '23:40', referenceAt: '2026-03-13T15:39:00Z', note: '人工记录本钟快 1 分钟' }
];

const REV2_ANCHORS: AnchorInput[] = [
  ...REV1_ANCHORS,
  { anchorId: 'anc-o2', source: 'svc-order', observedAt: '00:00', referenceAt: '2026-03-13T15:59:00Z', note: '定位到 00:00 时钟回拨跳变点' },
  { anchorId: 'anc-p2', source: 'svc-pay', observedAt: '2026-03-13T15:30:00Z', referenceAt: '2026-03-13T15:30:30Z', note: '补采 pay 早期锚点' }
];

async function insertRevision(
  db: DatabaseSync,
  revisionId: string,
  parentId: string | null,
  anchors: AnchorInput[],
  createdAt: string,
  note: string
) {
  const normalized = anchors.map((a, index) => ({
    anchorId: a.anchorId?.trim() || `anc_${index + 1}`,
    source: a.source,
    observedAt: a.observedAt,
    referenceAt: new Date(Date.parse(a.referenceAt)).toISOString(),
    note: a.note ?? ''
  }));
  const views = normalized.map(anchorViewFrom);
  const anchorDigest = await sha256Hex(canonicalJson([...views].sort((a, b) => (a.anchorId < b.anchorId ? -1 : 1))));
  db.prepare(
    `INSERT INTO revisions (revision_id, parent_id, based_on, anchor_digest, anchors_json, algo_version, created_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(revisionId, parentId, parentId, anchorDigest, canonicalJson(views), ALGO_VERSION, createdAt, note);
}

export async function installSeed(db: DatabaseSync): Promise<void> {
  await importBatch(db, 'svc-order', ORDER_BATCH, '2026-03-13T16:15:00Z');
  await importBatch(db, 'svc-pay', PAY_BATCH, '2026-03-13T16:16:00Z');
  await importOne(db, 'svc-ops', '{"id":"INC-7","type":"manual-note","observedAt":"23:45","detail":{"author":"sre-oncall","note":"order 页面疑似卡住"}}', '2026-03-13T16:17:00Z', null);
  await importOne(db, 'svc-ops', '{"id":"INC-10","type":"manual-note","observedAt":"00:15","detail":{"author":"sre-oncall","note":"支付恢复，准备复盘"}}', '2026-03-13T16:18:00Z', null);

  await insertRevision(db, 'rev-1', null, REV1_ANCHORS, '2026-03-13T16:20:00Z', '初始修订：跨午夜两端各一个锚点，跳变尚未分段');
  await insertRevision(db, 'rev-2', 'rev-1', REV2_ANCHORS, '2026-03-13T16:30:00Z', '补入跳变点锚点 anc-o2，分段拟合时钟偏移');

  addHypothesis(db, {
    hypothesisId: 'hyp-deploy-chain',
    title: '部署 → 数据库超时因果链',
    evidence: '依据：INC-1 部署后 INC-2 延迟告警，随后 INC-8 连接池超时；修订 rev-2 中 INC-8 早于 INC-4 支付重试。',
    confidenceNote: '中等置信：时间相邻且服务拓扑支持，但缺少直接 trace；rev-1 中 INC-8 与 INC-4 区间重叠，先后不可判定。',
    eventKeys: ['evt_INC-1', 'evt_INC-2', 'evt_INC-8', 'evt_INC-3']
  });
  addHypothesis(db, {
    hypothesisId: 'hyp-pay-chain',
    title: '支付通道独立故障（竞争假设）',
    evidence: '依据：INC-9 显示支付通道在 15:40 已降级，INC-4 发生重试，INC-3 金额状态不一致。',
    confidenceNote: '低置信：能解释支付侧现象，但无法解释 INC-8 数据库超时；与部署链假设竞争，INC-3 同时属于两者。',
    eventKeys: ['evt_INC-9', 'evt_INC-4', 'evt_INC-3']
  });
}
