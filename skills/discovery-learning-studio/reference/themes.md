# 兴趣 → 主题 → 场景

映射表：`content/themes.json`；兴趣记录：`content/interests.json`；孩子档案：`content/children.json`。

选择顺序：家长指定 > 这个孩子的“下一课心愿” > “近期最喜欢” > “喜欢”，同级取最新。家长在「主题」框里写的，或者在要求里说的（“写一个蟋蟀的课程”“用大桥做主题”），都算家长指定。

## 场景只讲它画着的东西（V27）

每个现成场景画了什么，写在 `themes.json` 的 `depicts` 里，上下文 `themes_ready[].depicts` 也有。一节参数课只能讲这些东西：

| 场景 | 组件 | 画着的东西（`depicts`） | 状态 |
| --- | --- | --- | --- |
| reef 珊瑚礁样方调查 | PerimeterArea | 螳螂虾、珊瑚礁、珊瑚、海底 | 已有 |
| garden 花园围栏与铺砖 | PerimeterArea | 花园、院子、栅栏、围栏、地砖 | 已有（也是中性题材） |
| blocks 积木方块 | ArrayMultiplier | 积木 | 已有（中性题材） |
| robot_factory 机器人工厂 | ArrayMultiplier | 机器人工厂、机械臂、齿轮、工厂 | 已有，写实版制作中，替换前不发布 |

主题能不能用某个场景，系统这样判断（`scenesShowing`）：

1. 找出主题里提到的已知东西：`habitats` 的词、各场景的 `depicts`、`topics` 的键，长的优先。
2. 只有每一个都在这个场景的 `depicts` 里（或是其中某样的一种，比如孔雀螳螂虾是一种螳螂虾），才算场景画着它。

| 主题 | 用哪个场景 |
| --- | --- |
| 螳螂虾、孔雀螳螂虾、螳螂虾和海底 | reef |
| 工厂里的机械臂、机器人工厂 | robot_factory |
| 积木 | blocks |
| 火箭发射、蜜蜂、火山、蟋蟀、博比特虫、金鱼、大桥 | 没有：做成探索课 |
| 花园里的蜜蜂 | 没有：花园画着，蜜蜂没画，做成探索课 |
| 机器人 | 没有：家长说的机器人是完整的人形机器人，不是机械臂，做成探索课 |

主角住在哪里（`habitats`）不够：花园是蟋蟀住的地方，可画面上只有栅栏和地砖，没有蟋蟀，所以蟋蟀也做成探索课。

家长指定的主题或孩子的心愿，场景画的不是它时，系统不写参数课，自动交给家里 Mac 上的 ChatGPT（Codex）做成探索课。Codex 按 `skills/discovery-lesson-maker` 和它的 [主题与素材](../../discovery-lesson-maker/references/topic-assets.md) 五步，自己建场景、做每一张图。主题框、要求、课程方案、退回意见里的“改成X”、心愿准备单都一样。没有 ChatGPT 账号或没勾同意时，系统直接说明原因，不写进旧场景。

中性题材（没有主角）：PerimeterArea 用 garden，ArrayMultiplier 用 blocks。

`topics` 表记的是还在开发的专门场景（草地昆虫样方、楼层平面、隧道检修通道、扫地机器人）。它们做好、`status` 改成“已有”并写上 `depicts` 之前，不会被用。

## 加一个新的场景

- 新场景做好后，在 `skins` 里写上 `habitat`、`shows`、`words`、`depicts`（它画着的东西，就是能讲的主题），`status` 改成“已有”。
- `depicts` 只写画面上真有的东西。写进去的每个词，都意味着讲它的课会用这个场景。

同一主题连续 3 节后，工具会提示在心愿问题里鼓励换一个，但孩子可以继续选。
