# AI Discovery World：给 AI 助手的项目说明

这个仓库给家里两个孩子做以数学为主、包在孩子自己兴趣里的写实 3D 互动课（哥哥四年级、妹妹二年级，上海五四制）。Claude Code、Codex、Qoder、Cursor 等 AI 助手都读这份说明，规则一致。

## 做事之前先读 Skill

| 要做的事 | Skill（唯一来源） |
| --- | --- |
| 做一节课、按作业重教、改家长退回的课 | `skills/discovery-learning-studio/SKILL.md` 和它的 `reference/` |
| 看作业照片、写判断、触发重教 | `skills/homework-analysis/SKILL.md` 和它的 `reference/` |
| 做 3D 场景和组件、给课的主角找或做写实素材、做主持人、替换不达标的画面 | `skills/photoreal-3d-production/SKILL.md` 和它的 `reference/`（先读 `reference/gaps.md`） |

`.agents/skills/`（Codex）、`.claude/skills/`（Claude Code）、`.qoder/rules/`（Qoder）里只放指向上面目录的入口，规则不在那里另写。不能直接读文件夹的模型用 `pnpm -s dls skill` 或 MCP 的 `adw_read_skill` 读，见 `skills/README.md`。

## 项目约定

- 和家长沟通用中文。孩子相关文字适龄、简短。
- 制作课程一律走 `skills/discovery-learning-studio` 的六个阶段，用 `pnpm -s dls` 落盘和校验；不要手改 `content/published/` 下已发布的文件。
- 写实底线 BL14、兴趣来自孩子本人（BL05）、数学优先（BL01）是硬约束。写实的具体规格和验收在 `skills/photoreal-3d-production`：复杂物体（机器、机器人、动物、人、建筑）只能来自素材文件或视频，不能在代码里用几何体拼。
- 改了校验规则或 Schema，同时更新 `test/` 并跑 `pnpm test` 和 `pnpm typecheck`。
- 发布只能由家长在家长端「课程库」点按钮完成。`dls review --approve` 只在家长明确确认对应类别后运行。AI 助手没有发布权限，也不要想办法绕过。
- 看作业、写判断一律走 `skills/homework-analysis`，用 `pnpm -s dls homework …`；家长没勾选“同意 AI 识别”的作业不看照片，照片只放 `content/homework/`（不进 git）。
- 判断只写看得到的事实；推测带置信度和验证方式；不评价孩子本人、不保证成绩（J03）。判断由家长在家长端确认才生效。
- 孩子的真实姓名、作业照片、学习记录、孩子的原话，不发给任何外部模型或网站。

## 常用命令

```
pnpm install                         # 第一次
pnpm -s dls context --child gege     # 做课需要的上下文：兴趣、可用组件、建议主题、新课 id
pnpm -s dls design --child gege      # 给 ChatGPT 等聊天模型的设计说明（谈好的【课程方案】再交给 dls generate --wish）
pnpm -s dls validate <课目录>        # 校验 V01–V20
pnpm -s dls skill [<名称> [<文件>]]  # 读任意一份 Skill（不写名称时列出全部）
pnpm -s dls mcp                      # 以 MCP（stdio）提供做课工具
pnpm test && pnpm typecheck          # 改代码后
```

连家里的服务器：环境变量 `ADW_SERVER=http://<服务器地址>:8787`，加上家长端「设备与数据 → AI 助手接入」生成的 `ADW_TOKEN`（只能交课给家长审核）。接入方式见 `docs/agents.md`。
