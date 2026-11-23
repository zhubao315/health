# ACTIVE — 品牌视觉系统

**母品牌：** ACTIVE · 朱宝 · 运动与健康数字档案
**英文定位：** PERSONAL HEALTH & ACTIVE LIFE
**品牌口号：** 用数据记录每一次前进。
**理念：** MOVE · MEASURE · EXPLORE
**气质：** PRECISION · ENERGY · DISCIPLINE · FREEDOM
**适用范围：** HEALTH / RUNNING / CYCLING / HIKING 四个站点 + ACTIVE WATCH 运营中枢
**规范版本：** 3.0（2026-11-18）——启用 **PRECISION MOTION**「A」形母品牌标志（蓝→青渐变），统一字标与四站图标；保留 2.0 已确定的正式色板、字体、网格与 70/30 结构。

这份文件是五个仓库共同遵守的源文件。`brand-tokens.css` 与 `assets/` 下的矢量资源在四个站点仓库中保持逐字节一致，改动必须先改这里，再同步到各仓库（`./sync.sh`）。品牌验收断言见 `brand/brand-contract.mjs`：**ACTIVE 是唯一正确字标，ZB ACTIVE 必须不存在**。

---

## 1. 品牌结构

```
ACTIVE                         MASTER BRAND
MOVE · MEASURE · EXPLORE
朱宝 · 运动与健康数字档案

├── HEALTH     健康 · 恢复 · 身体状态      VITAL DATA      #38BDF8
├── RUNNING    跑步 · 速度 · 耐力          ENERGY IN MOTION #D9F36A
├── CYCLING    骑行 · 功率 · 远行          POWER & DISTANCE #FBBF24
└── HIKING     徒步 · 山野 · 探索          BEYOND THE TRAIL #34D399

ACTIVE WATCH                   OPERATIONS CONTROL CENTER
四站巡检 · 数据同步 · 品牌资产 · 自动化管理
```

| 层 | 内容 | 出现位置 |
|---|---|---|
| 母品牌 | **A 形渐变徽记** + ACTIVE 字标 + 副标 | 顶部品牌区、页脚、Hero 眉标、社交预览图、Favicon |
| 子品牌 | HEALTH / RUNNING / CYCLING / HIKING 线性图标 + 中文名 | 导航项、底部导航、页面眉标 |
| 中枢 | ACTIVE WATCH 四节点监控图形 | active-watch 运营文档与状态页 |

导航顺序固定为：**跑步 → 骑行 → 徒步 → 健康**。顶部导航**不含 GitHub 或任何外部开发入口**，只保留四站导航与主题切换；GitHub 源码入口仅保留在页脚。手机底栏保持四项，顺序与顶部一致。

原则是 **70% 统一 + 30% 运动专属**：统一母品牌图形、字标、深色底座、字体、网格与交互；差异只体现在子品牌图标、强调色和领域文案。四个站点的数据口径与算法不属于品牌层，永不因视觉改动而变。

## 2. 母品牌标志（PRECISION MOTION）

### 2.1 核心图形

现行标志为 **A 形轨迹徽记**：一条上升腿（青蓝 `#38BDF8 → #2563EB`）、一条下降腿（`#38BDF8 → #1D4ED8`）、一道运动弧线（`#22D3EE → #38BDF8`），合起来既是字母 A，也是「上升—测量—探索」的运动轨迹。

- 唯一母图形文件：`assets/active-mark.png`（品牌板白底卡片切图，白底转透明）；深蓝瓦片版为 `assets/active-mark-tile.png`。
- 旧版 Z 形轨迹徽记 `zhubao-*.png` 作为历史资产保留随包分发，**不再用于四站界面**。
- 手绘 SVG 母标（`active-mark.svg` 等）已退役，仅 favicon.svg 作为切片瓦片的 SVG 包装保留。
- 禁止把母图形替换为字母 A 的标准字形、跑步人物、心电图、GitHub 头像或任何第三方标志。
- 图形为装饰元素（`alt=""`、`aria-hidden="true"`），可访问名称由外层品牌链接的 `aria-label="ACTIVE"` 承担。
- 悬停动效：`.brand:hover .brand-mark { transform: rotate(-3deg) scale(1.04); }`，缓动 `--active-ease-out`，0.35s；`prefers-reduced-motion` 下全局关闭。

