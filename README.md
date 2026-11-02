# 沪深300 方向预测系统 · 静态页

本目录即 GitHub Pages 的发布根目录。上传后即可获得一个永久可访问的公开网址。

## 目录内容

| 文件 | 说明 |
|---|---|
| `index.html` | 页面入口 |
| `app.js` | 前端逻辑（数据读取、双模型展示、历史留痕） |
| `style.css` | 样式 |
| `data/` | 预计算的预测结果（2021–2026，1352 个交易日） |
| `.nojekyll` | 让 GitHub Pages 跳过 Jekyll 处理 |

## 两种运行模式

**静态模式（默认）**：直接读 `data/*.json`，无需后端，永久可用。
数据截止日期写在 `data/manifest.json` 的 `built_with_data_until`，页面顶部会显示。

**实时模式**：点页面右上角「设置后端」，填入运行中的 FastAPI 地址
（本机 `http://127.0.0.1:8000`，或 Cloudflare Tunnel 的 `https://xxx.trycloudflare.com`），
保存后刷新即可实时拉取东方财富最新行情。

也可以用 URL 参数直接指定：
```
https://<你的用户名>.github.io/<仓库名>/?api=https://xxx.trycloudflare.com
```

## 说明口径

页面默认自动探测后端：能连通就用实时数据，连不通就自动回退到静态快照，
并在顶部明确标注「静态快照 · 构建于 X（截至 Y）」——不做任何伪装。
