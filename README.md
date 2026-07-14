# 表情派 EmojiPie

把每一句话变成专属聊天表情的本地优先桌面应用。

## 当前能力

- 表达模式与回复模式
- 默认、可爱、社畜、发疯四种黄脸风格
- 默认生成 `256x256` 透明小黄脸，也可切换为 `640x640` 表情海报
- 图片内文字可独立开关，版式与文字设置会记住最近选择
- 本地规则分析与 Canvas 双版式表情合成，无需 API Key
- 可直接接入 Ollama、LM Studio、OpenAI-compatible 本地模型服务
- 可选接入 Claude Code、Codex、OpenCode CLI 运行时
- 瀑布流结果、自动续批、点击复制 PNG
- 历史记录、收藏与图片导出
- Electron + React + TypeScript + SQLite

## 开发

环境要求：Node.js 24 或更新版本。

```bash
npm install
npm run dev
```

常用命令：

```bash
npm test          # 单元测试
npm run lint      # 静态检查
npm run build     # 生产构建
npm run package   # 生成当前平台的免安装目录
npm run package:win # 生成 Windows 安装包
```

历史、收藏和 PNG 保存在 Electron 用户数据目录。默认规则模式不发起模型请求；启用
AI 运行时后，输入会交给所选本地模型服务或 Agent CLI 处理。
详细设计见 [技术方案](docs/TECHNICAL_SOLUTION.md)。

## AI 运行时

AI 运行时默认关闭，应用始终保留确定性的规则分析作为回退。运行时页面包含两类来源：

- **本地模型**：直接发现 Ollama、LM Studio 和 OpenAI-compatible 服务的模型目录。
  默认地址分别是 `127.0.0.1:11434`、`127.0.0.1:1234` 和 `127.0.0.1:8000`。
- **Agent CLI**：发现 Claude Code、Codex 和 OpenCode，可跟随 CLI 默认模型，也可选择
  运行时公开的模型目录。

本地服务地址只允许 `localhost`、`127.0.0.0/8` 或 `::1`。Ollama 已安装但服务未运行时，
页面会提供显式“启动 Ollama”操作；应用退出时只清理自己启动的进程，不影响用户原有服务。
CLI 可执行文件留空时自动发现，也可以填写规范化绝对路径覆盖。

运行时返回整句分析与 9 个 `{ emotion, caption }` 表情方案，Canvas 会直接使用这些
方案绘制图片。关闭图片内文字只改变绘制结果，caption 仍用于卡片标题、搜索和文件名。
本地小模型首次输出不合规时会按同一契约纠错重试一次；运行时不可用、超时或连续输出
不合规时，当前生成自动回退到规则引擎。

真实 CLI 联调测试可按需运行：

```powershell
$env:EMOJI_PIE_TEST_AGENT_RUNTIME='1'
$env:EMOJI_PIE_TEST_RUNTIME='codex' # claude | codex | opencode
$env:EMOJI_PIE_TEST_MODEL='gpt-5.4' # 可选，留空跟随 CLI 默认模型
npx playwright test tests/e2e/agent-runtime.spec.ts
```

真实 Ollama 联调测试可按需运行：

```powershell
$env:EMOJI_PIE_TEST_LOCAL_MODEL='1'
$env:EMOJI_PIE_TEST_MODEL='llama3:latest' # 可选，留空使用发现到的第一个模型
npx playwright test tests/e2e/local-model.spec.ts
```
