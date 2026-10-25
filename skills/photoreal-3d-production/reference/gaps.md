# 现状和要替换的东西（2026-10-25）

动手前先读这一页。按优先级排；每一项做完，在这里把状态改成“已替换”，写上提交号。

## P0：家长已判定不合格，必须先换

| 编号 | 现在是什么 | 问题 | 换成什么 | 状态 |
| --- | --- | --- | --- | --- |
| G1 | `packages/components/src/robot-cell.js`：ArrayMultiplier 的 `robot_factory` 皮肤，代码拼的六轴机械臂、吸盘夹具、传送带、转台、齿轮（资产 `M-robot-cell`） | 家长判定“动画类型的，不是写实的”。圆柱和方块拼的，违反红线 1 | 真实型号工业机械臂的 CAD 模型 + 真实夹具 + 真实传送带和工件，按 [realism-spec.md](realism-spec.md) 3.1；运动按这个型号的真实运动学和速度。保留现在的接口：一行一行摆（`reveal`）、转 90°（`rotate`）、锚点 `row` `col` `total`、`still()` | 待替换 |
| G2 | `packages/components/src/host.js`：课末聊聊的接待机器人，代码拼的 | 家长判定“动画类型的，效果很差”。球体、胶囊拼的身体和“眼睛” | 按 [host.md](host.md) 做 H1 真人视频主持（默认）或 H2 真实机器人视频 | 待替换 |
| G3 | `organism.js`（螳螂虾，手工关节）和 `organism-chain.js`（新动物，自动切节）：用一张俯视图做成 2.5D 浮雕 | 只有从正上方看才像；侧面看是扁的；动作是程序摆动，没有真实视频依据 | 真三维动物：标本扫描，或依据 ≥ 3 张不同角度实拍生成后修整，骨骼绑定，动作依据真实视频（realism-spec.md 3.3）。服务器现有的“让 ChatGPT 找实拍照片”可以留作找参考照片的第一步 | 过渡中 |

替换完成前：

- 用 G1 的课（主题机器人、机械臂、工厂）不发布；家长预览时在场景角上标“写实版制作中”。
- G2 替换前，聊聊页不显示主持人，回到文字 + 字幕 + 朗读（播放器里 `mountHost` 的调用先关掉）。
- G3 只在俯视镜头下展示；需要侧面或特写时，改为显示登记过的实拍照片或视频。

## P1：规格要求、现在没有

| 编号 | 要做的 | 依据 |
| --- | --- | --- |
| G4 | 测量轮（`engine.js` 的 `buildWheel`）和卷尺盘是代码拼的工具，换成真实产品的模型文件 | realism-spec.md 第 1 节 |
| G5 | 地面贴图：`T-sand-ripples` 是程序生成的，`T-grass`、`T-wood` 来源许可没核实；换成扫描贴图（ambientCG、Poly Haven，CC0） | realism-spec.md 第 2 节；V11 |
| G6 | 挑战配图改成显式字段 `challenges[].picture` 和 `still(params, view)`，不再从题目文字里猜数 | pipeline.md P6 |
| G7 | 写 A5 代码几何检查和白名单、`dls asset-check`、`dls asset-sheet` | acceptance.md A、B |
| G8 | 大素材的存放和加载：不再写进 `assets.js`；服务器按资产 id 提供文件，Pad 缓存，核对 sha256 | asset-sourcing.md 第 3 节 |
| G9 | 场景清单 `scene_bill`：Schema、校验、写课规则、素材流程按清单逐项解析 | pipeline.md P3 |
| G10 | 家长端：课的预览和它的素材对照图放在一处确认；选择主持人（真人 / 机器人）、上传或录制主持人视频、同意记录 | pipeline.md P8；host.md |
| G15 | 动手操作题：摆一摆（`build`）已做，PerimeterArea 和 ArrayMultiplier 能用，校验 V21，做课 Skill 已打开（提交见 git log “hands-on”）。**还要做**：点选、拖放组装、旋转；机械臂皮肤的摆一摆等 G1 替换时一起做 | component-contract.md 第 5 节 |
| G16 | 心愿 → 下一课准备单 → 提前收集素材 | pipeline.md P0 |
| G17 | 示例课按新题型重写一版（L-PA 1.1：选择题、应用题、动手题），换成新的示例后把 V20 从警告升为错误 | `skills/discovery-learning-studio/reference/challenge-types.md` |
| G18 | 服务器让 ChatGPT（Codex）找动物照片的任务（`packages/studio/src/codex.ts` 的 `codexResearch`）改成按 research.md 的收集、理解、整理三步，产出 `sources.json`、`brief.md`、`plan.md` | research.md |
| G11 | 资产库 Schema 扩展：`kind` 加 `host`、`video`，manifest 字段（asset-sourcing.md 第 4 节），状态加“待确认” | asset-sourcing.md |

## P2：之后

| 编号 | 要做的 |
| --- | --- |
| G12 | 还没开发的主题皮肤：`insect_meadow` 草地昆虫、`tower_floor` 高楼楼层、`tunnel_walkway` 隧道检修通道、`robot_vacuum` 扫地机器人（`content/themes.json`）。每个先按 component-contract.md 第 4 节写规格 |
| G13 | 家里 iPad 的型号和实测帧率（家长告诉一次后写进项目说明） |
| G14 | 用真实的 ChatGPT（Codex）跑一遍“找实拍照片 → 生成”，现在只用模拟程序测过 |

## 暂时可以留着的（要按白名单登记）

这些是真实形状本来就简单的东西，符合 realism-spec.md 第 1 节的“简单几何件”，但贴图要换成扫描来源（G5），并登记进 A5 白名单：

- 实木积木方块和托盘（`blocks` 皮肤）。注意：积木只用在本来就讲积木的中性题材，**不能**出现在机器人、动物等主题的课里。
- 花园的铺砖、土床、木栅栏（栅栏要有木纹、倒角、风化）。
- 海底的 PVC 样方框、标桩、卷尺带。
- 洞口、点选用的隐形碰撞面、地面平面。
