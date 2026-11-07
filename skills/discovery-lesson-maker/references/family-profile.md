# 家庭档案：给 AI 探索世界这个家庭做课时必须遵守的规则

给这个家庭（哥哥四年级、妹妹二年级）做的探索课，**下面每一条都是验收条件**，不是建议。家长 2026-11-05 定的：以后新课都做成探索课，并且守家里的上课规则。本 Skill 其他地方写的“未配置时不计时、英语可选、可以自由跳章”只适用于别的用户，对这个家庭不适用。

`scripts/check_package.py` 会按本页检查课程包，有 errors 不算做完。检查器只能查结构和数量；画面像不像、孩子喜不喜欢，要按第 6 节的对照图和家长预览判断。

## 1. 上课流程（用 `assets/web/adw-family.mjs`，不要自己另写）

把 `assets/web/adw-family.mjs` 和 `adw-family-phrases.json` 复制进源码，原样使用。它实现了家长定的流程：

- **步骤按顺序解锁**：这一步的题都有结果，“下一步”才亮；不能跳到后面的步骤。
- **每步倒计时**：每步 30–900 秒；剩 1 分钟提醒；到时间自动进下一步，没做完的题记“超时”，最后一步到时间就下课。演示时不扣时间。
- **字幕 + 朗读**：孩子要看的每一句话都出字幕、播放录好的声音。
- **一中三英**：每个讲解点第 1 次读中文，第 2–4 次读英文 1–3，再循环（和 App 里另一种课一样）。英文只用来听，不考英语。
- **夸奖**：答对按怎么答对的夸（一次就对 / 改错后对 / 用了提示 / 看了演示后自己做对）；答错先说真正做对的地方（`good`），再说再看哪里（`look`），再给一句坚持的理由（`encouragement.persist`）。
- **错 3 次先演示，再做同类题**：第 2 次错自动给提示；第 3 次错播放 `worked_example`（页面同时在三维场景里摆给孩子看），然后出 `twin` 同类题，孩子自己做一次。同类题还错，就告诉答案、鼓励一句，进下一题，不无限重试。
- **休息和续学**：App 点「休息 / 退出」时暂停计时和声音；记录存在本机，当天再进接着上。
- **课末问下一课心愿**：课走完（最后一步做完，或到时间下课）时，流程告诉 App `ended`，App 问孩子“下一次想探索什么”，并把 `wish.options` 里的主题做成按钮给孩子点；孩子说的进家长的下一课准备单。

页面怎么接：

```js
import { storageKey, report, ready, failed, onHost } from './adw-host.mjs';
import { mountFamilyLesson } from './adw-family.mjs';
import flow from '../public/lesson-flow.json';           // 或 fetch('./lesson-flow.json')
const lesson = mountFamilyLesson({ flow, root: document.querySelector('#family'), key: storageKey(flow.lesson, qa),
  host: { report, onHost },
  hooks: {
    onStep: (step) => world.goTo(step.id),                 // 换到这一步的镜头和场景
    onDemoStep: (taskId, i) => world.demo(taskId, i),      // 在三维里摆出演示的第 i 步
    onTwin: (taskId, twin) => ui.showTwin(taskId, twin),   // 出同类题
  } });
// 判题读场景状态，再交给流程：
lesson.answer('span', { ok: world.state.span === 30, good: '桥墩位置放对了', look: '再看看两个桥墩之间有几格' });
```

## 2. `lesson-flow.json`（放在 `web/public/`，构建后在 `web/dist/lesson-flow.json`）

孩子在页面上看到、听到的话**全部**写在这里，页面不另写给孩子的长段文字（有就是没朗读，检查器会报错）。下面是节选：完整的课至少 3 个实验，`steps` 里提到的题都要写。

