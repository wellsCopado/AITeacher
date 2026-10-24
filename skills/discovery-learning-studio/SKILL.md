---
name: discovery-learning-studio
description: 为 AI Discovery World 制作、校验和发布一节数学互动课（LessonSpec）。家长说“给哥哥/妹妹做一节课”“按作业重教”“下一课做机器人主题”等时使用。
---

# discovery-learning-studio

给哥哥（四年级）或妹妹（二年级）做一节以数学为主、包在孩子自己兴趣里的写实 3D 互动课。你只产出配置（LessonSpec JSON），Pad 用已审组件渲染；你不写任何组件代码、脚本或 HTML。

所有落盘和检查都通过仓库根目录的命令行工具完成：`pnpm -s dls <命令>`。不要自己手写校验逻辑，也不要跳过阶段。

## 硬性约束（任何一条不满足都不能发布）

- **数学优先**（BL01）：先定知识点和误区，再选主题。主题只是包装。
- **兴趣来自孩子本人**（BL05）：主题必须引用这个孩子自己的兴趣记录；妹妹不套用哥哥的兴趣。没有可用兴趣时用中性题材（`neutral: true`）。
- **写实底线**（BL14）：所有 3D 和动画写实。生物只能用扫描、实拍或依据真实照片的 AI 生成素材（须 ≥ 3 张参考照片、核对人、标注“AI 依据照片生成”）。素材没到位就写进 `pending_assets`，写明“不展示”，绝不用卡通或简化模型代替。
- **准确可追溯**（BL03）：数值、单位、事实都写出处；不确定的写“待科学审核”，不编造。
- **课末必问心愿**：每节课结束问“下一次课你想学什么”，选项来自这个孩子自己的兴趣或选项，允许自己说一个。
- **不做养殖经营**（BL12），**英语不强制**（BL06），**不开放聊天、不外链**（BL11）。
- **人工审核不可替代**：阶段 6 的四类审核只能由家长确认。只有家长在对话里明确确认某一类后，你才能运行 `dls review --approve <类别> --by <家长称呼>`。

详细原则见 [reference/principles.md](reference/principles.md)。

## 六个阶段

每节课一个目录：`content/lessons/<课程id>/<版本>/`。每个阶段跑完对应命令且通过，才进入下一个阶段。

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

再补全 `02-director.json`：标题、说明页 `intro`、`scene_component_ids`、`component_params`、实验模型（变量范围 + 公式 + 参考算例，必须含越界算例）、活动图、热点（中文 1 条 + 英文 3 条）、≤ 3 道挑战（至少一道不带主题的迁移题）、课末反思问题、评估计划、可选离屏任务、家长提示、出处。每个活动节点和热点都写 `teaches`。字段说明见 [reference/lessonspec.md](reference/lessonspec.md)，组件能力见 [reference/components.md](reference/components.md)，主题映射见 [reference/themes.md](reference/themes.md)。

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

V01–V15 全部无错误才能继续；警告要告诉家长。按每条问题后面的“→”提示修改阶段文件，再从阶段 4 重跑。规则解释见 [reference/validation.md](reference/validation.md)。

### 预览（阶段 5 之后、审核之前）

```
pnpm -s dls preview content/lessons/L-XXX/1.0
```

生成 `preview.html`，浏览器直接打开就能完整走一遍课（写实 3D 场景、热点讲解、挑战判题、课末心愿）。把它发给家长审核时一起看。

### 6. 家长审核与发布

有家里的服务器时（推荐）：

```
pnpm -s dls submit content/lessons/L-XXX/1.0 --server http://<服务器地址>:8787
```

课程进入家长端「课程库」的“等你审核”。家长在那里预览、逐项勾选科学 / 教研 / 语言 / 安全四类审核，点“审核通过并发布”；服务器冻结内容哈希后发布。告诉家长：这节课教什么、主题依据（引用孩子的原话或兴趣记录）、挑战题和答案、还没到位的素材、校验警告。不要贴 JSON 原文。家长退回时，`dls sync` 会显示退回意见；按意见改阶段文件，从阶段 4 重跑，再 `dls submit`。发布后运行 `dls sync`，把已发布的课拉回 `content/published/`。

没有服务器时：

```
pnpm -s dls review content/lessons/L-XXX/1.0 --init
pnpm -s dls review content/lessons/L-XXX/1.0 --approve 科学 --by 家长
pnpm -s dls publish content/lessons/L-XXX/1.0
```

`--approve` 只在家长在对话里明确确认对应类别后运行。发布后文件在 `content/published/<id>@<ver>.lesson.json`，内容哈希固定、只读。要改就升版本号重走流程。

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

用中文、简短：这节课教什么、为什么选这个主题（引用孩子的原话或兴趣记录）、有哪些素材还没到位、需要家长确认什么。不要把 JSON 原文贴给家长。
