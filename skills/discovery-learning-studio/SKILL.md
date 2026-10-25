---
name: discovery-learning-studio
description: 为 AI Discovery World 制作、校验并交给家长审核一节数学互动课（LessonSpec）。家长说“给哥哥/妹妹做一节课”“按作业重教”“下一课做机器人主题”“看看家长退回的课”等时使用。
---

# discovery-learning-studio

给哥哥（四年级）或妹妹（二年级）做一节以数学为主、包在孩子自己兴趣里的写实 3D 互动课。你只产出配置（LessonSpec JSON，写成三份阶段文件），Pad 用已审组件渲染；你不写任何组件代码、脚本或 HTML。

这份 Skill 是做课规则的唯一来源：`skills/discovery-learning-studio/`。谁来做课都用它——Claude Code、Codex、Qoder、Cursor 等 AI 助手，家长端的“AI 出一节课”（DeepSeek、通义千问、Kimi、GPT、Claude、本机 Ollama 等任意大模型），以及在终端里做课的人。规则只写在这里，不要在别处另写一份。

## 硬性约束（任何一条不满足都不能发布）

- **数学优先**（BL01）：先定知识点和误区，再选主题。主题只是包装。
- **家长说了算，其次是孩子本人的兴趣**（BL05）：家长指定给哪个孩子、做什么主题，就照做（系统会给这个孩子记一条“家长指定”的兴趣记录，`suggested_theme` 就是它）。家长没指定时，主题引用这个孩子自己的兴趣记录；不拿另一个孩子的兴趣套用。都没有时用中性题材（`neutral: true`）。
- **主题讲的东西要看得到**（V19）：主题里的动物、机器人、大桥等是这节课的主角（`theme.subject`）。现成 3D 场景里没有它时，从 `themes_ready` 选最接近它真实环境的场景，主角列进 `pending_assets`，由系统自动做成写实图片或 3D（或家长上传照片），家长确认后才能发布。绝不拿别的东西冒充：不用积木冒充机器人，不用螳螂虾冒充别的动物，也不能只在文字里提到它。机器人、机械臂、工厂的乘法课用 ArrayMultiplier 的 `robot_factory`（真实尺寸的工业机械臂一行一行摆齿轮）。
- **资料不全也不停下**：课内进度看上下文 `school`；家长没填就按年级和日期推断，在 `parent_tip` 里写明“推断”。不要停下来问家长要教材、“沪学习”的单元或别的资料。
- **写实底线**（BL14）：所有 3D 和动画写实。生物只能用扫描、实拍或依据真实照片的 AI 生成素材（须 ≥ 3 张参考照片、核对人、标注“AI 依据照片生成”）。素材没到位就写进 `pending_assets`，写明“不展示”，绝不用卡通或简化模型代替。
- **准确可追溯**（BL03）：数值、单位、事实都写出处；不确定的写“待科学审核”，不编造。数字自己算一遍，参考算例必须和公式一致。
- **课末必问心愿**：每节课结束问“下一次课你想学什么”，选项来自这个孩子自己的兴趣或选项，允许自己说一个。
- **讲解固定“一中三英”**（V05）：每个热点中文 1 条 + 英文 3 条循环讲，没有纯中文选项。英文只用于讲解，不考英语（BL06）。
- **上课流程固定**：四步按顺序解锁、每步每题有倒计时、到时间自动前进、文字自动出字幕并朗读。流程在播放器里，你要把说明、题目、提示写得短、适合读出来。
- **夸奖要具体、给孩子信心**（V18）：答错时先夸真正做对的部分，再说要看哪里，再给坚持的理由。写 `encouragement.persist`，和主题相连，不写空话。
- **错三次先演示、再做同类题**（V17）：每道题都写 `worked_example`（2–5 步，最后一步说出答案）和 `twin`（同一方法换数字或情境）。
- **不做养殖经营**（BL12），**不开放聊天、不外链**（BL11）。
- **人工审核不可替代**：发布只能由家长在家长端「课程库」点按钮完成。没有服务器时，只有家长在对话里明确确认某一类后，才能运行 `dls review --approve <类别> --by <家长称呼>`。

详细原则见 [reference/principles.md](reference/principles.md)；孩子上课的固定流程、夸奖和演示怎么写，见 [reference/lesson-flow.md](reference/lesson-flow.md)（阶段 2 之前必读）。