```json
{
  "format": "adw-family/1",
  "lesson": "X-GEGE-20261106-bridge",
  "grade": 4,
  "math": { "point": "除法：平均分", "question": "两个桥墩放在哪里，三段桥才一样长？", "why_here": "真实斜拉桥按跨度分段" },
  "steps": [
    { "id": "look", "title": "看大桥", "seconds": 240, "say": ["intro"], "tasks": ["which"] },
    { "id": "try", "title": "动手试", "seconds": 420, "say": ["load"], "tasks": ["span", "trip"] },
    { "id": "say", "title": "说一说", "seconds": 180, "media": "render", "say": ["wrap"], "tasks": ["why"] }
  ],
  "narration": {
    "intro": { "zh": "这座桥有两千多米长。它是怎么站稳的？", "en": ["This is a bridge.", "The bridge is long.", "How does it stand?"] }
  },
  "experiments": [
    { "id": "drag-truck", "step": "try", "input": "drag", "child_does": "把卡车拖上桥面", "scene_state": "truck.x, deck.sag", "see": "桥面往下弯一点，拉索绷紧" },
    { "id": "place-pier", "step": "try", "input": "place", "child_does": "在河里放两个桥墩", "scene_state": "piers[].x", "see": "每段桥的长度跟着变" }
  ],
  "tasks": {
    "which": { "kind": "choice", "label": "找出受力的部分", "ask": "哪一根在拉住桥面？",
      "options": [ { "id": "a", "text": "拉索", "right": true },
                   { "id": "b", "text": "栏杆", "good": "你在找连着桥面的东西，方向对了。", "look": "看看哪根线会绷紧。" } ],
      "hints": ["卡车开上去时，看哪根线变直了。"],
      "worked_example": ["先把卡车拖到桥中间。", "看，这几根拉索绷紧了。", "所以拉住桥面的是拉索。"],
      "twin": { "ask": "卡车开到左边时，哪边的拉索更紧？", "options": [ { "id": "l", "text": "左边", "right": true }, { "id": "r", "text": "右边", "good": "你在比两边，这个办法对。", "look": "看卡车在哪一边。" } ] } },
    "span": { "kind": "hands_on", "math": true, "experiment": "place-pier", "label": "摆桥墩", "ask": "把两个桥墩摆好，让每段桥一样长。",
      "good": "桥墩已经立在河里了。", "look": "数一数两段各有几格。", "hints": ["一共 12 格，平均分成两段。"],
      "worked_example": ["一共 12 格。", "平均分成 2 段，每段 6 格。", "所以桥墩放在第 6 格。"],
      "twin": { "ask": "一共 18 格，分成 3 段一样长，桥墩放在哪两格？" } }
  },
  "encouragement": { "persist": ["造桥的工程师也是一遍遍试出来的。", "你已经找对一半了，再看一眼就能找到另一半。"] },
  "wish": { "options": ["隧道", "桥塔怎么立起来", "跨海大桥"] },
  "parent_notes": ["数值来源和简化写在这里，给家长看，不给孩子读。"],
  "visual_gate": { "sheet": "evidence/visual-gate.jpg", "references": [ { "file": "research/ref-bridge-1.jpg", "source": "https://…" } ],
    "views": [ { "name": "overview", "media": "render", "file": "evidence/render-overview.png" }, { "name": "deck", "media": "realtime", "file": "evidence/realtime-deck.png" } ],
    "dimensions": [ { "what": "主跨", "meters": 602, "source": "https://…" } ],
    "self_review": "主桥、拉索比例和照片一致；桥面沥青贴图偏新；远景楼群是简化体块，已压暗并虚化。" }
}
```

规则（检查器都会查）：

- `steps` 2–8 步，每步 30–900 秒，每步至少一个讲解点（`say`）。每道题只属于一步。
- `narration` 每个讲解点：中文 1 句，英文正好 3 句（短、准确、和画面有关）。
- `tasks` 至少 2 道：至少 1 道 `choice`（选择题）和 1 道 `hands_on`（动手题）；`kind` 只能是 `choice`、`application`（应用题）、`hands_on`、`explain`（说一说）。选择题 2–4 个选项、正好 1 个对，每个错误选项写 `good` 和 `look`，对应一个真实的误区。
- 每道题都有 `worked_example`（2–5 步，最后一步说出答案）和 `twin`（换数字或情境，选择题的同类题也带选项）。
- 动手题写 `experiment`，指向一个实验；判题读场景状态，不读按钮点击。
- `encouragement.persist` 2–5 句，和主题有关，不写空话。
- `grade` 写孩子的年级（和 `exploration.json` 的 `grade` 一样）；句数按它查。
- `wish.options` 2–4 个下一课可以探索的主题（每个不超过 12 个字），从这节课自然延伸，课末给孩子点选。
- 数学怎么写见下面的“数学优先”。

## 数学优先（BL01，检查器会查）

这个家庭的课以数学为主，包在孩子喜欢的主题里。主题是蜜蜂、火箭还是大桥都一样：

- `math.point` 写这节课用到的课本知识点，用课本上的叫法（“除法：平均分”“角的度量”“周长”）。从家长端的课内进度里挑这个年级该学或刚学过的；没给进度就按年级挑，写进 `课程设计.md`。
- `math.question` 写这节课要用数学回答的主问题，它也是孩子动手实验要回答的问题。
- 数学从主题里真实存在的数量、形状、尺度和变化里找（巢房的六边形、桥墩的间距、火箭每秒升高多少），不在主题外面套无关算术。
- 题目里标 `"math": true` 的数学题至少 2 道，并且占一半以上；至少一道数学题是动手题，孩子在三维场景里亲手摆、量、拖出答案。
- 数学题的题目和演示里要有真的数（数量、长度、角度、时间），数据带单位，来自资料或场景里能数出来的东西。
- 知识点不超过孩子的年级（`math.grade` 写了就要不高于 `grade`）。

## 3. 写给孩子的话

孩子会被读给听，也会自己看。写得像一位在旁边一起看的老师，不像审稿意见。

- 每句话（字幕的一条）不超过 40 个字；一句一个意思，以“。！？”断开，每个分句不超过 24 个字。
- 四年级每步讲解不超过 3 句；二年级不超过 2 句（检查器按 `grade` 数每步 `say` 里的中文句子）。数学词用课本上的说法（平均数、角、周长）。
- 不在孩子面前说知识边界和免责声明。“示意”“近似”“不能推成”“教学算例”“未标定”“性能保证”“不代表”“仅供”这类话放进 `parent_notes`，家长在「资料与边界」里看。
- 不用括号套括号、表格、公式符号；数字带单位。

