# 换大模型、接 AI 助手：怎么用别的模型和工具继续做课

做课的规则只有一份：`skills/discovery-learning-studio/`（Skill）。不管谁来做课，都读这份 Skill、用同一个校验器（V01–V18），做好的课都进家长端「课程库 → 等你审核」，只有家长点按钮才发布。

## 四种方式，选一种

| 方式 | 适合 | 要准备什么 |
| --- | --- | --- |
| A. 家长端一键出课 | 不想开电脑终端，点一下就出一节课 | 一个大模型的 API Key（DeepSeek、通义千问、Kimi、智谱、豆包、GPT、Claude、Gemini 都行），家里电脑上的 Ollama，或你的 ChatGPT 账号（见 D） |
| B. AI 助手通过 MCP 做课 | 用 Codex、Claude Code、Qoder、Cursor 等工具，边聊边做 | 家长端生成一个接入令牌，把配置贴进工具里 |
| C. 在仓库里用命令行 | 要改代码、加组件、调规则 | 克隆仓库，`pnpm install`，AI 助手会自动读 `AGENTS.md` |
| D. ChatGPT 谈方案、生图，DeepSeek 做课 | 有 ChatGPT Plus，想用云端 GPT 商量方案、出图，再让便宜的模型做完 | 服务器电脑上装一次 Codex 并登录 ChatGPT；之后全在家长端 |

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
| ChatGPT 账号（本机 Codex） | 不用填地址和 Key，见 D |
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
   | `adw_read_skill` | 读项目里的任意一份 Skill：不带参数列出全部；做 3D 素材、主持人、动手题的 agent 读 `photoreal-3d-production` |
   | `adw_get_context` | 孩子的年级、兴趣和心愿（`next_lesson_wish`：这节课按它准备）、可用组件、建议主题、新课 id |
   | `adw_next_lessons` | 每个孩子的下一课准备单（按先后排队）：主题、哪天说的、用哪个场景、主角素材做到哪一步。做素材的 agent 按它提前准备；只有主题，没有原话 |
   | `adw_get_example` | 一节完整、校验通过的示例课 |
   | `adw_check_lesson` | 校验，返回每个问题的位置和改法 |
   | `adw_submit_for_review` | 交给家长审核 |
   | `adw_list_lessons` / `adw_get_lesson` | 看已有的课、取回退回的课来改 |
   | `adw_write_with_model` / `adw_job_status` | 把谈好的方案交给你在家长端配置的模型去写课、看进度 |
   | `adw_prepare_image_upload` | 拿一次性地址上传写实图，等你确认后孩子才看得到 |

   没有发布工具；令牌也打不开学习记录、作业和照片。不用了就在家长端点“移除”，令牌马上失效。

在仓库里也可以不连服务器，让助手自己启动本地 MCP（stdio）：命令 `pnpm -s dls mcp`，工作目录是仓库根目录；要交给家长审核就加环境变量 `ADW_SERVER` 和 `ADW_TOKEN`。

说明：ChatGPT 网页版的连接器要求公网 HTTPS 地址，家里局域网的服务器连不上，也不建议把家里服务器暴露到公网。用 Codex（装在家里电脑上）即可。

## C. 在仓库里用命令行（任意 AI 编程助手）

