# 事件证据拼图（Event Evidence Puzzle）

把多个服务的日志、trace 片段与人工记录放进**同一条可解释时间线**：所有自动校时与因果关联都附带依据、算法版本与锚点集合，可审计、可重放。

## 安装与演示

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5213
```

打开 http://127.0.0.1:5213 ，页面标题为「事件证据拼图」，首次启动自动载入预置示例，可在下拉框中切换 **修订 R1（跨午夜）** 与 **修订 R2（时钟跳变）** 两个时间线；切换修订时原始事件摘要不变。

## 数据模型（SQLite，`data/evidence.sqlite`，运行时自动创建）

- `source` / `event` / `receipt`：原始字节（`raw_text` + `raw_sha256`）、来源、接收时间、行号、批次永久保留。
- `event.content_sha` 为内容摘要指纹；同 `event_id` 同来源同字节再次导入是**重复收据**（`UNIQUE` 合并），同 `event_id` 不同内容置 `conflict=1` 并写入 `event_conflict`，冲突双方收据都不丢。
- `quarantine`：解析失败的原始行进隔离区（保留原文、sha、行号、原因），坏行不影响同批其他行。
- `anchor`：每来源若干「来源观测时间 → 可信真实时间」锚点。
- `revision` + `revision_event`：修订固化标签、算法版本（`piecewise-linear-v1`）、**锚点集合快照与签名**、基于的旧修订，以及当时每个事件的校正结果/并列组/序号；旧修订永不修改。
- `hypothesis` + `hypothesis_member`：只保存标题、依据、置信说明与成员；不写回事件，一个事件可属于多条互相竞争的假设。

## 可解释的分段校时（`piecewise-linear-v1`）

- 单锚点：常数偏移，半宽 500ms。
- 双锚点之间：按段线性插值（可表达一次时钟跳变两侧的不同偏移/斜率）。
- 锚点范围之外：用首/末段外推，半宽随外推距离增大；每张收据的 `basis` 字段记录所用锚点、t 值与外推距离。
- 来源无锚点或缺少观测时间：不校时，事件在时间线尾部单独标注「未校时」。

## 排序的稳定规则

按不确定区间下界排序；只要前一事件上界 ≥ 后一事件下界即归入同一**并列组**（传递重叠同组），组内不暗示先后；完全同区间时以 `event_id` 做确定性平局。界面中并列事件有紫色标记与说明 tooltip。

## 并发与版本冲突

`POST /api/revisions` 必须带 `expected_previous_revision_id`（即当前最新修订号）。过期提交返回 `409 REVISION_CONFLICT`，响应含 `anchor_diff`：双方每个锚点的真实时间之差、备注与增删。

## 导出 / 重放

`GET /api/export` 产出单文件 JSON：原始事件摘要、每修订参数（锚点、签名、算法）、假设，以及可验证 manifest：

- 各数据段 `sha256(canonical JSON)`；
- 每修订的排序签名 = `sha256(锚点签名 + 算法 + 排序结果)`；
- `total_manifest_sha256` 覆盖 data + manifest。

`POST /api/replay` 先整体验证（任一不符即拒绝且不改库），再清空并按原主键重建，最后**用当前代码重新计算每个修订的排序并逐字段比对**；同时逐条核对 `raw_text → raw_sha` 的来源链。重放后排序与来源链一致。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 来源/锚点/修订/假设/隔离计数 |
| GET | `/api/events` | 事件 + 全部来源收据（含原始字节） |
| GET | `/api/quarantine` | 隔离区明细 |
| GET | `/api/timeline/:id` | 指定修订的时间线（原始/校正时间、区间、并列、依据） |
| POST | `/api/import` | `{ndjson, source?}` 批量导入 |
| POST | `/api/events` | `{event}` 粘贴单条 |
| POST | `/api/anchors` | 新增时间锚点（不影响旧修订） |
| POST | `/api/revisions` | 从锚点快照生成新修订（乐观锁，409 + 锚点差异） |
| POST | `/api/hypotheses` | 保存因果链假设 |
| GET | `/api/export` / POST | `/api/replay` | 导出 / 校验重放 |
| POST | `/api/reset`、`/api/seed` | 清空 / 重新生成预置示例 |

## 预置示例

- 跨午夜：`pay-api` 在 23:59→00:00 的事件被 -40s 锚点拉回前一日；
- 时钟跳变：`gateway` 在 NTP 回拨前后各一个锚点，分段校正使 `g2/g3` 校正后区间重叠并列；
- 冲突 ID：`e2` 两个来源内容金额不同（100 vs 200），事件标红但两份收据并存；
- 两条坏行（非法 JSON、缺 event_id）进入隔离区；
- 两个竞争假设 H1/H2 都包含 `e2`。

## 测试

`npm test -- --run`（Vitest，20 个用例）覆盖：坏行隔离、重复收据合并、内容冲突、分段校时、区间并列/平局、未校时置后、修订不可变、409 锚点差异、导出重放与篡改拒绝。