## 绝对不要做

- 不发布、不审核通过、不替家长勾审核项；不改 `content/published/` 下已发布的文件（要改就升版本号）。
- 不覆盖示例课 `content/lessons/L-PA/1.0`、`L-ARR/1.0` 和已发布的课。新课一律用上下文里给的新课 id（`new_lesson_id`）。
- 不为了通过校验去改校验器、Schema、组件或资产库；问题出在课里就改课。
- 不编素材：`assets.use` 只用资产库里登记过、状态为“采用”或“采用标记”的素材 id；主角和还没做好的素材写进 `pending`。
- 不把孩子的真实姓名、作业照片、学习记录、孩子的原话发给任何模型或网站。做课只需要年级、称呼（哥哥 / 妹妹）和兴趣主题。
- 不给家长贴 JSON 原文，不让家长去敲命令。

## 开始前：拿到这个孩子的上下文

做课需要的信息一次给全：年级、课内进度（`school`）、家长指定的主题、这个孩子自己的兴趣和下一课心愿、可用 3D 组件（参数范围、热点锚点、动作）、建议主题和课末心愿题、能用的素材、新课 id、必须原样使用的固定字段（`fixed`）。

```
pnpm -s dls context --child gege          # 人看的摘要
pnpm -s dls context --child gege --json   # 完整内容
```

通过 MCP 时用 `adw_get_context`（见下面“三种做课方式”）。

照着示例课 `content/lessons/L-PA/1.0/` 的结构写（字段、层级、类型一样），内容为这个孩子新写，不抄示例的题目和讲解。

## 六个阶段

每节课一个目录：`content/lessons/<课程id>/<版本>/`。每个阶段跑完对应命令且通过，才进入下一个阶段。

| 阶段 | 产出 | 命令 | 通过的标准 |
| --- | --- | --- | --- |
| 1 目标锁定 | `01-target.json` | `dls init`、`dls target` | 知识点在 `content/concepts.json` 里；误区 ≤ 3；教材映射没核对就是“参考·待核对” |
| 2 导演设计 | `02-director.json` | `dls theme --write` | 主题引用这个孩子的兴趣；每道题有演示和同类题；有 `encouragement.persist`；课末有心愿题 |
| 3 素材核验 | `03-assets.json` | `dls assets` | 只用登记过的素材；没到位的在 `pending` 里写“不展示” |
| 4 组装 | `lessonspec.json` | `dls assemble` | 能组装，没有未登记素材 |
| 5 自动校验 | `05-validation.json` | `dls validate`、`dls preview` | V01–V19 没有错误；警告告诉家长 |
| 6 家长审核 | 家长端「课程库 → 等你审核」 | `dls submit` | 家长看过、勾完四类审核、点发布（只有家长能做） |

### 1. 目标锁定 → `01-target.json`

```
pnpm -s dls init L-XXX 1.0 --child gege
# 重教：pnpm -s dls init L-PA 1.1 --child gege --previous 1.0 --judgment LJ-0001
```

填写主知识点（`content/concepts.json` 里的 id）、≤ 3 个误区、前置知识点、教材映射状态（没核对就用“参考·待核对”）。然后：

```
pnpm -s dls target content/lessons/L-XXX/1.0
```

### 2. 导演设计 → `02-director.json`

先让工具按兴趣建议主题和课末心愿问题：

```
pnpm -s dls theme content/lessons/L-XXX/1.0 --component PerimeterArea --write
```

把建议告诉家长；家长可以改。工具提示“待开发”的主题皮肤，要转告家长需要开素材工单，这节课先用可用的主题。

再补全 `02-director.json`：标题、说明页 `intro`、`scene_component_ids`、`component_params`、实验模型（变量范围 + 公式 + 参考算例，必须含越界算例）、活动图、热点（中文 1 条 + 英文 3 条）、≤ 3 道挑战（至少一道不带主题的迁移题；**每道题都带分步演示 `worked_example` 和同类题 `twin`**；题目里写清“几行、每行几个”或“长、宽”，播放器按这些数用课里的 3D 场景给每道题配图）、答错时的鼓励 `encouragement.persist`、课末反思问题、评估计划、可选离屏任务、家长提示、出处。每个活动节点和热点都写 `teaches`。字段说明见 [reference/lessonspec.md](reference/lessonspec.md)，组件能力见 [reference/components.md](reference/components.md)，主题映射见 [reference/themes.md](reference/themes.md)。