### 2.2 组合版本

**所有 logo / icon 都是真 SVG 矢量**：从 `assets/ACTIVE_Brand_Identity_Board.png` 识别轮廓后用 Bézier 路径 + 原生 `linearGradient` 重建（`ACTIVE-BRAND-VECTOR/`），不嵌入位图、不放大 PNG。边缘在黑/白/深蓝/透明下均干净，可无限缩放。（早期 PNG 切片版 `slice-board.py` 已退役保留作参考。）

| 文件 | 用途 |
|---|---|
| `assets/active-mark.svg` | 主徽记矢量（三段 Path + 渐变），站点头部/页脚/Hero |
| `assets/active-mark-mono.svg` / `active-logo-white.svg` | 单色 / 深底白字版本 |
| `assets/active-logo.svg` / `active-logo-stacked.svg` / `active-wordmark.svg` | 横向 / 纵向 / 极简字标 |
| `assets/icons/health.svg` · `running.svg` · `cycling.svg` · `hiking.svg` | 四枚子品牌矢量图标 |
| `assets/watch-mark.svg` | ACTIVE WATCH 四节点中枢矢量 |
| `assets/favicon.svg` | Favicon 矢量母版（Midnight 圆角瓦片 + A 矢量） |
| `favicon-16/32/64.png` · `apple-touch-icon.png` · `icon-192/512.png` | 由 favicon.svg 矢量栅格化，四站字节一致 |
| `ACTIVE-BRAND-VECTOR/png/*` | 1024/2048/4096 透明导出与深/浅底导出 |

字标规格：**Manrope Variable ExtraBold 800**，字距 **2.2px**；英文副标 **Fira Code Medium 500**，字距 **2.1px**；中文辅助名「朱宝 · 运动与健康数字档案」。矢量源在 `ACTIVE-BRAND-VECTOR/`，重建说明见 `BRAND_VECTOR_GUIDE.md`，验证图见 `ACTIVE-BRAND-VECTOR/validation/`。

### 2.3 使用规则

- 图形最小 16px；顶部导航 28px，页脚 30px，首屏 40px；四周留白不小于图形高度的 1/2。
- 深底用渐变版；浅底可继续使用渐变版，单色版仅用于明确需要继承文字色的场景。
- 个人 GitHub 头像不作为任何站点的品牌标识。
- 主站个人字标（ZHUBAO）与产品字标（ACTIVE）不混用。

## 3. 子品牌图标

统一 24×24 画布、2px 描边、圆角端点与折角、线性风格，不混用大面积填充、写实插画或阴影；默认继承文字色，仅当前页/激活态使用本站强调色。

| 子品牌 | 图形 | 关键词 | 禁用 |
|---|---|---|---|
| HEALTH | 心形 + 生命脉搏波 | 生命数据、恢复、平衡 | 医疗十字架、医院/器械意象 |
| RUNNING | 几何化跑者轮廓（头/摆臂/跨步）+ 速度线 | 速度、方向、耐力 | 卡通/写实人体、鞋剪影、肌肉细节 |
| CYCLING | 双轮 + 三角车架 + 车把 + 传动节点 | 机械、功率、远行 | 摩托/汽车、写实细节 |
| HIKING | 双峰山形 + 登顶路径 | 地形、自然、探索 | 风景画、旅游插画 |

图标须在 16 / 24 / 32 / 48 / 64px 下保持可识别；矢量源在 `assets/icons/`，组件源在 `sp-src/components/SportIcon.tsx`。

