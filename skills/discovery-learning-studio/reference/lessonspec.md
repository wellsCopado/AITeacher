# LessonSpec 1.0 字段说明

Schema：`packages/schema/schemas/lessonspec.schema.json`（以它为准）。阶段文件与字段的对应关系：

| 阶段文件 | 字段 |
| --- | --- |
| `01-target.json` | lesson_id, version, tenant_id, for_child, previous_version, trigger_judgment_ref, primary_concept, prerequisites, curriculum_mapping, learner_profile |
| `02-director.json` | title, theme, scene_component_ids, component_params, experiment_model_version, activity_graph, hotspots, challenges, end_chat, assessment_plan, offscreen, parent_tip, source_refs |
| `03-assets.json` | `use`（资产 id 列表）、`pending`（待采购）、`scope`（family / commercial） |

`dls assemble` 会从资产库带入素材的许可、写实等级等信息，并生成 `distribution`。

## 写作要点

- **title**：2–40 字，孩子看得懂，带主题，例如“珊瑚礁海底调查：螳螂虾的家有多大”。
- **component_params**：以组件名为键，例如 `{"PerimeterArea": {"a": 6, "b": 4, "theme": "reef"}}`。
- **experiment_model_version**：`outputs.*.expr` 只能用数字、变量、`+ - * /` 和括号。参考算例至少 3 条合法 + 1 条 `expect: reject_out_of_range`。
- **activity_graph.type**：explain / demo / contrast / predict / transfer / chat。重教版必须有 contrast。
- **hotspots**：`anchor` 必须是组件提供的锚点；`facts` 每条写出处，不确定写“待科学审核”。
- **challenges**：≤ 3 道；`with_theme: false` 的题用于迁移；`answers.value` 可以是数字或文字选项。
- **end_chat**：`skippable: true`；必须有一条 `kind: next_lesson_wish`（用 `dls theme --write` 生成），`allow_own_words: true`。
- **offscreen**：可选，必须 `optional: true`；需要大人陪同的写 `adult: true`。
