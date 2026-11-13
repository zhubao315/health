# ACTIVE — 品牌视觉系统

**母品牌：** ACTIVE · 朱宝 · 运动与健康数字档案
**英文定位：** PERSONAL HEALTH & ACTIVE LIFE
**品牌口号：** 用数据记录每一次前进。
**适用范围：** HEALTH / RUNNING / CYCLING / HIKING 四个站点
**规范版本：** 2.0（2026-11-13）——母品牌由「ZB ACTIVE」更名为 **ACTIVE**，色板与字体改为直接采用主站 https://zhubao315.github.io/ 的实测值。

这份文件是四个仓库共同遵守的源文件。`brand-tokens.css` 与 `assets/` 下的矢量资源在四个仓库中保持逐字节一致，改动必须先改这里，再同步到各仓库（`./sync.sh`）。

---

## 1. 品牌结构

```
ACTIVE
朱宝 · 运动与健康数字档案

RUNNING · CYCLING · HIKING · HEALTH
```

| 层 | 内容 | 出现位置 |
|---|---|---|
| 母品牌 | ACTIVE 字标 + Z 形轨迹图形 | 顶部导航、页脚、Hero 眉标、社交预览图 |
| 子品牌 | RUNNING / CYCLING / HIKING / HEALTH 图标 + 中文名 | 导航项、底部导航、页面眉标 |
| 领域 | 跑步与耐力 / 骑行与远行 / 徒步与山野 / 身体与恢复 | 各站 Hero 副标与页脚说明 |

导航顺序固定为：**跑步 → 骑行 → 徒步 → 健康 → GitHub**（GitHub 只出现在顶部导航与页脚；手机底栏保持四项）。

原则是 **70% 统一 + 30% 运动专属**；四个站点的数据口径与算法不属于品牌层，永不因视觉改动而变。

## 2. Logo

### 2.1 图形

Z 字由**一条连续的轨迹线**构成：起点在高处，落点在低处，横折斜再横——这是一条路线的形状。斜线与横线交汇处有一枚金色节点（`#fbbf24`，即主站 `--think`），代表"此刻所在的位置"。

- 与主站的 Z-GRID 视觉语言同源；不堆叠运动 Emoji。
- 纯矢量、`currentColor`、无网络依赖、无动画、无低对比渐变；24px 可识别，16px 仍看出是 Z。
- 描边 2.8px，圆角端点与圆角折角。

### 2.2 版本

| 文件 | 用途 | 说明 |
|---|---|---|
| `assets/active-logo.svg` | 完整组合（图形 + ACTIVE 字标 + 副标） | `currentColor`，深浅背景通用 |
| `assets/active-mark.svg` | 独立图形 | `currentColor` + 固定金色节点 |
| `assets/active-logo-light.svg` | 深色背景独立图形 | 纸白描边 `#f7faff` |
| `assets/active-logo-dark.svg` | 浅色背景独立图形 | 海军蓝描边 `#0b1d33`，节点 `#d9a40a` |
| `assets/favicon.svg` | 浏览器图标 / 书签 | 32×32 圆角方块（主站 navy）内嵌图形 |
| `favicon-32.png` / `favicon-64.png` / `apple-touch-icon.png` | 位图回退 | 每站生成，节点用本站强调色 |

字标使用 Manrope 800（字距 2.2px），副标使用 Fira Code 500（字距 2.1px）。站内 SVG 内联渲染，字体随页面加载。

### 2.3 使用规则

- 图形最小 16px；顶部导航内 28px，页脚 30px，首屏 40px。
- 个人 GitHub 头像**不作为**任何站点的品牌标识。
- 四周留白不小于图形高度的 1/2。
- 主站自身的头像字标（ZHUBAO）是个人字标，产品字标是 ACTIVE，两者不混用。

## 3. 子品牌图标

24×24 画布，2px 描边，圆角端点与折角，线性风格，不混用填充。

| 子品牌 | 图形 | 关键词 |
|---|---|---|
| RUNNING | 上扬的轨迹线 + 方向箭头 | 速度与节奏 |
| CYCLING | 双轮 + 车架 | 机械与远行 |
| HIKING | 双峰 + 等高线 | 地形与探索 |
| HEALTH | 心率波形折线 | 身体与恢复 |

图标与文字固定 0.5rem 间距；图标颜色继承文字色。

## 4. 色彩（源自主站实测，不重新发明）

主站 tokens 提取自 `zhubao315.github.io/_astro/BaseLayout.CQMzMhmP.css`。

### 4.1 母品牌

| 用途 | 色值 | 主站对应 |
|---|---|---|
| 深色底（canvas） | `#07111f` | `--canvas` |
| 主卡片 | `#102A43` | （运动站现卡面，介于 navy 之间） |
| 抬起表面 | `#13263D` | `--navy-3` |
| 主要文字 | `#F7FAFF` | `--paper` |
| 次要文字 | `#CBD5E1` | — |
| 辅助文字 | `#94A3B8` | `--muted-light` |
| 深色底边框 | `rgba(247,250,255,.16)` | `--line-dark` 家族 |
| 浅色背景 | `#F7FAFF` | `--paper` |
| 浅色卡片 | `#FFFFFF` | — |
| 浅色正文 | `#101828` | `--ink` |
| 浅色辅助文字 | `#667085` | `--muted` |
| 浅色边框 | `rgba(16,24,40,.14)` | `--line` 家族 |
| 链接蓝 | `#2563EB` / `#1D4ED8` | `--electric` / `--electric-ink` |
| 成功 / 警告 / 危险 | `#34D399` / `#F59E0B` / `#F43F5E` | `--measure` / — / — |