检查器会量句长、查这些词，并统计页面里不在 `lesson-flow.json` 的汉字（超过 200 个算错：说明页面上有没朗读的大段文字）。

## 4. 互动底线：孩子要亲手做实验

一节课至少 **3 个实验**（`experiments`），每个都是孩子亲手改变三维场景、马上看到结果：

| `input` | 例子 |
| --- | --- |
| `drag` | 把卡车拖上桥、把螳螂虾的捕肢拉开 |
| `rotate` | 转动一节楼层、转动量角器去量真实的楼角 |
| `push` | 推一下楼，看阻尼球怎样晃 |
| `assemble` | 把桥的部件按顺序装上 |
| `place` | 在场景里放标记、放桥墩 |
| `draw` | 在真实画面上描出一条边、一个角 |
| `pinch` | 两指张开捕肢、拉长弹簧 |

- 切镜头、下拉框、滑条、点“播放”**不算**实验（滑条可以作为同一实验的第二种输入）。
- 每个实验写清 `child_does`（孩子做什么）、`scene_state`（场景里哪个量变了）、`see`（孩子看到什么变化）。
- 至少一道动手题用这些实验判题；结果要真的改变场景状态。

## 5. 主角、素材和真实感

- 主角（动物、机器人、建筑、桥）必须是真三维：扫描、专业模型、CAD，或至少 3 张不同角度实拍照片生成后修整。不用代码几何体拼主角，不用一张照片做浮雕。
- 环境要“像那个地方”：地面、植物、岩石、水面用扫描贴图或扫描模型（Poly Haven、ambientCG 等 CC0）。周围建筑可以简化，但不能是没贴图的方盒挤满画面；远处压暗、虚化或用实拍天空球。
- 默认只用免费素材和本机工具（Blender、three.js、CC0 / CC-BY 素材）。要买模型或用收费的图生 3D 时，写进 `课程设计.md` 的“需要家长决定”，不要自己付费。
- 渐进光追只在静止时细化；孩子操作时画面不能满屏噪点。
- 做法按 [写实画面的通用做法](photoreal-pipeline.md)：“看”的步骤（`media: render`）给孩子看同一模型的光线追踪图或短片，动手的步骤（`media: realtime`，有实验或动手题的步必须是它）用实时三维；按查到的真实尺寸建模，画面里放人、车、手等孩子熟悉的尺度参照；对着同角度照片过一遍假感毛病表。

## 6. 画面对照门（先过这关再做整课）

做完主角和场景、还没写题目之前，先做一张对照图 `evidence/visual-gate.jpg`：同一机位并排放真实照片（至少 1 张，最好 3 张：全景、关键部位近景、有尺度参照的视角）、课里实际网页的截图（`scripts/shoot_views.mjs`），有“看”的步骤时再放预渲染图（`scripts/render_stills.py`）。三种图写进 `visual_gate.views`（`media: render | realtime`），真实尺寸和来源写进 `visual_gate.dimensions`。实时截图必须有，预渲染图不能代替它。

- 自己先对着照片挑毛病，写进 `visual_gate.self_review`：哪里像、哪里不像、不像的是怎么处理的。挑不出毛病就是没认真看。
- 再请没参与制作的审看人盲看主角：照片和本课画面打乱成 A/B，至少 3 个角度，原话写进 `visual_gate.blind_review`。说像动画片或玩具就返工后重看。做法见 [主角三维](hero-production.md) 第 6 步。
- 有家长在场时（对话里做课），把对照图给家长看，家长说“画面可以”再继续做整课；不行只返工画面，不扩写课程。
- 家长端自动做课时没人在场：照样做对照图和自评。家长在课程卡片最前面先看到这张图，勾上“对照图看过了”才能发布；App 自己做的课没交对照图直接拒收。`验收结果.md` 第一段也放它。

## 7. 交课前自查

- [ ] 用的是 `adw-family.mjs`，没有另写计时和夸奖。
- [ ] `lesson-flow.json` 通过 `check_package.py`，没有 errors（含数学优先、按年级的句数、课末心愿选项）。
- [ ] `python3 scripts/make_family_audio.py <web/public> --engine azure` 录好了全部声音（没有云端密钥才用 `--engine mac`，并写明），按 [语音制作](voice-direction.md) 的听检验收听过 8 句，没有一句“有 AI 味”。
- [ ] 主角按 [主角三维](hero-production.md) 做：来源合这一类、≥3 张真实照片、真实尺寸、`hero_check.py` 没有 errors；盲看 3 个角度，审看人没参与制作，没人说像动画片或玩具。
- [ ] 3 个以上实验，孩子真能用手指在平板上做。
- [ ] 对照图里有实时截图（有“看”的步骤时还有预渲染图），真实尺寸带来源，自评按假感毛病表逐条看过。
- [ ] 从头到尾走一遍：故意答错 3 次，看演示和同类题；等一步超时，看是否自动进下一步；点休息再继续。
