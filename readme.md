# 个人网站

## 项目定位

一个记录个人成长轨迹与思考的数字空间——从道桥工程师到海外建设者，再到机械工程学生，用文字和项目留存每个阶段的观察与探索。

目标：整理、展示个人经历、想法及项目经历，面向长期持续更新。

---

## 个人背景

- **成长地**：四川省德阳市什邡市
- **本科**：东南大学，道路与桥梁工程专业
- **职业**：毕业后入职中国路桥工程有限责任公司（CRBC），外派海外
- **当前**：在赤道几内亚工作，已满两年（截至 2026 年）
- **规划**：回国 gap 一年 → 赴瑞典 KTH 攻读 Mechanical Engineering 硕士

---

## 主要板块

| 板块 | 路径 | 内容方向 |
|------|------|----------|
| 人生轨迹 | `/timeline` | 什邡 → 东南大学 → 赤道几内亚 → KTH 的时间线 |
| 海外见闻 | `/abroad` | 赤道几内亚的人文、历史与生活观察 |
| 主要项目 | `/projects` | 道路桥梁工程项目 + 未来技术项目展示 |
| 经济探索 | `/economics` | 对经济现象的思考与研究文章 |

---

## 技术栈

- **框架**：[Astro](https://astro.build/)
- **样式**：Tailwind CSS
- **内容**：Markdown / YAML（Content Collections）
- **部署**：Vercel（推荐）

---

## 项目结构

```
src/
├── content/              # 所有内容文件
│   ├── config.ts         # 内容集合类型定义
│   ├── timeline/         # 人生轨迹节点（.yaml 文件）
│   ├── abroad/           # 海外见闻文章（.md 文件）
│   ├── projects/         # 项目文章（.md 文件）
│   └── economics/        # 经济文章（.md 文件）
├── layouts/
│   └── BaseLayout.astro  # 统一页面布局（导航 + footer）
├── pages/
│   ├── index.astro       # 首页
│   ├── timeline/         # 人生轨迹页
│   ├── abroad/           # 海外见闻列表页 + 文章详情页
│   ├── projects/         # 项目列表页 + 详情页
│   └── economics/        # 经济探索列表页 + 文章详情页
└── styles/
    └── global.css        # 全局样式
```

---

## 本地开发

```bash
npm install      # 安装依赖（首次）
npm run dev      # 启动开发服务器，访问 http://localhost:4321
npm run build    # 构建生产版本
npm run preview  # 预览构建结果
```

---

## 如何写新文章

在对应板块的 `src/content/<板块>/` 目录下新建一个 `.md` 文件，文件名即为 URL slug。

**文章模板（abroad / projects / economics 通用）：**

```markdown
---
title: 文章标题
date: 2024-06-01
description: 一句话摘要，显示在列表页
tags: [可选标签, 仅 projects 板块使用]
---

正文内容，支持完整 Markdown 语法。
```

**示例：** 新建 `src/content/abroad/malabo-city.md`，访问 `/abroad/malabo-city` 即可看到文章。

---

## 如何更新人生轨迹

人生轨迹使用 YAML 数据文件，在 `src/content/timeline/` 下新建 `.yaml` 文件：

```yaml
title: 事件标题
date: 2025-09-01
description: 事件描述
location: 地点（可选）
```

---

## 如何新增板块

1. **定义内容集合**：在 `src/content/config.ts` 中添加新的 collection：

```ts
const newSection = defineCollection({
  type: 'content',
  schema: postSchema,  // 复用已有 schema
});

export const collections = {
  // ...已有板块
  newSection,
};
```

2. **创建内容目录**：新建 `src/content/<新板块>/` 目录，放入 `.md` 文章。

3. **创建页面**：新建 `src/pages/<新板块>/` 目录，参考已有板块复制 `index.astro` 和 `[slug].astro`，修改标题和 collection 名称。

4. **加入导航**：在 `src/layouts/BaseLayout.astro` 的 `nav` 数组中添加新条目：

```ts
const nav = [
  // ...已有条目
  { href: '/new-section', label: '新板块名称' },
];
```

---

## 部署到 Vercel

1. 将项目推送到 GitHub
2. 在 [Vercel](https://vercel.com) 导入仓库
3. 框架预设选 **Astro**，其余默认
4. 绑定自定义域名（可选）
