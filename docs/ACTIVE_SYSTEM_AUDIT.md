# ACTIVE 四站系统审计（System Audit）

审计日期：2026-11-13 · 依据：四仓源码、工作流、线上页面实测（非 README 推断）。文中快照指标随每日同步增长，实时数以各仓 README 数据概览为准。

## 1. 整体架构

```
COROS 手表 ──▶ COROS MCP（OAuth 2.0 + PKCE；账号限 50 次 FIT 下载/日）
                     │
   ┌─────────────┬───┴──────────┬──────────────────┐
 coros_sync.yml coros_sync.yml coros_sync.yml   health_sync.yml
 running        cycling        hiking           health
 18:10 UTC      19:05 UTC      19:35 UTC 周一    20:05 UTC
 (02:10 京)     (03:05 京)     (03:35 京,周更)   (04:05 京)
   │              │              │                 │
 FIT→data.db    FIT→data.db    FIT→data.db    → health.db(SQLite)
 →activities.json（轨迹/表格）              → CSV + 压缩时间序列 + data.json
   └────── Vite/pnpm 构建 ──────┘                 │ 原生 dashboard
                  └────────── GitHub Pages ───────┘
   /running  /cycling  /hiking  /health

计划触发后 GitHub 调度器实际晚 5–7 h 执行（2026-11 观测），增量窗口自动回补；
「计划时间 ≠ 完成时间」，页面徽章展示真实完成时间。

横切设施（本轮新增）：
· zhubao315/active-watch —— 每日巡检（异常才开 issue）＋ 共享配额账本＋品牌单一事实源
· 各仓 Brand Guard —— 共享品牌资产 sha256 清单校验
```

## 2. 四站职责与模块

| 站点 | 定位 | 页面模块 | 统计引擎 |
|---|---|---|---|
| RUNNING | 跑步与耐力 | 跑步档案 / 核心指标 / 年度趋势 / 总旅程 / 活动探索 / 跑步日历 | `src/utils/runningStats.ts`（加权配速＝总移动时间÷总距离） |
| CYCLING | 骑行与远行 | 同构六模块（地理足迹强化） | `src/utils/cyclingStats.ts`（≥3 km 展示口径、时长加权速度、爬升覆盖率） |
| HIKING | 徒步与山野 | 同构六模块（地形/海拔强化） | `src/utils/hikingStats.ts`（爬升合理性过滤、最高到达海拔独立统计、缺失≠0） |
| HEALTH | 身体与恢复 | 四问速览 / 概览 / 恢复趋势 / 训练与身体成分 / 相关性 / 数据质量 | `coros_health/db.py`+`metrics.py`（SQLite→CSV→JSON 单一链路）＋`analysis/` |

技术栈：三个运动站 React + TypeScript + Vite；健康站原生 JS + Chart.js。**保持异构，不迁移**——统一的是品牌、数据契约与跳转规范。

核心文件：三运动站 `run_page/coros_mcp_sync.py`（同步）、`run_page/update_readme_stats.py`（README 数字机器人）、`src/pages/index.tsx`、`src/components/`；健康站 `coros_health/`（拉取/入库）、`scripts/`（构建/README/校验）、`dashboard/`（面板）。

## 3. 数据红线（已固化在代码，任何改动必须保持）

- 不修改原始 CSV / SQLite / FIT；缺失值不填 0；不虚构功率、踏频、热量。
- running 加权配速；cycling 展示口径（≥3 km）与原始口径分离可追溯；hiking 爬升过滤＋海拔/爬升覆盖率展示；health 睡眠/HRV 按醒来日、缺失不插值、`COALESCE(excluded, stored)` 重拉不抹历史、分表水位失败不回退。
- 跨运动汇总：`source + source_activity_id` 去重；距离**不得跨项目相加**。

## 4. 品牌一致性（本轮治理完成）

- 四仓 `brand-tokens.css` Git blob 同源（`8da12ac4…`）；favicon、字体、共享 React 组件字节一致。
- 清单化：运动站 36 项 / 健康站 24 项共享资产写入各仓 `BRAND_MANIFEST.sha256`；每仓 `brand-guard.yml` 校验清单 + 旧母品牌名残留。
- 唯一编辑路径：`zhubao315/active-watch/brand/` → `bash brand/sync.sh`（自动再生清单）→ 各仓提交复制结果。
- 巡检兜底线上部署副本（四站 favicon 字节一致 + 四仓 tokens blob 一致）。

## 5. 同步与配额（本轮治理完成）

- **共享配额租约**：三运动站同步前在 `active-watch:state/fit-quota.json` reserve（默认 10、硬顶 45、按当日剩余额度收敛），同步后 reconcile 实际用量，没用完当天归还另外两站；账本任何故障降级为保守 10，**同步绝不因记账失败而失败**。历史回填用 `workflow_dispatch` 的 `reserve_budget` 输入加大预算。
- **增量与水位**：运动站窗口起点＝最新活动−2 天；health 分表水位、失败不回退。
- 错峰：计划触发 跑步 02:10 / 骑行 03:05 / 徒步周一 03:35 / 健康 04:05（北京时间）。

## 6. 已知短板（本轮未动，排期见 ROADMAP）

- 地图/3D 首屏加载重：全历史轨迹一次性初始化、场景 JSON 未按年分片（P3，先建性能基线再优化）。
- cycling `run_page/data.db` 25 MB：仓库体积大，治理涉及历史重写，需单独决策（P3）。
- 无自动化测试与 E2E（P3）；健康站长表移动端体验（P1）。
- patrol 目前不检测深链 404（P3 加）。

## 7. 隐私

见同目录 `ACTIVE_PRIVACY_AUDIT.md`（扫描方法与结果）与 `DATA_PUBLICATION.md`（公开声明）。要点：**零密钥泄露**；原始 FIT/DB 属有意公开。

## 8. 本轮修改清单

- running / cycling / hiking：`coros_sync.yml`（配额 reserve/reconcile + `reserve_budget` 输入）、`scripts/quota_lease.py`、`BRAND_MANIFEST.sha256`、`brand-guard.yml`、`README.md`（调度/配额表述纠偏＋文档指针）、`docs/ACTIVE_*.md`。
- health：`README.md` 与 `scripts/update_readme.py`（调度表述纠偏，机器人模板同步）、`dashboard/index.html` 页脚、`BRAND_MANIFEST.sha256`、`brand-guard.yml`、`docs/ACTIVE_*.md`。
- 新仓库：`zhubao315/active-watch`（`patrol.mjs`、`state/fit-quota.json`、`brand/`、`tools/quota_lease.py`）。

## 9. 验收标准

1. 四站 HTTP 200、标题 `ACTIVE / …`、四仓 tokens blob 一致、线上 favicon 一致。
2. 四仓 Brand Guard 绿；手改任一共享资产即红。
3. patrol 手动运行绿、无误报；异常注入机制可开 issue。
4. 运动站下一次同步日志含 quota reserve/reconcile 两步且不影响同步结果。
5. README/页脚不再出现「08:00 / 每天两次 / 00:10 UTC」类过时表述。
6. 数据文件零改动：`data.json`、`data.db`、`activities.json`、`FIT_OUT` 与治理前逐字节一致（机器人例行提交除外）。
