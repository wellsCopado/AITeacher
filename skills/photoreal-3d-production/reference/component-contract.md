# 组件接口和新组件规格

孩子在 Pad 上只运行 `packages/components` 里的代码；一节课只提供参数（LessonSpec 的 `component_params`）。新场景、新主题皮肤、新组件都按这里接进去。

## 1. 现有接口（`packages/components/src/index.ts`）

```ts
mount(el: HTMLElement, componentId: string /* 名称@版本 */, params, opts: MountOptions): Instance
```

| 成员 | 要求 |
| --- | --- |
| `opts.hotspots` / `onHotspot(anchor)` | 每个热点锚点放在它讲的那个东西上（`row` 在第一行旁边，`fence` 在围栏上）。点标签或点到那个物体都触发 |
| `opts.onPick(info)` | 点到没有热点的物体（例如某一个齿轮），回传它的行列等信息 |
| `opts.onProgress(action, value)` | 动作进行中的进度（走了几米、摆了几行） |
| `opts.organism` | 动物素材（现在是俯视图 + 关节信息；换成真三维后改成 GLB 地址 + 骨骼动作名） |
| `run(action)` | 播一个动作，播完 Promise 才 resolve。动作名必须在 `content/components.json` 里登记 |
| `focus(anchor)` / `zoom(f)` / `reset()` / `toggleLabels()` | 镜头对准某个锚点、缩放、回到默认机位、显示或隐藏标注 |
| `still()` | 不播动画，直接显示完成状态（挑战配图用）。改成显式配图后为 `still(params, view)` |
| `dispose()` | 释放所有 GPU 资源、事件、定时器；连续挂载卸载 20 次内存不涨 |

主持人接口见 [host.md](host.md)。

## 2. 每个组件都必须做到

- **参数**：只接受 `content/components.json` 里 `paramsSchema` 允许的参数；`index.ts` 的 `COMPONENTS` 和 `components.json` 一致（`test/components.test.ts` 检查）。
- **数学正确**：画面里的数量、长度、面积和参数严格一致（例如 4 行每行 3 个就是 12 个齿轮），有单元测试。
- **写实**：所有可见物体符合 [realism-spec.md](realism-spec.md)；复杂物体从 `content/assets/<asset_id>/` 加载，不在代码里拼。
- **减少动态**：系统开了“减少动态效果”时，动作直接跳到结果，镜头不飞。
- **加载**：素材加载完成前显示一张这个场景的预渲染静帧（不是转圈的空白）；加载失败时显示实拍照片并在学习记录里记一条。
- **不联网**：只从家里服务器取素材，不访问外网。
- **没有控制台报错**，`pnpm e2e:apps` 通过。

## 3. 性能预算（家里的 iPad，Safari）

| 项目 | 上限 |
| --- | --- |
| 一个场景的下载量（首次） | 40 MB，缓存后再进 ≤ 2 秒 |
| 三角形（同屏） | 100 万 |
| 绘制调用（同屏） | 150 |
| 贴图显存 | 256 MB |
| 帧率 | 目标 60，最低 30（低于 30 自动降阴影和分辨率，不降素材写实度） |

家里 iPad 的型号要家长告诉一次，记进项目说明；没实测的数字写“未在 iPad 实测”。

## 4. 新组件或新主题皮肤的规格模板

做之前先写这一份，放在 `docs/components/<组件名>.md`，家长看过再动手：

```
组件名 / 版本：
教的知识点（content/concepts.json 的 id）：
孩子要做的动作（每个动作看到什么、数学上说明什么）：
参数和范围（paramsSchema）：
热点锚点（每个锚点放在哪个物体上、讲什么）：
主题皮肤（每个皮肤的场景清单，按 pipeline.md P3 的格式）：
挑战配图：still(params, view) 怎么摆，有哪些相机预设：
素材清单（资产 id、来源、许可、真实尺寸）：
动作依据（真实视频或厂家数据）：
验收：自动检查、对照图、iPad 实测（acceptance.md）：
```

新组件登记进 `content/components.json`，`status` 先写“待审”，家长看过对照图和预览后改“已审”（只有家长能改）。

## 5. 动手操作题（要做）

家长要求挑战题里有孩子亲手做的题：点选、滑动、拖放组装、旋转（题型说明见 `skills/discovery-learning-studio/reference/challenge-types.md`）。实现时 Schema、校验、播放器、组件一起改：

### LessonSpec

```json
{
  "id": "c2", "kind": "hands_on", "with_theme": true,
  "prompt": "让机械臂摆出 3 行、每行 4 个齿轮。",
  "task": {
    "type": "place",                       // select | slide | place | rotate
    "start": { "rows": 1, "cols": 4 },     // 开始时的场景参数（在组件参数范围内）
    "controls": ["rows"],                  // 孩子能改的东西（slide / place 用）
    "goal": "rows == 3 && cols == 4",      // 判对的条件，只能用参数、数字、+ - * / ( ) 和比较、&& ||
    "partial": [{ "when": "rows * cols == 12", "praise": "总数对了，再看看是不是 3 行" }]
  },
  "worked_example": { "steps": ["…", "…"] },   // 演示时场景自己做一遍
  "twin": { "prompt": "…", "task": { … } }
}
```

- `goal` 和 `partial` 用和实验模型相同的安全表达式求值器（扩展比较和逻辑运算），校验时检查变量都是组件参数、`goal` 能达到、`start` 不满足 `goal`。
- `partial` 让播放器在孩子没做对时，先夸做对的部分（和现有夸奖规则一致）。
- 错三次：场景按 `worked_example` 一步步自己做一遍，然后给 `twin` 让孩子再做。

### 组件

```ts
startTask(task: HandsOnTask, cb: { onChange(state: Record<string, number>): void }): void  // 打开操作，场景回到 start
taskState(): Record<string, number>
demoTask(task: HandsOnTask): Promise<void>   // 演示：场景自己做到 goal
endTask(): void                               // 关掉操作
```

- 操作的对象就是场景里的写实素材（真实的齿轮、样方框），不是另外画的按钮。
- 触摸目标至少 44 × 44 pt；拖放按真实单位吸附到格点或槽位，吸附时有轻微的声音；松手放不进去的回到原处，不弹跳。
- 场景角上实时显示当前的数（“3 行 × 4 个 = 12 个”“长 6 米”），这是数学标注层。
- 有“重来”按钮，回到 `start`。
- 减少动态效果打开时，拖放照样可用，只是没有过渡动画。
- 每道动手题至少给 60 秒。
