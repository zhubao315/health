# ACTIVE 隐私审计（Privacy Audit）

审计日期：2026-11-13 · 范围：`zhubao315/{running,cycling,hiking,health}` 四个公开仓库。
结论先行：**未发现任何密钥、口令或凭据泄露**；仓内的敏感内容全部是「有意公开的个人运动与健康原始数据」，其公开范围与代价在 `DATA_PUBLICATION.md` 中声明。本轮按约定**只审计，不删除、不脱敏、不重写历史**。

## 1. 方法

1. 全历史路径筛查：`git log --all --name-only` 去重后匹配 `*.env *.pem *.key *password* *secret* *token* *.fit *.gpx *.tcx *.db FIT_OUT GPX_OUT TCX_OUT .ssh cookie session`。
2. 内容扫描：每仓最近 400 次提交 `git grep` 已知密钥形态（`ghp_…`、`github_pat_…`、`COROS_PASSWORD="…"`、`password="…"`、`api_key="…"`）。
3. 当前 HEAD 树与工作树扫描（含源码、面板、脚本）。
4. 工作流审查：四仓 workflow 的 `secrets.*` 引用清单——凭据只经 Secrets 注入，无硬编码、无回显。

## 2. 发现

### A. 密钥类：零泄露

- 唯一模式命中：`health/README.md` 的 `export COROS_PASSWORD="..."`——文档占位符，非真实值。
- `run_page/get_garmin_secret.py` 为历史取密辅助脚本（文件名含 secret），不含任何凭据。
- 真实凭据仅存在于 GitHub Actions Secrets（`COROS_ACCOUNT`/`COROS_PASSWORD`；本轮新增 `ACTIVE_STATE_TOKEN`）。

### B. 有意公开的原始数据（HEAD 与 Git 历史中均存在）

| 仓库 | 文件 | 规模（审计时） | 内容 |
|---|---|---|---|
| running | `FIT_OUT/*.fit`（41 个） | 8.8 MB | 完整 GPS 轨迹、起止时间、COROS 活动/设备标识 |
| cycling | `run_page/data.db` | 25 MB | 全部骑行元数据 + GPS |
| hiking | `run_page/data.db` | 3.1 MB | 全部徒步元数据 + GPS |
| health | `data/health.db`（+CSV/JSON） | 1.0 MB | 睡眠、HRV、静息/日均心率、压力、步数、训练负荷；体重与体成分历史（好轻体脂秤） |

以上均在 HEAD 与 Git 历史中，属**有意公开**（理由与边界见 `DATA_PUBLICATION.md`）。

### 风险清单（知情接受；处置为可选项，本轮不实施）

1. GPS 精确坐标：常驻起终点可能推断家庭/常用地点。可选缓解：仅对公开展示副本（`activities.json`/地图数据）做起终点 N 公里模糊，原始 FIT/DB 不动。
2. FIT 内设备/活动标识与展示用 ID 同源（利于追溯，接受）。
3. 健康时序公开且**不可撤回**（Git 历史在，删除≠消失）：公开意图已声明。
4. 作息规律（睡眠窗口、常跑时段）可被推断：低敏感，接受。

## 审计未做（边界声明）

- 未逐字节扫描全部历史 blob 内容（成本约束）：以「全历史路径清单 + 近 400 次提交内容扫描 + HEAD 全树」覆盖，密钥形态未见命中。
- 未审计 GitHub 运行日志内容（日志含活动标题/ID，不含口令；工作流均不回显 secrets）。
- 未评估第三方（GitHub Pages/Actions）侧的数据留存政策差异。

## 建议（未来轮次拍板，不改变本轮结论）

- 若决定路线遮罩：在构建期对 JSON 输出做起终点模糊，原始文件保持原样。
- `data.db` 迁 Git LFS 只解决体积，不改变公开性。
- 轮换：COROS 口令年检；`ACTIVE_STATE_TOKEN` 一旦泄露立即替换三个运动站 secret 与 active-watch PAT。
