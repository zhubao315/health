# ZHUBAO Logo Assets — Strict Slices from the Approved Board

全部资产**直接裁切**自 `SOURCE.png`（即《ZHUBAO Brand Identity System.png》，1536×1024），
不做矢量重绘、不改色、不拉伸、不加特效。每个 PNG 都保留其原始像素与品牌板底色，是「上一版好看的 Logo」的精确来源。

| 文件 | 来源区域 | 内容 |
| --- | --- | --- |
| `symbol-panel.png` | Panel A (615,105)-(770,235) | Z-Grid 平面符号 |
| `symbol-hero.png` | 左侧大图 (130,130)-(445,410) | 3D 渐变主视觉符号 |
| `horizontal-lockup.png` | Panel B (935,105)-(1445,225) | 横向组合（符号 + 分隔线 + ZHUBAO + 朱宝） |
| `stacked-lockup.png` | Panel C (600,300)-(790,450) | 纵向组合 |
| `mono-light.png` | Panel D (893,310)-(1015,445) | 黑 Z / 冷白底单色版 |
| `mono-dark.png` | Panel D (1042,310)-(1163,445) | 白 Z / 黑底单色版 |
| `reverse-lockup.png` | Panel E (1265,300)-(1455,450) | 深底反白组合 |
| `wordmark-en.png` / `wordmark-zh.png` | Panel B | 英文/中文辅助字标 |
| `favicon-16/32/64/128.png` | Panel F | Favicon 展示样块（含原始圆角底板） |
| `usage-dark.png` / `usage-light.png` | Panel I | 深/浅背景应用示例 |

完整坐标与 SHA256 见 `manifest.json`；总览见 `CONTACT-SHEET.png`。

## 再生

```bash
python3 tools/slice_identity.py   # 从 SOURCE.png 重新裁切全部资产
```

脚本只做 `PIL.Image.crop()`——严格切分，零重绘。站点现有 Header/Footer/Favicon 资产本就来自同一张品牌板的切图，保持不变，避免视觉回退。
