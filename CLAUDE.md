# 项目约定

- 和家长沟通用中文。孩子相关文字适龄、简短。
- 制作课程一律走 `skills/discovery-learning-studio` 的六个阶段，用 `pnpm -s dls` 落盘和校验；不要手改 `content/published/` 下已发布的文件。
- 写实底线 BL14、兴趣来自孩子本人（BL05）、数学优先（BL01）是硬约束。
- 改了校验规则或 Schema，同时更新 `test/` 并跑 `pnpm test` 和 `pnpm typecheck`。
- `dls review --approve` 只在家长明确确认对应类别后运行。
- 看作业、写判断一律走 `skills/homework-analysis`，用 `pnpm -s dls homework …`；家长没勾选“同意 AI 识别”的作业不看照片，照片只放 `content/homework/`（不进 git）。
- 判断只写看得到的事实；推测带置信度和验证方式；不评价孩子本人、不保证成绩（J03）。判断由家长在家长端确认才生效。