### 3. 素材检索核验 → `03-assets.json`

只引用 `content/assets/registry.json` 里状态为“采用”或“采用标记”的素材。新素材先登记（来源、许可、可商用、真实尺寸、写实等级、核对人），许可不清楚的直接拒绝。

```
pnpm -s dls assets content/lessons/L-XXX/1.0
```

### 4. 组装 → `lessonspec.json`

```
pnpm -s dls assemble content/lessons/L-XXX/1.0
```

### 5. 自动校验 → `05-validation.json`

```
pnpm -s dls validate content/lessons/L-XXX/1.0
```

V01–V19 全部无错误才能继续；警告要告诉家长。按每条问题后面的“→”提示修改阶段文件，再从阶段 4 重跑。规则解释见 [reference/validation.md](reference/validation.md)。

### 预览（阶段 5 之后、审核之前）

```
pnpm -s dls preview content/lessons/L-XXX/1.0
```

生成 `preview.html`，浏览器直接打开就能完整走一遍课（写实 3D 场景、热点讲解、挑战判题、课末心愿）。

### 6. 家长审核与发布

有家里的服务器时（推荐）：

```
pnpm -s dls submit content/lessons/L-XXX/1.0 --server http://<服务器地址>:8787
```

课程进入家长端「课程库」的“等你审核”。家长在那里预览、逐项勾选科学 / 教研 / 语言 / 安全四类审核，点“审核通过并发布”；服务器冻结内容哈希后发布。告诉家长：这节课教什么、主题依据（引用孩子的兴趣记录）、挑战题和答案、还没到位的素材、校验警告。发布后运行 `dls sync`，把已发布的课拉回 `content/published/`。

没有服务器时：

```
pnpm -s dls review content/lessons/L-XXX/1.0 --init
pnpm -s dls review content/lessons/L-XXX/1.0 --approve 科学 --by 家长
pnpm -s dls publish content/lessons/L-XXX/1.0
```

`--approve` 只在家长在对话里明确确认对应类别后运行。发布后文件在 `content/published/<id>@<ver>.lesson.json`，内容哈希固定、只读。要改就升版本号重走流程。

## 家长退回的课

家长在「课程库」退回时会写一句意见。修改时 id 和版本不变，只按意见改，没提到的地方保持原样，改完从阶段 4 重跑并重新提交。

- 命令行：`dls sync` 显示退回意见；改阶段文件，`dls assemble`、`dls validate`，再 `dls submit`。
- MCP：`adw_list_lessons` 里状态为“已退回”、`note` 是意见；`adw_get_lesson` 取回三部分，改好后 `adw_check_lesson`，通过再 `adw_submit_for_review`。
- 家长端：退回的课上有“让 AI 按意见改”按钮，用当前选中的大模型改。

## 三种做课方式（同一套规则、同一个校验器）

1. **在仓库里用命令行**（Claude Code、Codex、Qoder、Cursor，或人自己）：按上面六个阶段用 `pnpm -s dls`。交给家长审核需要环境变量 `ADW_SERVER`（家里服务器地址）和 `ADW_TOKEN`（家长端“AI 助手接入”生成的令牌）或 `ADW_PIN`。
2. **通过 MCP**（不需要仓库，连家里的服务器 `http://<服务器地址>:8787/mcp`，令牌放在 `Authorization: Bearer …`；或在仓库里运行 `pnpm -s dls mcp` 走 stdio）：
   1. `adw_read_guide`（topic=all）读这份 Skill；
   2. `adw_get_context` 拿孩子的上下文；
   3. `adw_get_example` 看一节完整的示例课；
   4. 写 `target` / `director` / `assets` 三部分，`adw_check_lesson` 校验，按每条问题的 `fix` 改到没有错误；
   5. `adw_submit_for_review` 交给家长审核。没有发布工具。
