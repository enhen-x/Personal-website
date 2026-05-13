# 星空以远

> 我们不正是为了触及不可知的边界，才来到这片星空下的吗

个人网站，记录探索的产出——观察、思考、影像。

---

## 板块

| 板块 | 路径 | 内容 |
|------|------|------|
| 海外见闻 | `/abroad` | 赤道几内亚的人文、历史与日常观察 |
| 主要项目 | `/projects` | 工程实践与技术探索 |
| 经济探索 | `/economics` | 对经济现象的思考与研究 |
| 读书笔记 | `/books` | 读过的书，留下的痕迹 |
| 摄影 | `/photography` | 图集，以图集为单位组织 |

---

## 技术栈

- **框架**：[Astro](https://astro.build/)
- **样式**：Tailwind CSS
- **内容**：Markdown（Content Collections）
- **部署**：Vercel → [enhen-x/Personal-website](https://github.com/enhen-x/Personal-website)

---

## 本地开发

```bash
npm install
npm run dev      # http://localhost:4321
npm run build
```

---

## 写新文章

在 `src/content/<板块>/` 下新建 `.md`，文件名即 URL slug：

```markdown
---
title: 文章标题
date: 2024-06-01
description: 一句话摘要
---

正文...
```

## 新增摄影图集

在 `src/content/photography/` 下新建 `.md`，照片放 `public/photos/`：

```markdown
---
title: 图集标题
date: 2024-06-01
description: 一句话描述
location: 地点（可选）
cover: /photos/封面文件名.jpeg
photos:
  - src: /photos/照片1.jpeg
    caption: 说明文字（可选）
  - src: /photos/照片2.jpeg
---
```

## 新增板块

1. `src/content/config.ts` 加 collection
2. `src/content/<板块>/` 放文章
3. `src/pages/<板块>/` 加 `index.astro` 和 `[slug].astro`（参考已有板块）
4. `src/layouts/BaseLayout.astro` 的 `nav` 数组加入口
5. `src/pages/index.astro` 的 `sections` 和 `allPosts` 接入新板块
