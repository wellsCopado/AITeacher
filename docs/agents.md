# 换大模型、接 AI 助手：怎么用别的模型和工具继续做课

做课的规则只有一份：`skills/discovery-learning-studio/`（Skill）。不管谁来做课，都读这份 Skill、用同一个校验器（V01–V18），做好的课都进家长端「课程库 → 等你审核」，只有家长点按钮才发布。

## 三种方式，选一种

| 方式 | 适合 | 要准备什么 |
| --- | --- | --- |
| A. 家长端一键出课 | 不想开电脑终端，点一下就出一节课 | 一个大模型的 API Key（DeepSeek、通义千问、Kimi、智谱、豆包、GPT、Claude、Gemini 都行），或家里电脑上的 Ollama |
| B. AI 助手通过 MCP 做课 | 用 Codex、Claude Code、Qoder、Cursor 等工具，边聊边做 | 家长端生成一个接入令牌，把配置贴进工具里 |
| C. 在仓库里用命令行 | 要改代码、加组件、调规则 | 克隆仓库，`pnpm install`，AI 助手会自动读 `AGENTS.md` |

## A. 家长端一键出课（任意大模型，随时切换）

1. 家长端 →「设备与数据」→「大模型（AI 出课用）」。
2. 服务商选一个（会自动填好接口地址和常用模型名），粘贴 API Key，点“获取模型列表”挑一个模型，点“测试”看到回答后点“保存”。
3. 可以加好几个，列表最左边点一下就切换正在用的模型。Key 只存在家里的服务器上，保存后页面上只显示后 4 位。
4. 勾选“我同意 AI 出课时把孩子的年级、称呼和兴趣主题发给所选模型”。发出去的只有这些；真实姓名、作业照片、学习记录、孩子的原话都不发。用本机 Ollama 时不用勾。
5. 「课程库」→「AI 出一节课」：选孩子，写一句要求（例如“用大桥做主题”“再难一点”，也可以不写），选模型，点“开始写课”。模型按 Skill 写课，校验没通过会把问题自动发回去让它改（最多 4 轮），通过后出现在“等你审核”。
6. 退回的课上有“让 AI 按意见改”，用你写的意见改同一节课。

各家的接口地址（都是 OpenAI 兼容格式；模型名常变，以“获取模型列表”为准）：

| 服务商 | 接口地址 |
| --- | --- |
| DeepSeek | `https://api.deepseek.com` |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi（月之暗面） | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` |
| OpenAI（GPT） | `https://api.openai.com/v1` |
| Anthropic（Claude） | `https://api.anthropic.com/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| 本机 Ollama | `http://localhost:11434/v1`（和服务器在同一台电脑上；服务器用 Docker 跑时填 `http://host.docker.internal:11434/v1`） |
| 其他 | 任何 OpenAI 兼容接口，选“其他”自己填 |

命令行也能这样出课（结果写到 `content/lessons/`）：

```
ADW_LLM_PROVIDER=deepseek ADW_LLM_API_KEY=sk-… pnpm -s dls generate --child gege --wish "用大桥做主题"
```

`ADW_LLM_MODEL` 换模型，`ADW_LLM_BASE_URL` 填其他接口地址。

## B. AI 助手通过 MCP 做课（Codex、Claude Code、Qoder、Cursor…）

1. 家长端 →「设备与数据」→「AI 助手接入（MCP）」，填个名字（例如 Codex）点“生成令牌”。令牌只显示一次，页面会同时给出下面几种工具的配置，直接复制。
2. 把配置贴进工具：

   **Codex**（`~/.codex/config.toml`）：

   ```toml
   [mcp_servers.adw]
   url = "http://<服务器地址>:8787/mcp"
   http_headers = { "Authorization" = "Bearer <令牌>" }
   ```

   **Claude Code**（终端里运行一次）：

   ```
   claude mcp add --transport http adw http://<服务器地址>:8787/mcp --header "Authorization: Bearer <令牌>"
   ```

   **Cursor、Qoder 等**（`mcp.json` 格式，字段名以该工具的说明为准）：

   ```json
   { "mcpServers": { "adw": { "url": "http://<服务器地址>:8787/mcp", "headers": { "Authorization": "Bearer <令牌>" } } } }
   ```

3. 对助手说“用 adw 给哥哥做下一节课”。它能用的工具：

   | 工具 | 做什么 |
   | --- | --- |
   | `adw_read_guide` | 读 Skill（规则、上课流程、字段说明、组件、主题、校验规则） |
   | `adw_get_context` | 孩子的年级、兴趣和心愿、可用组件、建议主题、新课 id |
   | `adw_get_example` | 一节完整、校验通过的示例课 |
   | `adw_check_lesson` | 校验，返回每个问题的位置和改法 |
   | `adw_submit_for_review` | 交给家长审核 |
   | `adw_list_lessons` / `adw_get_lesson` | 看已有的课、取回退回的课来改 |

   没有发布工具；令牌也打不开学习记录、作业和照片。不用了就在家长端点“移除”，令牌马上失效。

在仓库里也可以不连服务器，让助手自己启动本地 MCP（stdio）：命令 `pnpm -s dls mcp`，工作目录是仓库根目录；要交给家长审核就加环境变量 `ADW_SERVER` 和 `ADW_TOKEN`。

说明：ChatGPT 网页版的连接器要求公网 HTTPS 地址，家里局域网的服务器连不上，也不建议把家里服务器暴露到公网。用 Codex（装在家里电脑上）即可。

## C. 在仓库里用命令行（任意 AI 编程助手）

- Claude Code 读 `CLAUDE.md` 和 `.claude/skills/`，Codex 读 `AGENTS.md` 和 `.agents/skills/`，Qoder 读 `AGENTS.md` 和 `.qoder/rules/`，Cursor 读 `AGENTS.md`。这些入口都指向 `skills/` 下的同一份 Skill。
- 想让这些工具本身换成 DeepSeek 等模型，在工具里设置：
  - Claude Code：DeepSeek 提供 Anthropic 兼容接口，设置 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` 和 `ANTHROPIC_AUTH_TOKEN=<DeepSeek 的 Key>`，再用 `ANTHROPIC_MODEL` 选模型。详见 [DeepSeek：接入 Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)、[Anthropic 兼容接口](https://api-docs.deepseek.com/guides/anthropic_api)。
  - Codex：按 [DeepSeek：接入 Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) 配置模型提供方。
  - Qoder、Cursor：在各自的模型设置里选。

## 参考

- Codex：[Skills](https://developers.openai.com/codex/skills)、[MCP](https://developers.openai.com/codex/mcp)
- Qoder：[Rules（`.qoder/rules`，兼容 AGENTS.md）](https://docs.qoder.com/user-guide/rules)
- DeepSeek：[API 文档](https://api-docs.deepseek.com/)
