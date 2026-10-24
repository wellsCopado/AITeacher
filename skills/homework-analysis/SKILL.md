---
name: homework-analysis
description: 看孩子的数学作业照片，逐题识别、等家长核对，再写判断记录（事实、可能的缺口、还不知道的、下一课建议、掌握状态、家长卡），需要时触发重教。家长说“看看今天的作业”“判断一下哥哥的作业”“作业传上去了”时使用。
---

# homework-analysis

家长在家长端“作业”页上传照片后，你来识别和判断。判断要帮家长看清事实，不是给孩子下结论。所有读写都通过 `pnpm -s dls homework …`，服务器地址用 `--server` 或环境变量 `ADW_SERVER`，家长 PIN 在环境变量 `ADW_PIN`。

## 硬性约束

- **家长同意才看照片**（BL11）：`dls homework pull` 会检查家长是否勾选了“同意用 AI 识别”。没勾就停下，告诉家长。照片只下载到 `content/homework/`（不进 git），不要转发、不要上传到别处。
- **只写看得到的**：识别时题目、孩子答案、老师批改照抄；看不清就降低 `confidence`（低于 0.8 会标“请核对”），不要猜着补全。
- **家长核对过的题才进判断**：家长改过的题以改后的为准，原识别值服务器会保留。
- **不评价孩子本人、不保证成绩**（BL07）：不写“粗心、马虎、不认真、懒、聪明、天赋”这类词，也不写“保证、一定能、提分”。写行为：“第 3 题面积单位写成了米”。
- **事实、推测分开**（BL08）：事实只写题上能看到的；推测放进 `gaps`，带置信度（一次作业不超过 0.9）、依据的题号和验证方式；不知道的写进 `unknowns`。
- **掌握状态要有对应证据**：课内答对只算“待确认”；真实作业里独立做对才算“有独立应用证据”；做错或半对才能写“需再支持”，并且 `next` 里要有一条对这个知识点的“重教”建议。
- **家长卡是草稿**（BL10）：由家长修改、决定用不用，不自动发给任何人。

判断规则 J01–J09 的解释见 [reference/judgment.md](reference/judgment.md)。

## 步骤

### 1. 找到待识别的作业

```
pnpm -s dls homework list
```

### 2. 下载照片并识别

```
pnpm -s dls homework pull HW-0001
```

逐张查看 `content/homework/HW-0001/` 里的照片，写 `recognition.json`：

```json
{ "homework_ref": "HW-0001", "recognized_by": "homework-analysis",
  "items": [
    { "no": "3", "photo": "p1", "prompt": "一个长方形花坛长 6 米、宽 4 米，面积是多少？",
      "child_answer": "24 米", "teacher_mark": "错", "teacher_note": "单位",
      "confidence": 0.9, "concept_id": "M3.MEAS.perimeter_vs_area",
      "observation": "算式 6×4=24 正确，单位写成了“米”" } ] }
```

- `no` 用作业上的题号；没有题号就按顺序 1、2、3。
- `teacher_mark`：对 / 错 / 半对 / 未批（老师没批就写未批，不要自己判）。
- `concept_id` 用 `content/concepts.json` 里的 id；对不上就写 null，并在交付时告诉家长“这道题的知识点表里还没有”。
- `observation` 只写看到的过程，不写原因。

```
pnpm -s dls homework recognize HW-0001
```

然后告诉家长：识别了几题、哪几题标了“请核对”，请在家长端逐题核对。**等家长核对完再继续。**

### 3. 写判断

```
pnpm -s dls homework draft HW-0001
```

工具按核对后的题写好事实和初步的掌握状态（`judgment.json`）。你补全：

- `gaps`：可能的缺口。用知识点的误区 id（`misconception`），写“可能…”，给置信度、依据题号、验证方式。
- `unknowns`：这次作业看不出来的事。
- `next`：下一课建议，`kind` 是 重教 / 巩固 / 新课 / 观察。重教要写清**换什么表征或教法**。
- `corrects`：如果这次的证据推翻了以前的推测，写 `{ judgment_id, gap, note }`。旧推测会保留并标“已更正”。
- `parent_card`：本次事实 / 孩子愿意分享的 / 还没验证的解释 / 可以这样聊（给家长的一两个开放问题，不追问对错）。

```
pnpm -s dls homework check HW-0001
pnpm -s dls homework submit HW-0001
```

`check` 全部通过才 `submit`。提交后是草稿，家长在家长端确认才生效；家长没确认前你可以改了再 submit。

### 4. 重教

家长确认判断后，“需再支持”的知识点会生成重教需求：

```
pnpm -s dls tickets
```

它会给出开始重教版的命令（`dls init … --previous … --judgment LJ-xxxx`），然后按 discovery-learning-studio 的六个阶段做：目标不变、教法必须换（V10 要求和上一版结构不同，并有 contrast 对比节点；V15 要求同一机制连续 3 次未见效就换机制）。做之前先 `dls sync` 拉回重教历史。

重教课上线后，等下一次真实作业再判断。独立做对了，重教需求自动标“已验证”；还是做错，标“未见效”并生成下一次需求。

## 交付给家长时

用中文、简短：这次作业看到了什么（事实）、可能的原因（标明是推测、怎么验证）、建议下一步、需要家长确认什么。不要贴 JSON 原文。
