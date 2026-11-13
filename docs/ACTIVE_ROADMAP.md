# ACTIVE 路线图（Roadmap）

基线：2026-11-13 治理轮（P0）完成。
原则：70% 统一 + 30% 个性；每个数字可回溯真实记录，缺就显示「—」；不为视觉破坏统计口径；不为技术统一重写四站技术栈。

## P0 基础治理 —— ✅ 已完成（2026-11-13）

- [x] 四仓代码与架构审计（`ACTIVE_SYSTEM_AUDIT.md`）
- [x] 隐私审计（`ACTIVE_PRIVACY_AUDIT.md`）＋数据公开声明（`DATA_PUBLICATION.md`）
- [x] COROS 共享配额租约账本：三站 reserve→sync→reconcile，fail-open 降级 10
- [x] 品牌 CI：`BRAND_MANIFEST.sha256` + Brand Guard ×4 + 单一事实源 `active-watch/brand`
- [x] 每日四站巡检（active-watch，异常才开一张 issue，恢复自动关闭）
- [x] 调度文档纠偏：README ×4、health 页脚、README 机器人模板（计划时间≠完成时间）

## P1 体验统一（下一轮，工作量中小）

范围：页头/页脚/导航交互细节统一；MetricCard/ChartCard/表格/空态/加载态五态规范；`zhubao315-theme` 跨站主题零闪烁复查；390/360 断点像素级复验；图表 tooltip 统一。
验收：五断点 × 深浅色无溢出、无遮挡、无文字重叠；产出 `BRAND_CONSISTENCY_REPORT.md`。

## P2 专业能力（一站一轮，避免四仓并发改版）

1. **RUNNING Performance Lab**：个人最佳纪录中心（5K/10K/半马/全马，仅收符合规则的正式活动，无则「暂无记录」）、配速进化（同距离区间加权对比）、训练一致性、长距离占比。
2. **CYCLING 口径双视图**：标准骑行（≥3 km）/全部骑行独立统计且全站 KPI·趋势·日历·地图联动，当前口径常显；速度/距离/爬升/节律分析。
3. **HIKING Mountain & Trail Explorer**：地图为主体，路线→轨迹/剖面/3D 联动；季节·区域·年份筛选；里程碑仅用真实字段；不生成跑步配速类指标。
4. **HEALTH Intelligence**：当前状态 vs 7/28 天基线、持续变化与值得验证的关系；相关性升级 Spearman + 多重比较校正 + 最小样本量门槛；负荷比仅作探索性参考，禁医学化表述。
5. **ACTIVE Daily Timeline（跨运动）**：按日整合睡眠/HRV/负荷与三类活动，点击跳原站详情（URL 带日期+活动 ID）；距离不混加、时长聚合标注覆盖率。

## P3 工程优化

- 地图与 3D：首屏不装全历史；懒加载、按年分片、聚合渲染、场景按需；先产出 Lighthouse/LCP/INP/CLS/首屏 JS/3D 请求数**实测基线**再优化。
- 测试：配速、3 km 门槛、爬升过滤、缺失语义、日期语义、窗口、CSV/SQLite/JSON 一致性单测；Playwright 五断点 E2E。
- 仓库体积：cycling data.db（25 MB）治理评估（LFS/拆包），凡涉历史重写需单独批准。
- patrol 扩展：深链 404、Pages 构建哈希核对。

## 执行纪律

1. 每阶段交付：修改文件清单、新增/删除功能及原因、统计数据 diff、原始数据一致性证明、前后截图（含手机端）、构建日志。
2. 数据统计不得以「界面看着对」验收，须与统计引擎核对。
3. 文档中的时间一律写「计划触发 + 漂移说明」，不写理想时刻。
