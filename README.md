# PTA Auto Solver

一款 Chrome 扩展，使用 AI 自动完成 PTA（拼题A）编程题目。

## 功能特性

- 🤖 **AI 自动生成** - 自动读取题目，AI 生成解决方案
- 💡 **提示模式** - 已有代码？AI 分析错误点并给出修复建议
- 🌊 **流式输出** - 实时查看 AI 生成进度
- 🔄 **自动调试** - 测试不匹配时自动分析并修复
- 📋 **多语言支持** - C / C++ / Python
- 🎯 **智能导航** - 自动跳过已 AC 题目，批量刷题
- 🎨 **美观界面** - 暗色主题，可拖动、可拉伸、可最小化

## 安装

### 从源码安装

1. 克隆本仓库：
```bash
git clone https://github.com/YOUR_USERNAME/pta-auto-solver.git
```

2. 打开 Chrome，访问 `chrome://extensions/`

3. 开启右上角的 **开发者模式**

4. 点击 **加载已解压的扩展程序**，选择本项目目录

### 配置 AI API

1. 点击扩展图标打开设置面板
2. 选择 AI 提供商（默认 OpenAI 兼容接口）
3. 输入 API Key（推荐 [newapi.doclaw.cn](https://newapi.doclaw.cn)）
4. 选择模型，保存设置

## 使用方式

### 自动模式
1. 打开 PTA 题目页面
2. 点击面板上的 **▶ 自动** 按钮
3. 扩展会自动：读题 → AI 生成 → 写入代码 → 自测 → 提交 → 下一题

### 提示模式
1. 在代码框中编写或粘贴你的代码
2. 点击 **💡 提示** 按钮
3. AI 会运行测试，分析错误点，给出修复建议

### 面板操作
- **拖动**：按住标题栏拖动
- **拉伸**：拖动右下角 L 形手柄
- **最小化**：点击"收起"按钮，双击 logo 可展开

## 项目结构

```
├── manifest.json      # 扩展配置
├── background.js      # Service Worker（AI 请求处理）
├── content.js         # 内容脚本（面板 UI + 自动逻辑）
├── popup.html         # 设置页面
├── popup.js           # 设置逻辑
└── icons/             # 扩展图标
```

## 技术栈

- Chrome Extension Manifest V3
- CodeMirror 6（通过 React Fiber 访问）
- OpenAI / Anthropic API（流式 SSE）

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 免责声明

本扩展仅供学习参考。请在遵守 PTA 平台规则的前提下使用。
