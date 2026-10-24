# AI Discovery World

给两个孩子（哥哥四年级、妹妹二年级）做数学兴趣课的系统：数学目标优先，包在孩子自己的兴趣里，用写实 3D 互动演示讲清关系，再根据真实作业判断和重教。

- 需求与原则：`docs/产品原则与需求基线_V1.2.docx`、PRD V1.1
- 实施 Spec：AI Discovery World 实施 Spec V1.0（Claude Doc）
- 交互原型：`prototype/ai-discovery-world.html`（单文件，浏览器直接打开）

## 当前进度：M1 核心 Skill 与工具 ✓ · M2 组件与预览 ✓ · M3 服务器、Pad 与家长端 ✓

| 部分 | 位置 |
| --- | --- |
| LessonSpec / 资产 / 兴趣 Schema | `packages/schema` |
| V01–V14 自动校验、安全公式求值 | `packages/validator` |
| `dls` 命令行（六阶段 + 兴趣记录） | `packages/cli` |
| Skill：discovery-learning-studio | `skills/discovery-learning-studio`（`.claude/skills` 已链接） |
| 组件白名单、知识点、资产库、主题表、孩子档案、兴趣记录 | `content/` |
| 样课：哥哥 L-PA@1.0、妹妹 L-ARR@1.0 | `content/lessons/` |
| 写实 3D 组件（PerimeterArea、ArrayMultiplier） | `packages/components` |
| 课程播放器（语言循环、判题、心愿） | `packages/player` |
| `dls preview` 单文件预览、浏览器端到端测试 | `packages/cli/src/preview.ts`、`scripts/e2e-preview.mjs` |
| 家庭服务器（SQLite、PIN 登录、设备配对、当天课程与授权、学习事件） | `apps/server` |
| Pad 轻 App（选孩子、今天的课、断网补传） | `apps/pad` |
| 家长端（排课、临时授权、学习记录、兴趣与心愿、设备） | `apps/parent` |
| 部署说明 | `docs/deploy.md`、`Dockerfile` |

后续：M4 作业判断与重教。

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
```

在本仓库里用 Claude Code 说“给哥哥做一节课”，会按 Skill 的六个阶段走。

## 写实底线

所有 3D 和动画必须写实（BL14）。生物只用扫描、实拍或依据真实照片的 AI 生成素材；还没到位的素材不展示，不用卡通或简化模型代替。校验规则 V13 会拦下违规素材。