### 4.2 站点强调色

| 站点 | Primary | Secondary | 与主站关系 |
|---|---|---|---|
| HEALTH | `#38BDF8` | `#0EA5E9` | = `--build` |
| CYCLING | `#FBBF24` | `#F59E0B` | = `--think` |
| HIKING | `#34D399` | `#10B981` | = `--measure` |
| RUNNING | `#D9F36A` | `#A3B82F` | **业主决定的例外**（主站绿仅 `#34d399`，与徒步保留区分度） |

站点主题色只用于：本站品牌强调、激活态、重点数据、地图轨迹线、底部导航当前项、Hero 眉标。它**不是**通用图表色。

### 4.3 健康指标语义色

指标色与站点主题色解耦，语义固定：睡眠 `#6366F1` · HRV `#10B981` · 静息心率 `#F43F5E` · 压力 `#F59E0B` · 训练负荷 `#38BDF8`。

### 4.4 对比度（AA）

`#F7FAFF`/`#07111F` ≈ 17:1 · `#94A3B8`/`#07111F` ≈ 7.0:1 · `#34D399`/`#07111F` ≈ 8.6:1 · `#D9F36A`/`#07111F` ≈ 13.4:1 · 浅色强调（`color-mix` 72% 加深）对 `#F7FAFF` ≥ 6.5:1。

## 5. 字体与节奏

| 元素 | 规格 |
|---|---|
| 阅读字体 | **Inter Variable**（自托管 `/fonts/`，与主站一致） |
| 展示字体 | **Manrope Variable**（自托管，用于品牌字标与大标题） |
| 中文 | 系统 CJK 栈（Noto Sans CJK SC / PingFang SC…） |
| 数字 / 时间 / 距离 / 配速 / 表格 | **Fira Code**，`font-variant-numeric: tabular-nums` |
| 页面主标题 | 32–44px（`clamp`） |
| 模块标题 | 20–24px |
| 正文 | 15px / 1.6 |
| 小型数据标注 | 11–12px，字距 0.1em，大写 |
| 卡片圆角 | 12px · 控件 8px |
| 间距 | 4px 倍数 |
| 动效缓动 | `cubic-bezier(.22,.72,.2,1)` / `cubic-bezier(.16,1,.3,1)`（主站 tokens） |

Fira Sans 不再作为文本字体；Fira Code 保留为等宽数字字体。

## 6. 布局骨架（四站同一）

| 项 | 值 |
|---|---|
| 内容宽度 | `--active-shell: 1440px`（`width: min(shell, 100% - 2*gutter)`） |
| 左右留白 | `--active-gutter: clamp(1rem, 3vw, 2rem)` |
| 页头高度 | `--active-header-h: 64px`（移动 `56px`），吸顶 |
| 页脚 | 三段：品牌锁定 / 五链接导航（跑步·骑行·徒步·健康·GitHub）/ 数据来源一行 |
| 手机底栏 | 四站图标 + 中文名，当前项用本站强调色，`env(safe-area-inset-bottom)`，内容区预留 `60px + 1.5rem` |
| 断点 | 1440 / 1024 / 768 / 390 / 360 |

## 7. 组件规范

`BrandMark` · `BrandNav`（手机底栏）· `SportIcon` · Header · Footer · `SiteHero`/PageIntro · `SectionHeader` · `MetricCard` · ChartCard · MapCard · ActivityCard · DataTable · EmptyState / LoadingState / ErrorState（中文文案 + 重试按钮 + `aria-live`）· DataFreshness（数据截至）。运动组件与健康组件可各自实现，视觉规则必须一致。

## 8. 主题

- 深色为默认；浅色是同一套设计在纸面（主站 `--paper`）上的读法。
- 四站共用 `localStorage` 键 `zhubao315-theme`（同源），一站切换，其余跟随。
- 站点强调色由各站 `site-metadata.ts` 的 `accent`/`accent2`（健康站为 CSS 变量）注入 `--accent-brand` / `--accent-2-brand`。

## 9. 禁止事项

1. 不修改历史数据、同步逻辑、原始数据文件与统计口径。
2. 不用站点主题色覆盖健康指标语义色。
3. 不在视觉改造中替换真实指标为演示数字。
4. 不删除地图、GPS 轨迹、3D 地形、日历、筛选与深度链接。
5. 不在组件里硬编码颜色，只用 token。
6. 不用个人头像充当站点品牌标识。
7. 不出现「ZB ACTIVE」——母品牌自 2.0 起名为 **ACTIVE**（历史记录与提交信息除外）。