**当前版本：ZB ACTIVE Navigation Icon 1.1（Figurative Sport Glyph）。** 四枚图标为统一设计语言的**具象几何**手工 SVG（心形+脉搏 / 跑者+速度线 / 双轮单车 / 双峰山形+路径），非位图描摹、非 Lucide/Emoji、非卡通或火柴人；24×24 网格、2–2.6px 圆角描边、每枚一个品牌色 + 辅助色、透明底、视觉重量一致。完整资产（base / mono / active）在 `ACTIVE-BRAND-VECTOR/sub-brands/`，规范见 `NAV_ICONS_GUIDE.md`。

## 4. ACTIVE WATCH 运营中枢

ACTIVE WATCH 是品牌的技术支撑系统，**不是第五个子品牌**。标识：四节点（四站）+ 中央控制节点，精准连接线，运行成功状态使用 `#34D399`，结构线使用 `#94A3B8`，底色为 Deep Navy，文字为 Paper White。不发明第五种强调色。气质：ENGINEERING · MONITORING · RELIABILITY。图形文件：`assets/watch-mark.png`（品牌板 ACTIVE WATCH 卡片切图，深蓝底转透明）。

## 5. 色彩（源自主站实测，不重新发明）

主站 tokens 提取自 `zhubao315.github.io/_astro/BaseLayout.CQMzMhmP.css`。深色为品牌默认环境，浅色是同一系统在纸面上的读法；不为任何站点重新设计母品牌底色，不用随机渐变取代正式色板，不用荧光色大面积填充。

### 5.1 母品牌色板

| 色彩角色 | HEX | 用途 |
|---|---|---|
| Midnight Canvas | `#07111F` | 主背景 / Favicon 瓦片 |
| Deep Navy | `#0B1D33` | 深色品牌空间 / WATCH 底 |
| Active Surface | `#102A43` | 卡片背景 |
| Raised Navy | `#13263D` | 浮层背景 |
| Surface Hover | `#16324E` | 悬浮态 |
| Paper White | `#F7FAFF` | 主文字 / 浅色背景 |
| Soft Slate | `#CBD5E1` | 次级文字 |
| Muted Steel | `#94A3B8` | 辅助文字 / 结构线 |
| Muted Dark | `#64748B` | 更弱文字 |
| Electric Blue | `#2563EB` | 链接和交互 / A 形徽记蓝 |
| Link Blue Dark | `#1D4ED8` | 链接 hover |
| Success / Warning / Danger | `#34D399` / `#F59E0B` / `#F43F5E` | 状态语义 |

浅色主题：Light Canvas `#F7FAFF` · White Surface `#FFFFFF` · Light Surface 2 `#EEF2F7` · Light Surface 3 `#D9E1EC` · Ink `#101828` · Secondary Ink `#38495B` · Muted Ink `#667085`。

### 5.2 站点强调色（保持正式配置）

| 站点 | Primary | Secondary | 来源 |
|---|---|---|---|
| HEALTH | `#38BDF8` | `#0EA5E9` | 主站 `--build` |
| RUNNING | `#D9F36A` | `#A3B82F` | 业主决定（与主站绿区分） |
| CYCLING | `#FBBF24` | `#F59E0B` | 主站 `--think` |
| HIKING | `#34D399` | `#10B981` | 主站 `--measure` |

注意：跑步荧光青柠与徒步翡翠绿必须区分；健康蓝不能被其他站点强调色覆盖。

### 5.3 健康指标语义色（不可替换）

指标色与站点主题色解耦：睡眠 `#6366F1` · HRV `#10B981` · 静息心率 `#F43F5E` · 压力 `#F59E0B` · 训练负荷 `#38BDF8`。换 Logo 不改变任何指标的业务含义与颜色定义。

### 5.4 对比度（AA）

`#F7FAFF`/`#07111F` ≈ 17:1 · `#94A3B8`/`#07111F` ≈ 7.0:1 · `#34D399`/`#07111F` ≈ 8.6:1 · `#D9F36A`/`#07111F` ≈ 13.4:1 · 浅色强调对 `#F7FAFF` ≥ 6.5:1。

## 6. 字体与节奏

