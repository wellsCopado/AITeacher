# 制作记录字段与检查器用法

`production.json` 是素材、设计和证据的制作侧记录，不导入为LessonSpec，也不写入宿主严格Schema。

从 `assets/production-template.json` 初始化后，按实际事实填写：

- `requirements`：interactive3D/action/video按本轮需求设定；独立视频默认可选。将action或video设false时写reason，引用用户要求或教学范围，不能只为绕过验收。
- `brief`：核心问题、目标与暂定事项；跨学科编织、发现过程、与近期课的设计差异写在 `research/lesson-design.md` 等本次实际文件中。
- `scene.heroAsset`：`assets` 中主角id；`scene.entry` 是包内运行入口，或用 `componentId` 标实际宿主组件。要求的能力与实际验证记录分开。
- `assets` 每项：`id/file/sha256/sourceId/origin/license/licenseScope/limits`。`origin`如scan/cad/generated/procedural；许可范围commercial/personal-noncommercial/unknown。
- `clips` 每项：`id/file/sha256/sourceId/license/licenseScope/purpose/origin`；rendered/ai-generated/licensed-recording明确区分。来源、用途和使用限制不能省。
- `narration` 每项：`id/file/sha256/sourceId/license/licenseScope/origin/transcriptFile/language`；`origin`仅human-recording或synthetic，真人授权、生成方式、发音和听检放对应来源与审查记录。草稿可保留licenseScope=unknown，assets/course仍会拦截未知授权，不能为让记录变绿编造许可。
- `voiceRequired` 默认true；只有用户明确接受无语音时才改为false，不能因声音工具或App入口缺失而自行降低要求。
- `sources` 每项：`id/url/verification`（远程资料）或`id/file/sha256/verification`（包内自主源码/生成记录），以及实际作者/机构、条款、用途；核实状态read/metadata-only/not-verified。自主建模记录脚本和参考来源；使用生成服务时另外记录实际服务/条款。
- `claims`：关键科学或定量事实、sourceIds、适用条件与是否只是推断；没有核实的事实不能用于确定答案。
- `app`：真实Schema/能力来源、实际课程文件、兼容状态与原生校验记录。未接App就是pending。

`reviews` 按通道记录，不设虚假的总分。passed记录例如：

```json
{
  "status": "passed",
  "notes": "实际进行了什么检查，发现与限制是什么",
  "evidence": [{"file": "evidence/实际检查记录.json", "sha256": "文件实际校验值"}],
  "artifacts": {"models/主角.glb": "本次检查对应模型的实际校验值"}
}
```

`scene.verifiedCapabilities` 每项同样包含id/status/evidence/artifacts。原生校验还要有真实command和exitCode，以及当前App内容文件的校验值。程序只核对这些记录与文件是否一致，不替代实际执行和审美/科学判断。

运行方式：

```sh
python3 scripts/init_production.py --topic '用户给的命题' --out '/制作目录/新主题'
python3 scripts/check_production.py '/制作目录/新主题' --stage record
python3 scripts/check_production.py '/制作目录/新主题' --stage assets --probe-media
python3 scripts/check_production.py '/制作目录/新主题' --stage course --probe-media
python3 scripts/check_challenges.py 'App课程.json' --capabilities '能力摘录.json' --audit '判题审计.json'
```

record只检查草稿记录；assets检查主角、约定必需的短片和来源；course要求当前宿主/能力/审查证据、所需媒体的实际流。独立本地Web预览另附构建与浏览器证据，不能填写假App兼容性。缺少条件时会失败，不能把默认模板当完整课程。

题目审计中的算式只支持参数、有限数值、add/mul/sub和比较，不执行eval。对小范围参数穷举验证答案是否满足条件、是否有多解；不能理解自然语言条件，审计算式仍要人工对照题意。更复杂的力学、连续空间或优化问题用经验证的领域求解器，不套此小型整数审计。
