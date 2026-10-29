# 宿主参考：AI 探索世界 App（AITeacher）

接这个家庭的 App 时读。仓库：[wellsCopado/AITeacher](https://github.com/wellsCopado/AITeacher)（分支 `m4-homework-reteach`）。App 跑在家里的 Mac 上：家长用 Mac 上的「AI 探索世界」审课、排课、看记录，孩子用安卓平板上课。

## App 收两种课

| 课 | 谁做 | 怎么进 App |
| --- | --- | --- |
| **探索课包**（整节网页课：三维场景＋教学，一个页面） | 这份 Skill | 家长在「课程库 → 探索课」导入 .zip，预览后点“通过并发布” |
| LessonSpec 课（填参数进固定组件） | `skills/discovery-learning-studio` | `dls submit` 或 MCP 交给家长审核 |

本 Skill 做的课交**探索课包**，不改写成 LessonSpec，也不需要改 App。台北101、上海中心两节课就是这样接进去的（2026-10-29）。

## 课程包的样子

```
<主题>_<年级>_<日期>/                  例如 台北101_四年级探索课_20261029/
  exploration.json                   App 读的说明，见下
  web/dist/index.html                构建好的网页（入口），和它用到的 assets/ models/ audio/ textures/ …
  web/src/  web/package.json …       源码、锁文件、vite.config.mjs（App 不读，留给以后改）
  README.md  课程设计.md  验收结果.md   家长在 App 的课程卡片上能点开看
  licenses/  research/sources.json   许可和来源，随课一起保存
```

模型的 .blend、研究原件、`node_modules` 可以不放；放了 App 也不读。

`exploration.json`（字段都可以省，省了 App 会猜，猜不出的家长导入时选）：

```json
{
  "format": "adw-explore/1",
  "id": "X-TAIPEI101",
  "version": "1.0",
  "title": "台北101：风中的稳定秘密",
  "grade": 4,
  "concept": "统计比较与平均数",
  "subjects": ["数学", "科学", "语文", "英语"],
  "minutes": 30,
  "summary": "一两句话：孩子在这节课里看什么、动手做什么。",
  "entry": "web/dist/index.html"
}
```

- `id` 以 `X-` 开头，只用英文字母、数字和连字符；同一节课改版时**保持 id 不变**。没发布的那一份会被新包替换；已发布的，App 自动给新包下一个版本号（1.0 → 1.1），发布后自动排课只排新版。
- `grade` 写年级（哥哥 4、妹妹 2），或者写 `for_child`（`gege` / `meimei`）。

## 网页要满足的

1. **构建好再打包。** 包里要有 `web/dist/index.html`；只有引用 `/src/…` 的源码页面，App 会拒收。
2. **相对路径。** App 把课放在 `/explore/<课号>/` 下。Vite 在 `vite.config.mjs` 写 `base: './'`；代码里载入文件写 `./models/x.glb`、`./audio/intro.m4a`，不写 `/models/…`。用了绝对路径 App 会尽量转接，但会在家长的卡片上提示。
3. **不连外网。** 运行时只用包里的文件；平板只连家里的 Mac。给大人核对的来源链接可以留，但放在说明抽屉或文档里：孩子点到外链，App 会跳到平板浏览器。
4. **大小。** 网页部分最好在 150 MB 以内（平板第一次打开要下载）；超过 800 MB 拒收。
5. **接 App 的进度接口**：把 [`assets/web/adw-host.mjs`](../assets/web/adw-host.mjs) 复制进源码，原样使用：

```js
import { storageKey, report, ready, failed, onHost } from './adw-host.mjs';
const key = storageKey('taipei101-1.0', qa);            // 每个孩子一份本机记录；家长预览、制作验收各自独立
const LABELS = { locate: '装置与机制', fair: '公平比较' }; // 每项任务给家长看的名字
const tell = () => report({ section: progress.chapter, sections: 4, tasks: progress.tasks, labels: LABELS });
const save = () => { localStorage.setItem(key, JSON.stringify(progress)); tell(); };
world.ready.then(() => { ready(); tell(); }).catch((e) => failed(e.message));
onHost((m) => { if (m.type === 'pause') { stopVoice(); world.setPaused(true); } if (m.type === 'resume') world.setPaused(progress.paused); });
```

   - `tasks` 里每项写 `passed`、`result`（`independent` 独立答对 / `assisted` 借助帮助 / `corrected` 改错后）、`helped`、`wrong`。判题仍读场景状态（见 [接入契约](host-integration.md)），App 只记录页面报上来的结果。
   - 全部 `passed` 时 App 记这节课“学完了”，问孩子下一次想探索什么（写进家长的下一课准备单），自动排课换下一节。帮助和改错照实记给家长，不算独立完成。
   - 不接这个接口也能导入，但 App 不知道孩子做到哪，只能让孩子退出时自己选“学完了”。

## App 怎么上这节课

- 平板上全屏打开网页，上面一条窄栏：「⏸ 休息 / 退出」和“已核对 n/m 项”。点它时 App 先发 `pause`；孩子选“继续探索”发 `resume`，选“退出，下次接着上”就回到课程列表，当天再点开从页面自己的记录接着做。
- App 记下开始、休息、继续、退出、每次进度、学完和孩子说的下一课心愿，家长在「学习记录」看到“核对了 3/4 项：公平比较（改错后完成）……”。
- 家长预览用 `?learner=preview`，不动孩子的记录；地址带 `?qa=1` 的制作验收模式照旧可用。
- 家长在 App 里定过的上课规则（一中三英、每步计时、错三次先演示再做同类题，见 `skills/discovery-learning-studio/reference/lesson-flow.md`）是 LessonSpec 课的固定流程。探索课的流程由页面自己决定，App 不强加；做给这个家庭的课，按家长本轮的要求取舍，并在 `课程设计.md` 写明取舍了什么。

## 交给家长

- 先构建（`cd web && pnpm build`），再打包，然后预检：

```sh
zip -qr -X 台北101_四年级探索课_20261029.zip 台北101_四年级探索课 -x "*/node_modules/*" "*.DS_Store"
python3 scripts/check_package.py 台北101_四年级探索课_20261029.zip
```

  `check_package.py` 用和 App 导入时同一套规则查：`exploration.json` 字段、有没有构建好的网页、绝对路径、运行时外网文件、进度接口、大小、密钥文件。`errors` 不为空先改；`warnings` 写进 `验收结果.md`。它不运行网页，过了也要在App里预览。
- 默认：打好 .zip 交给家长，家长在 Mac 的「AI 探索世界 → 课程库 → 探索课」选文件导入。
- 能连家里的服务器时（`ADW_SERVER`、家长在「设备与数据 → AI 助手接入」给的 `ADW_TOKEN`），可以直接交：

```sh
curl -sS -X POST "$ADW_SERVER/v1/explore/import?name=台北101_四年级探索课_20261029.zip" \
  -H "authorization: Bearer $ADW_TOKEN" -H 'content-type: application/zip' \
  --data-binary @台北101_四年级探索课_20261029.zip
```

  返回里的 `warnings` 是 App 看出的问题（没接进度接口、绝对路径、包太大）；`error` 说明为什么没收。交上去只是“待审核”，发布只能由家长点按钮。

## 已知限制

- App 只托管网页、记录进度，不检查画面是否写实、科学是否准确；这些仍按本 Skill 的验收做，并写进 `验收结果.md` 给家长看。
- 平板上的帧率、加载时间要在真平板上试；渐进光追（`physical-viewer.mjs`）在平板上可能很慢，要有快速预览的退路。
- 孩子的名字不进页面：App 只传孩子编号（`gege`），用来分开本机记录。