- Claude Code 读 `CLAUDE.md` 和 `.claude/skills/`，Codex 读 `AGENTS.md` 和 `.agents/skills/`，Qoder 读 `AGENTS.md` 和 `.qoder/rules/`，Cursor 读 `AGENTS.md`。这些入口都指向 `skills/` 下的同一份 Skill。
- 想让这些工具本身换成 DeepSeek 等模型，在工具里设置：
  - Claude Code：DeepSeek 提供 Anthropic 兼容接口，设置 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` 和 `ANTHROPIC_AUTH_TOKEN=<DeepSeek 的 Key>`，再用 `ANTHROPIC_MODEL` 选模型。详见 [DeepSeek：接入 Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)、[Anthropic 兼容接口](https://api-docs.deepseek.com/guides/anthropic_api)。
  - Codex：按 [DeepSeek：接入 Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) 配置模型提供方。
  - Qoder、Cursor：在各自的模型设置里选。

## D. ChatGPT 谈方案、生图，DeepSeek 做课

两个模型分工：GPT（用 ChatGPT Plus 的额度）负责和你商量方案、出图；你在 A 里配置的模型（例如 DeepSeek）按 Skill 把方案做成完整的课。

### 推荐：全在家长端，不用打开 Codex

家里服务器在后台调用 Codex（Plus 套餐包含 Codex），用的是你的 ChatGPT 账号，不用 API Key，也不按用量另付费。

**只做一次（在运行服务器的那台电脑上）**

1. 打开“终端”，运行 `npm i -g @openai/codex` 安装 Codex。
2. 运行 `codex login`，在打开的网页里用 ChatGPT 账号登录。登录信息存在这台电脑的 `~/.codex/` 里，要像密码一样保管。
3. 家长端「设备与数据 → 大模型」，服务商选“ChatGPT 账号（本机 Codex）”。页面会显示 Codex 有没有装好、有没有登录。点“测试”看到回答后点“保存”。模型名可以留空（用 Codex 默认的模型）。
4. 勾选同意：商量方案和写课时会把年级、称呼和兴趣主题发给 ChatGPT；画图时会把那种生物的实拍照片发给 ChatGPT。

加了 ChatGPT 账号后，原来用来写课的模型（例如 DeepSeek）还是默认的写课模型。

**以后每次**

- **商量方案**：「课程库 → AI 出一节课 → 和 AI 商量方案」，“商量用”默认是 ChatGPT。像聊天一样说你想要什么，它会问一两个问题、给几个方向。满意了说“好了”，它写出【课程方案】，点“用这个方案写课”，就交给“写课用”里选的模型（例如 DeepSeek）去写。写好进“等你审核”。对话在这个浏览器标签页里保留，点“重新开始”清空。
- **新动物自动变成会动的 3D**：一节课讲的是现成场景里没有的动物（例如博比特虫）时，课写好后服务器自动让 ChatGPT 上网找 3–4 张实拍照片（优先维基共享资源等标明授权的），查它的真实体长，再依据照片画一张正上方俯视的写实图；场景把这张图自动切成一节一节，做成会从洞里立起来、摇摆、出击、拆开看身体的 3D，按真实大小放进去。也可以在「生物素材」或待审核的课下面点“让 ChatGPT 自动做「…」”。做好后先点课的“预览”看 3D，再在「生物素材」对照实拍照片核对，点“都核对过了，全部确认”，这节课才能发布。只把动物的名字和照片发给 ChatGPT。
- **挑战题有图，聊聊有主持人**：每道挑战题上方都有一张用这节课 3D 场景按题目数字摆好的图（机器人课是机械臂摆好的齿轮），孩子可以转着看。最后的聊聊由主持人带（真人或真实的服务机器人）。现在的机器人主持人和机器人工厂场景是代码拼的，不够写实，正在按 `skills/photoreal-3d-production` 的规格替换。
- **画写实图**：「课程库 → 生物素材」，某种生物有 3 张以上实拍或标本照片后，会出现“让 ChatGPT 依据实拍照片画一张”。可以写一句想要的画面（例如“侧面全身”）。画好后标着“等你确认”，下面列出它参考的照片；你核对形态后点“确认可用”，孩子才看得到。
- **直接用 ChatGPT 写课**也可以：“写课用”选 ChatGPT 账号。

说明：

- Codex 每次在一个空的临时文件夹里运行，商量和写课时只读、不改任何文件；画图时只能写这个临时文件夹，画好就删掉。
- 服务器从终端启动时，能找到装好的 `codex`。如果装在别的位置，启动前设置 `ADW_CODEX_BIN=<codex 的完整路径>`。
- 用量算在 ChatGPT 套餐的 Codex 额度里。额度用完时，家长端会提示过一会儿再试，或先换别的模型。
- 提示“Codex 还没登录”时，在服务器电脑的终端里再运行一次 `codex login`。

### 也可以：在 ChatGPT 网页或手机 App 里谈（什么都不用装）

1. 家长端「课程库 → AI 出一节课」，选孩子，点“复制设计说明”。这段说明里有孩子的年级、兴趣、3D 能做什么、规则和方案格式，不含姓名和隐私。
2. 粘到 ChatGPT，和它聊这节课。谈好后它会输出以【课程方案】开头的一段。
3. 把这段整段粘回「AI 出一节课」的框里，点“开始写课”。写好进“等你审核”。
4. 要图片：在 ChatGPT 里让它依据实拍照片生成写实图，下载后在「生物素材」里上传，类型选“AI 写实图”，写上参考了哪些照片。

### 也可以：在 Codex 里边聊边做（适合想自己指挥 AI 助手的时候）

1. 按 B 生成令牌，把配置贴进 Codex。
2. 对 Codex 说：“用 adw 和我商量哥哥的下一节课，谈好后交给家里的模型去做”。它会调用 `adw_write_with_model`，写好进“等你审核”。
3. 要图片：让 Codex 依据实拍照片生成写实图，再调用 `adw_prepare_image_upload` 上传，同样要你确认。

为什么不直接让网页版 ChatGPT 连家里服务器：ChatGPT 连 MCP 要公网 HTTPS 地址，得把家里服务器暴露到外网；而且 OpenAI 帮助中心写的是能写入的完整 MCP 只给企业版和教育版，Plus 能不能用，各页面说法不一致（[帮助中心](https://help.openai.com/articles/12584461)、[开发者文档](https://developers.openai.com/api/docs/guides/developer-mode.md)）。Codex 包含在 Plus 里，能聊天也能生图（[Codex 价格说明](https://learn.chatgpt.com/docs/pricing)），装在家里电脑上就能用。

## 参考

- Codex：[Skills](https://developers.openai.com/codex/skills)、[MCP](https://developers.openai.com/codex/mcp)、[登录](https://learn.chatgpt.com/docs/auth)、[命令行非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)
- Qoder：[Rules（`.qoder/rules`，兼容 AGENTS.md）](https://docs.qoder.com/user-guide/rules)
- DeepSeek：[API 文档](https://api-docs.deepseek.com/)