3. **家长端一键出课**：「课程库 → AI 出一节课」，或命令行 `dls generate --child gege [--wish "…"]`（模型用环境变量 `ADW_LLM_PROVIDER`、`ADW_LLM_API_KEY`、`ADW_LLM_MODEL`、`ADW_LLM_BASE_URL` 设置）。这份 Skill 会作为模型的系统提示，校验问题自动发回给模型修改，最多 4 轮。

## 一个模型谈方案、另一个模型做课

可以让云端聊天模型（ChatGPT、Codex 里的 GPT 等）先和家长谈方案、出图，再交给家长配置的模型（例如 DeepSeek）按这份 Skill 做成完整的课：

- **在家长端谈**：家长在「AI 出一节课 → 和 AI 商量方案」里直接和模型（通常是家长的 ChatGPT 账号，服务器在后台调用 Codex）聊，设计说明就是这段对话的系统提示；谈定后模型输出 `【课程方案】`，家长点“用这个方案写课”交给写课模型。
- **设计说明**：`dls design --child gege`，或家长端「AI 出一节课 → 复制设计说明」。里面有孩子的年级、兴趣、可用 3D 组件和参数范围、规则摘要和方案格式（开头是 `【课程方案】`），不含姓名和隐私。
- **方案交给做课模型**：方案全文作为要求传进去：家长端粘到「AI 出一节课」的框里；MCP 用 `adw_write_with_model`（`adw_job_status` 看进度）；命令行 `dls generate --child gege --wish "<方案全文>"`。方案和本 Skill 冲突时以 Skill 为准，组件、参数、主题、素材以上下文为准，改了什么写进 `parent_tip`。
- **图片**：只能是写实图。AI 生成的生物图要依据至少 3 张实拍照片，写清参考来源。通过 MCP 用 `adw_prepare_image_upload` 拿一次性地址上传；或家长在「生物素材」点“让 ChatGPT 依据实拍照片画一张”（要先有 3 张实拍或标本照片）。课的主角是动物时，服务器会自动让 ChatGPT 找实拍照片并画一张正上方俯视、头朝左的写实图，场景自动把它做成会动的 3D（不需要你做模型）。都进「生物素材」等家长确认，确认前孩子看不到。

## 校验常见错误和改法

| 报错 | 原因 | 改法 |
| --- | --- | --- |
| S00 资产库里没有… | `assets.use` 写了没登记的素材 | 只用上下文 `assets` 里“采用 / 采用标记”的 id；没到位的写进 `pending` |
| V01 参数超出范围 | `component_params` 不符合组件的 `params_schema` | 按上下文里组件的参数范围收窄 |
| V02 参考算例不对 | 期望值算错，或没有越界算例 | 重新算；补一条 `expect: reject_out_of_range` |
| V03 teaches 不合法 | 引用了别的知识点 | 只引用主知识点、它的误区或前置知识点 |
| V05 讲解不是 1 中 3 英 | 某个热点英文不足 3 条，或关了循环 | 每个热点英文写满 3 条，`cycle_enabled: true` |
| V09 没有迁移题 | 所有题都带主题 | 至少一道 `with_theme: false`，并加 transfer 节点 |
| V14 兴趣或心愿不对 | 主题没引用这个孩子的兴趣、心愿题不对 | 主题用上下文的 `suggested_theme`，心愿题原样用 `wish_question` |
| V17 演示或同类题不全 | 少 `worked_example` / `twin`，或最后一步没说出全部答案 | 2–5 步，最后一步写出所有答案的数值；`twin` 的 `field` 和原题一致 |
| V18 坚持的理由不够 | `encouragement.persist` 少于 2 句或是空话 | 写 2–5 句和主题相连的话 |

## 课后：记录孩子的心愿

孩子在 Pad 课末说的心愿会自动记到服务器。做下一节课的阶段 2 之前先同步回来：

```
pnpm -s dls sync --server http://<服务器地址>:8787
```

没有服务器时，由家长转述后手动记：

```
pnpm -s dls interest add --child gege --topic 机器人 --source 孩子自述 --state 下一课心愿 --lesson L-PA@1.0
```

下一节课的阶段 2 会优先用它。

## 交付给家长时

用中文、简短：这节课教什么、为什么选这个主题（引用孩子的兴趣记录）、有哪些素材还没到位、需要家长确认什么。不要把 JSON 原文贴给家长。

审核和发布都在家长端「课程库」里点按钮完成，不要让家长去敲命令。
