# Skill 目录

这里的每个子目录是一份 Skill：普通的 Markdown，不依赖任何一家的模型或工具。先读 `SKILL.md`，再按它的指引读 `reference/`（或 `references/`）里的文件。

| Skill | 做什么 |
| --- | --- |
| `discovery-lesson-maker` | 从一个主题做出整节写实三维探索课（网页课程包，台北101、上海中心那种），家长在「课程库 → 探索课」导入；接 App 先读 `references/app-reference.md` |
| `discovery-learning-studio` | 写一节课（LessonSpec）、校验、交给家长审核；挑战题题型、上课流程、孩子心愿 |
| `photoreal-3d-production` | 找、做、接入、验收写实 3D 素材、场景、动手操作题和课末主持人；先读 `reference/gaps.md` |
| `homework-analysis` | 看作业照片、写判断、触发重教 |

## 各种模型怎么读到

| 用什么 | 怎么读 |
| --- | --- |
| 能打开仓库的 agent（Codex、Claude Code、Qoder、Cursor……） | 直接读这个目录；`AGENTS.md`、`.agents/skills/`、`.claude/skills/`、`.qoder/rules/` 都指向这里 |
| 连 MCP 的 agent | 家里服务器的 `http://<服务器地址>:8787/mcp`，或仓库里 `pnpm -s dls mcp`：`adw_read_skill` 不带参数列出全部，带 `skill`（和可选的 `file`）读内容；做课用 `adw_read_guide` |
| 只能收文字的模型（DeepSeek、通义千问、Kimi、GPT 网页版……） | `pnpm -s dls skill` 列出全部，`pnpm -s dls skill <名称> [<文件>]` 打印出来贴给它；家长端“AI 出一节课”会自动把做课 Skill 作为系统提示发给选中的模型 |

规则只写在这里。别处的入口只指路，不另写一份；不一致时以这里为准。
