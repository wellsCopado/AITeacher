# AI Discovery World

给两个孩子（哥哥四年级、妹妹二年级）做数学兴趣课的系统：数学目标优先，包在孩子自己的兴趣里，用写实 3D 互动演示讲清关系，再根据真实作业判断和重教。

- 需求与原则：`docs/产品原则与需求基线_V1.2.docx`、PRD V1.1
- 实施 Spec：AI Discovery World 实施 Spec V1.0（Claude Doc）
- 交互原型：`prototype/ai-discovery-world.html`（单文件，浏览器直接打开）

## 当前进度：M1 核心 Skill 与工具 ✓ · M2 组件与预览 ✓ · M3 服务器、Pad 与家长端 ✓ · M4 作业判断与重教 ✓

| 部分 | 位置 |
| --- | --- |
| LessonSpec / 资产 / 兴趣 Schema | `packages/schema` |
| V01–V23 自动校验、安全公式求值 | `packages/validator` |
| `dls` 命令行（六阶段 + 兴趣记录 + 上下文、AI 出课、MCP） | `packages/cli` |
| 做课核心：上下文、校验、任意大模型写课与自动修改、MCP 工具 | `packages/studio`、`apps/server/src/studio.ts` |
| Skill：discovery-learning-studio | `skills/discovery-learning-studio`（Claude Code、Codex、Qoder 的入口都指向这里；见 `AGENTS.md`） |
| 组件白名单、知识点、资产库、主题表、孩子档案、兴趣记录 | `content/` |
| 示例课 L-PA@1.1（选择、应用、动手题和配图）；样课：哥哥 L-PA@1.0、妹妹 L-ARR@1.0 | `content/lessons/` |
| 写实 3D 组件（PerimeterArea、ArrayMultiplier） | `packages/components` |
| 课程播放器（语言循环、判题、心愿） | `packages/player` |
| `dls preview` 单文件预览、浏览器端到端测试 | `packages/cli/src/preview.ts`、`scripts/e2e-preview.mjs` |
| 家庭服务器（SQLite、PIN 登录、设备配对、当天课程与授权、学习事件） | `apps/server` |
| Pad 轻 App（选孩子、今天的课、断网补传） | `apps/pad` |
| 家长端（排课、临时授权、学习记录、兴趣与心愿、设备） | `apps/parent` |
| 部署说明 | `docs/deploy.md`、`Dockerfile` |
| Skill：homework-analysis（作业识别、判断、重教需求） | `skills/homework-analysis`（`.claude/skills` 已链接） |
| 判断校验 J01–J09、重教换机制 V15 | `packages/validator/src/judgment.ts`、`rules.ts` |
| 作业、判断、掌握状态、重教需求、反馈分源、数据导出与删除 | `apps/server/src/homework.ts`、家长端“作业”“掌握与重教”页 |

## 使用

```
pnpm install
pnpm test                 # 校验器与主题选择的测试
pnpm typecheck
pnpm -s dls help
pnpm -s dls validate content/lessons/L-PA/1.0
pnpm -s dls preview content/lessons/L-PA/1.0   # 生成 preview.html，浏览器打开
pnpm e2e                  # 浏览器里走完两节样课并截图（需要本机 Playwright）
ADW_PIN=2468 pnpm start   # 启动家庭服务器：/pad/ 和 /parent/
pnpm e2e:apps             # 浏览器全流程：配对 → 排课 → 孩子上课（中途断网）→ 家长看记录
pnpm e2e:homework         # 作业闭环：上传照片 → Skill 识别 → 家长核对 → 判断 → 重教需求
pnpm e2e:studio           # 家长端设置大模型、接入 AI 助手、AI 出课、退回后按意见改、和 ChatGPT 商量方案、让 ChatGPT 画图
```

在本仓库里用 Claude Code、Codex 或 Qoder 说“给哥哥做一节课”，会按 Skill 的六个阶段走；说“看看今天的作业”，会用 homework-analysis 识别和判断。换别的大模型、用 MCP 接 AI 助手，见 [docs/agents.md](docs/agents.md)。

## 写实底线

所有 3D 和动画必须写实（BL14）。生物只用扫描、实拍或依据真实照片的 AI 生成素材；还没到位的素材不展示，不用卡通或简化模型代替。校验规则 V13 会拦下违规素材。
