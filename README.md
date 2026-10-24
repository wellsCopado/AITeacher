# AI Discovery World

给两个孩子（哥哥四年级、妹妹二年级）做数学兴趣课的系统：数学目标优先，包在孩子自己的兴趣里，用写实 3D 互动演示讲清关系，再根据真实作业判断和重教。

- 需求与原则：`docs/产品原则与需求基线_V1.2.docx`、PRD V1.1
- 实施 Spec：AI Discovery World 实施 Spec V1.0（Claude Doc）
- 交互原型：`prototype/ai-discovery-world.html`（单文件，浏览器直接打开）

## 当前进度：M1 核心 Skill 与工具

| 部分 | 位置 |
| --- | --- |
| LessonSpec / 资产 / 兴趣 Schema | `packages/schema` |
| V01–V14 自动校验、安全公式求值 | `packages/validator` |
| `dls` 命令行（六阶段 + 兴趣记录） | `packages/cli` |
| Skill：discovery-learning-studio | `skills/discovery-learning-studio`（`.claude/skills` 已链接） |
| 组件白名单、知识点、资产库、主题表、孩子档案、兴趣记录 | `content/` |
| 样课：哥哥 L-PA@1.0、妹妹 L-ARR@1.0 | `content/lessons/` |

后续：M2 组件库与预览，M3 服务器、Pad 与家长端，M4 作业判断与重教。

## 使用

```
pnpm install
pnpm test                 # 校验器与主题选择的测试
pnpm typecheck
pnpm -s dls help
pnpm -s dls validate content/lessons/L-PA/1.0
```

在本仓库里用 Claude Code 说“给哥哥做一节课”，会按 Skill 的六个阶段走。

## 写实底线

所有 3D 和动画必须写实（BL14）。生物只用扫描、实拍或依据真实照片的 AI 生成素材；还没到位的素材不展示，不用卡通或简化模型代替。校验规则 V13 会拦下违规素材。
