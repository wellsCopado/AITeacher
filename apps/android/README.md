# 平板 App（安卓）

孩子用的平板 App「AI探索世界」：一个全屏的外壳，里面是家里 Mac 上服务器提供的 Pad 页面（`/pad/`）。课程、页面和声音都由服务器提供，所以更新服务器就更新了课程和页面；只有这个外壳本身改了才需要重装 App。

外壳做的事：

- 全屏、横屏、不锁屏；进课不用先点一下就能出声（`setMediaPlaybackRequiresUserGesture(false)`）。
- 第一次打开（或 Mac 换了地址）时，在平板所在的 Wi-Fi 网段里逐个询问 `:8787/v1/hello`，找到「AI 探索世界」的服务器就自动连上；也可以手动输入地址。
- 安卓 WebView 没有网页朗读（speechSynthesis），`apps/pad/src/native.ts` 把它接到平板自己的 TextToSpeech 上，只在服务器 Mac 的声音用不了时才会用到。

## 构建和测试

`.github/workflows/apps.yml` 在 GitHub 上构建：Gradle 打出 debug 和未签名的 release 包，在安卓平板模拟器里打开 App，确认它自己找到了服务器（模拟器里服务器地址是 10.0.2.2）并显示配对码；再装一遍 `release/` 里已签名的安装包，确认能装、能打开 Pad 页面。截图和未签名的包放在仓库的 `pad-app-build` 预发布里。

## 签名和发布

签名的密钥不进 git（仓库是公开的）。密钥和密码在项目文件夹的 `ai-discovery-world-signing/` 里；同一个密钥签的新版本才能直接覆盖安装，丢了密钥就只能先卸载旧 App 再装新的。

发布新版本：

1. 推送后等 Actions 的 Native apps 通过，从 `pad-app-build` 预发布下载 `ai-discovery-world-pad-unsigned.apk`。
2. 用密钥签名（APK Signature Scheme v2，minSdk 24 不需要 v1），验证签名。
3. 放到 `release/ai-discovery-world-pad.apk`，更新 `release/version.json`（版本号、提交、sha256），提交。
4. 家里的 Mac 更新后，家长端「设备与数据」的二维码就指向新包；平板上重新扫码安装即可覆盖旧版本，配对和学习记录都保留。
