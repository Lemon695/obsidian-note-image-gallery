# 笔记图片墙

<p align="center">
  <strong>一个强大的 Obsidian 插件，以精美的交互式画廊视图展示当前笔记中的所有图片。</strong>
</p>

<p align="center">
  <a href="https://github.com/Lemon695/obsidian-note-image-gallery/releases"><img src="https://img.shields.io/github/v/release/Lemon695/obsidian-note-image-gallery?style=for-the-badge" alt="Release"></a>
  <a href="https://github.com/Lemon695/obsidian-note-image-gallery/blob/master/LICENSE"><img src="https://img.shields.io/github/license/Lemon695/obsidian-note-image-gallery?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_zh.md">简体中文</a>
</p>

---

## 🎬 演示

### 1、通过命令面板启用

![gif-2025-obsidian-v1.gif](_resources/gif/gif-2025-obsidian-v1.gif)

### 2、使用 【Commander】 插件启用

![gif-2025-obsidian-v2.gif](_resources/gif/gif-2025-obsidian-v2.gif)

---

## ✨ 功能特性

- **📸 画廊视图**：以优雅的瀑布流/砖石布局展示笔记中的所有图片
- **🖼️ 图片支持**：
  - 本地图片（仓库附件）
  - 远程图片（HTTP/HTTPS URL）
  - 微博图片特殊处理
- **🎨 交互界面**：
  - 点击任意图片在灯箱视图中查看并导航
  - 使用方向键快速导航
  - 使用鼠标滚轮或键盘放大/缩小
  - 右键菜单支持复制和下载图片
- **🔍 筛选和排序**：
  - 按类型筛选图片（全部 / 本地 / 网络）
  - 按大小或默认顺序排序
- **⚡ 性能优化**：
  - 懒加载提升性能
  - 虚拟滚动处理大量图片集合
  - 智能图片队列和优先级管理
  - 可配置并发加载限制
- **💾 智能缓存**：
  - 基于文件系统的远程图片缓存
  - 可配置缓存大小和过期时间
  - LFU+LRU 混合缓存淘汰算法
  - 自动缓存清理和管理
- **🌍 国际化**：
  - 自动检测 Obsidian 语言设置
  - 完整支持英语和简体中文
  - 易于扩展更多语言
- **📱 跨平台**：支持桌面端和移动端设备

---

## 📦 安装

### 从 Obsidian 社区插件安装（推荐）

1. 打开 Obsidian 设置
2. 导航到**社区插件**并关闭安全模式
3. 点击**浏览**并搜索"Note Image Gallery"
4. 点击**安装**，然后点击**启用**

### 手动安装

1. 从[发布页面](https://github.com/Lemon695/obsidian-note-image-gallery/releases)下载最新版本
2. 将文件解压到你的仓库插件文件夹：`<vault>/.obsidian/plugins/note-image-gallery/`
3. 重新加载 Obsidian
4. 在设置 → 社区插件中启用该插件

---

## 🚀 使用方法

### 打开图片墙

有三种方式打开图片墙：

1. **命令面板**：按 `Ctrl/Cmd + P` 并搜索"当前文件"或"Current file"
2. **侧边栏图标**：点击左侧边栏中的图片墙图标
3. **快捷键**：在设置 → 快捷键中自定义快捷键

### 图片墙导航

- **点击**任意图片在全屏灯箱模式下查看
- **方向键**（← →）在图片间导航
- **鼠标滚轮**或 **+/-** 键放大/缩小
- **ESC** 键或点击外部区域关闭灯箱
- **右键点击**任意图片打开上下文菜单：
  - 复制图片到剪贴板
  - 下载图片

### 筛选和排序

- 使用顶部的**筛选按钮**显示：
  - 全部图片
  - 仅本地图片
  - 仅网络图片
- 使用**排序下拉菜单**对图片排序：
  - 默认顺序（按笔记中出现顺序）
  - 按尺寸（大到小）
  - 按尺寸（小到大）

---

## ⚙️ 设置

通过设置 → Note Image Gallery 访问插件设置

### 缓存设置

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| **启用图片缓存** | 缓存远程图片以加快加载速度 | 启用 |
| **缓存有效期** | 缓存最大有效期，单位：天（1-60）| 7 天 |
| **最大缓存大小** | 缓存最大大小，单位：MB（10-300）| 100 MB |

### 缓存管理

- **刷新缓存状态**：重新计算当前缓存大小
- **清除全部缓存**：删除所有缓存的图片

### 开发者设置

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| **调试模式** | 启用详细的控制台日志记录 | 禁用 |

---

## 🎯 性能优化建议

1. **启用缓存**：保持图片缓存开启以加快远程图片加载速度
2. **调整缓存大小**：如果处理大量远程图片，可以增加缓存大小
3. **定期清理**：如果存储空间有限，定期清理缓存
4. **图片优化**：使用优化的图片格式（WebP、JPEG）以获得更好的性能

---

## 🛠️ 开发

### 构建插件

```bash
# 安装依赖
npm install

# 开发构建（带监听模式）
npm run dev

# 生产构建
npm run build

# 运行 TypeScript 类型检查
npm run build
```

### 项目结构

```
obsidian-note-image-gallery/
├── src/
│   ├── main.ts                 # 插件入口
│   ├── settings.ts              # 设置选项卡和配置
│   ├── i18n/
│   │   └── locale.ts            # 国际化翻译
│   ├── service/
│   │   ├── current-note-image-gallery-service.ts  # 主图片墙服务
│   │   ├── image-cache-service.ts                 # 缓存管理
│   │   ├── image-extractor-service.ts             # 从 Markdown 提取图片
│   │   └── obsidian-image-loader.ts               # 图片加载工具
│   └── utils/
│       ├── log-utils.ts         # 日志系统
│       ├── retry-handler.ts     # 重试逻辑
│       └── resource-manager.ts  # 资源清理
├── styles.css                   # 插件样式
└── manifest.json                # 插件清单
```

### 使用的技术

- **TypeScript**：类型安全开发
- **Obsidian API**：插件框架
- **CSS Grid**：瀑布流布局
- **IntersectionObserver**：懒加载
- **File System API**：缓存管理

---

## 🤝 贡献

欢迎贡献！以下是你可以提供帮助的方式：

1. **报告问题**：提交问题并附上详细的重现步骤
2. **建议功能**：在 issues 区分享你的想法
3. **提交 Pull Request**：
   - Fork 仓库
   - 创建功能分支（`git checkout -b feature/amazing-feature`）
   - 提交更改（`git commit -m 'Add amazing feature'`）
   - 推送到分支（`git push origin feature/amazing-feature`）
   - 打开 Pull Request

### 开发指南

- 遵循现有的代码风格
- 为复杂逻辑添加注释
- 在桌面端和移动端测试
- 为新功能更新 README

---

## 📝 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

---

## 🙏 致谢

- 感谢 Obsidian 团队提供的优秀插件 API
- 受社区中各种图片画廊插件的启发
- 特别感谢所有贡献者和用户

---

## 📧 支持

- **问题反馈**：[GitHub Issues](https://github.com/Lemon695/obsidian-note-image-gallery/issues)
- **讨论区**：[GitHub Discussions](https://github.com/Lemon695/obsidian-note-image-gallery/discussions)
- **作者**：[@Lemon695](https://github.com/Lemon695)

---

## 🔄 更新日志

查看[发布页面](https://github.com/Lemon695/obsidian-note-image-gallery/releases)了解每个版本的更改列表。

---

<p align="center">
  用 ❤️ 为 Obsidian 社区制作
</p>
