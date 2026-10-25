# LessonSpec 1.0 字段说明

Schema：`packages/schema/schemas/lessonspec.schema.json`（以它为准）。阶段文件与字段的对应关系：

| 阶段文件 | 字段 |
| --- | --- |
| `01-target.json` | lesson_id, version, tenant_id, for_child, previous_version, trigger_judgment_ref, primary_concept, prerequisites, curriculum_mapping, learner_profile |
| `02-director.json` | title, intro, theme, scene_component_ids, component_params, experiment_model_version, activity_graph, hotspots, challenges, encouragement, end_chat, assessment_plan, offscreen, parent_tip, source_refs, timing（可选） |
| `03-assets.json` | `use`（资产 id 列表）、`pending`（待采购）、`scope`（family / commercial） |

`dls assemble` 会从资产库带入素材的许可、写实等级等信息，并生成 `distribution`。

## 写作要点

- **title**：2–40 字，孩子看得懂，带主题，例如“珊瑚礁海底调查：螳螂虾的家有多大”。
- **intro**：说明页，`headline` 一句 + 1–3 段 + 可选 `note`（如“只观察和测量”、素材未到位的说明）。
- **component_params**：以组件名为键，例如 `{"PerimeterArea": {"a": 6, "b": 4, "theme": "reef"}}`。
- **experiment_model_version**：`outputs.*.expr` 只能用数字、变量、`+ - * /` 和括号。参考算例至少 3 条合法 + 1 条 `expect: reject_out_of_range`。
- **activity_graph.type**：explain / demo / contrast / predict / transfer / chat。重教版必须有 contrast。
- **hotspots**：`anchor` 必须是组件提供的锚点；`facts` 每条写出处，不确定写“待科学审核”。
- **challenges**：2–3 道；以选择题和应用题为主，组件支持动手题（`dls context` 里 `hands_on` 不为空）时至少 1 道动手题 `task`，没有 `options` 也没有 `task` 的填空题最多 1 道（题型怎么写见 [challenge-types.md](challenge-types.md)）；`with_theme: false` 的题用于迁移；`answers.value` 可以是数字或文字；选择题加 `options`，值和答案一字不差。每道题还要写：
  - `worked_example.steps`：孩子错 3 次后 Pad 一步步演示（字幕 + 朗读）。2–5 步，最后一步说出全部答案。
  - `twin`：演示后孩子自己做的同类题，`{ prompt, answers, options?, task? }`；原题是动手题时同类题也写 `task`。同一方法换数字或情境，`field` 和原题一致。

  ```json
  {
    "id": "c1", "prompt": "新的调查区长 5 米、宽 3 米。拉一圈卷尺要多少？铺满要几个 1 平方米的样方？",
    "answers": [{ "field": "P", "label": "卷尺", "value": 16, "unit": "米" }, { "field": "S", "label": "样方", "value": 15, "unit": "平方米" }],
    "worked_example": { "steps": ["卷尺沿着四条边走一圈：5 + 3 + 5 + 3。", "加起来是 16，量的是长度，单位用“米”。", "样方一行 5 个，一共 3 行：5 × 3 = 15。", "所以卷尺要 16 米，样方要 15 个，也就是 15 平方米。"] },
    "twin": { "prompt": "另一块调查区长 6 米、宽 2 米。拉一圈卷尺要多少？铺满要几个 1 平方米的样方？",
              "answers": [{ "field": "P", "label": "卷尺", "value": 16, "unit": "米" }, { "field": "S", "label": "样方", "value": 12, "unit": "平方米" }] }
  }
  ```
- **encouragement.persist**：2–5 句，孩子答错时给他坚持下去的理由，和主题相连，例如“螳螂虾的洞也是一点一点挖出来的，我们再挖深一点！”。夸奖本身由播放器根据孩子真正做对的部分自动生成，你不用写。
- **timing.steps**（可选）：`{ explain, demo, challenge, chat }` 秒数；不写就按 `est_minutes` 自动分配。
- **end_chat**：`skippable: true`；必须有一条 `kind: next_lesson_wish`（用 `dls theme --write` 生成），`allow_own_words: true`。
- **offscreen**：可选，必须 `optional: true`；需要大人陪同的写 `adult: true`。