| 元素 | 规格 |
|---|---|
| 阅读字体 | **Inter Variable**（自托管 `/fonts/`，与主站一致） |
| 展示/字标 | **Manrope Variable ExtraBold 800**，字距 2.2px |
| 英文副标 | **Fira Code Medium 500**，字距 2.1px |
| 中文 | 系统 CJK 栈（Noto Sans CJK SC / PingFang SC…） |
| 数字 / 时间 / 距离 / 配速 / 表格 | Fira Code，`tabular-nums` |
| 页面主标题 | 32–44px（`clamp`） |
| 模块标题 | 20–24px |
| 正文 | 15px / 1.6 |
| 小型数据标注 | 11–12px，字距 0.1em，大写 |
| 卡片圆角 | 12px · 控件 8px |
| 间距 | 4px 倍数 |
| 动效缓动 | `cubic-bezier(.22,.72,.2,1)` / `cubic-bezier(.16,1,.3,1)` |

## 7. 布局骨架与组件

内容宽度 `--active-shell: 1440px`；留白 `clamp(1rem,3vw,2rem)`；页头 64px（移动 56px）吸顶；页脚三段（品牌锁定 / 四站 + GitHub / 数据来源）；手机底栏 60px + `env(safe-area-inset-bottom)`；断点 1440/1024/768/390/360。

共享组件：`BrandMark` · `BrandNav` · `SportIcon` · Header · Footer · `SiteHero`/PageIntro · `SectionHeader` · `MetricCard` · ChartCard · MapCard · ActivityCard · DataTable · EmptyState / LoadingState / ErrorState（中文文案 + 重试 + `aria-live`）· DataFreshness。

## 8. 主题

深色为默认；浅色为同一套设计在纸面上的读法。四站共用 `localStorage` 键 `zhubao315-theme`。站点强调色由各站 `site-metadata.ts`（健康站为 CSS 变量）注入 `--accent-brand` / `--accent-2-brand`。

## 9. Favicon 与应用展示

四站使用**同一份** `favicon-32.png` / `favicon-64.png` / `apple-touch-icon.png` / `icon-192.png` / `icon-512.png`（由共享 `favicon.svg` 生成），线上字节一致由每日巡检校验。社交分享卡 `og-<site>.png` 使用本站强调色点缀，但主视觉统一为 A 形徽记 + ACTIVE 字标。展示场景：深色/浅色导航栏、移动顶栏、四站统一导航、Hero、数据报告封面、Favicon、社交卡、ACTIVE WATCH 状态页、品牌统一展示板。

## 10. 禁止事项

1. 不修改历史数据、同步逻辑、原始数据文件与统计口径。
2. 不用站点主题色覆盖健康指标语义色。
3. 不在视觉改造中替换真实指标为演示数字。
4. 不删除地图、GPS 轨迹、3D 地形、日历、筛选与深度链接。
5. 不在组件里硬编码颜色，只用 token。
6. 不用 GitHub 头像或旧 Z 形徽记充当现行站点品牌标识。
7. 不出现「ZB ACTIVE」——母品牌自 2.0 起名为 **ACTIVE**。
8. 不把 AI 生成的展示板直接当作正式矢量文件；正式文件以 `assets/*.svg` 为准。

## 11. 文件与同步

| 文件 | 职责 |
|---|---|
| `BRAND_SYSTEM.md` | 本规范 |
| `brand-tokens.css` | 全站颜色/字体/几何 token |
| `assets/*.svg` · `assets/*.png` | Logo、图标、字标、Favicon |
| `build-assets.mjs` | 从 SVG 生成位图与社交卡 |
| `sync.sh` | 将统一品牌资产同步到四站并刷新 `BRAND_MANIFEST.sha256` |
| `sp-src/components/` | 共享 React 组件源 |

每次改动后：`CHROME_PATH=… pnpm run assets:build` → `ACTIVE_ROOT=/oc bash brand/sync.sh` → 四站 Brand Guard 校验 → 提交 → 线上巡检验证。
