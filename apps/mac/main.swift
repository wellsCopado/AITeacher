// AI 探索世界 for Mac: the parent app in its own window, and the family server kept running in the background by
// launchd (so the children's tablets work whether or not this window is open). Built and installed by
// scripts/mac-app.mjs, which also writes the config this app reads.
import Cocoa
import WebKit

struct Config: Codable {
    var root: String
    var node: String
    var path: String
    var port: Int
}

let home = FileManager.default.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/AIDiscoveryWorld")
let agentLabel = "world.aidiscovery.server"
let agentPlist = home.appendingPathComponent("Library/LaunchAgents/\(agentLabel).plist")
let logFile = home.appendingPathComponent("Library/Logs/AIDiscoveryWorld/server.log")

/// Runs a short command and returns its exit status and output.
@discardableResult
func run(_ exe: String, _ args: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, error.localizedDescription) }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func esc(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var config: Config?
    var port = 8787
    var selftest = false
    var window: NSWindow!
    var web: WKWebView!
    var popups: [NSWindow] = []
    var downloads: [ObjectIdentifier: URL] = [:]
    var updating: Process?
    var log: NSTextView?
    var logPanel: NSPanel?

    var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ n: Notification) {
        let args = CommandLine.arguments
        selftest = args.contains("--selftest")
        if let i = args.firstIndex(of: "--port"), i + 1 < args.count, let p = Int(args[i + 1]) { port = p }
        if let data = try? Data(contentsOf: supportDir.appendingPathComponent("config.json")),
           let c = try? JSONDecoder().decode(Config.self, from: data) {
            config = c
            if !args.contains("--port") { port = c.port }
        }
        buildMenu()

        let conf = WKWebViewConfiguration()
        conf.mediaTypesRequiringUserActionForPlayback = []
        conf.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: conf)
        web.navigationDelegate = self
        web.uiDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "AI 探索世界 · 家长端"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = web
        window.center()
        _ = window.setFrameAutosaveName("main")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if selftest { DispatchQueue.main.asyncAfter(deadline: .now() + 90) { self.finishSelftest(false, "timed out") } }
        start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    // MARK: server

    /// A small page shown in the window while the server isn't answering; its links are handled in decidePolicyFor.
    func status(_ title: String, _ detail: String = "", links: [(String, String)] = []) {
        let buttons = links.map { "<a href=\"adw:\($0.1)\">\(esc($0.0))</a>" }.joined(separator: " ")
        web.loadHTMLString("""
        <html><head><meta charset="utf-8"><style>
        body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0e1a20;color:#e8f0f2;font:16px/1.6 -apple-system,"PingFang SC",sans-serif}
        div{max-width:560px;text-align:center}h2{font-weight:600}p{color:#a9bcc1}
        a{display:inline-block;margin:6px;padding:9px 20px;border-radius:9px;background:#4fb3a9;color:#08181a;text-decoration:none;font-weight:600}
        </style></head><body><div><h2>\(esc(title))</h2><p>\(esc(detail))</p>\(buttons)</div></body></html>
        """, baseURL: nil)
    }

    func hello(_ done: @escaping (Bool) -> Void) {
        var r = URLRequest(url: base.appendingPathComponent("v1/hello"))
        r.timeoutInterval = 2
        r.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: r) { data, resp, _ in
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200 && body.contains("ai-discovery-world")
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func waitForServer(_ tries: Int, _ done: @escaping (Bool) -> Void) {
        hello { ok in
            if ok || tries <= 0 { done(ok); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitForServer(tries - 1, done) }
        }
    }

    /// The server runs under launchd (installed by scripts/mac-app.mjs); start it when it isn't answering.
    func start() {
        status("正在连接家里的服务器…")
        hello { ok in
            if ok { self.openParent(); return }
            if FileManager.default.fileExists(atPath: agentPlist.path) {
                run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", agentPlist.path])
                run("/bin/launchctl", ["kickstart", "gui/\(getuid())/\(agentLabel)"])
                self.status("正在启动服务器…", "第一次启动要准备课程和声音，可能要半分钟。")
            }
            self.waitForServer(60) { ok in
                if ok { self.openParent() }
                else if self.selftest { self.finishSelftest(false, "server not answering on port \(self.port)") }
                else {
                    self.status("服务器没有启动", "可以点“查看日志”看看原因，或者点“重试”。如果一直不行，在菜单里点“检查更新”。",
                                links: [("重试", "retry"), ("查看日志", "log")])
                }
            }
        }
    }

    func openParent() {
        web.load(URLRequest(url: base.appendingPathComponent("parent/")))
    }

    @objc func restartServer(_ s: Any?) {
        status("正在重启服务器…")
        run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(agentLabel)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.start() }
    }

    @objc func showLog(_ s: Any?) {
        if FileManager.default.fileExists(atPath: logFile.path) { NSWorkspace.shared.open(logFile) }
        else { alert("还没有服务器日志。") }
    }

    @objc func reload(_ s: Any?) {
        if web.url?.scheme == "http" { web.reload() } else { start() }
    }
    @objc func zoomIn(_ s: Any?) { web.pageZoom = min(web.pageZoom + 0.1, 2) }
    @objc func zoomOut(_ s: Any?) { web.pageZoom = max(web.pageZoom - 0.1, 0.6) }
    @objc func zoomReset(_ s: Any?) { web.pageZoom = 1 }

    // MARK: update (git pull, install, rebuild, restart), shown live in a panel

    @objc func checkUpdate(_ s: Any?) {
        guard updating == nil else { logPanel?.makeKeyAndOrderFront(nil); return }
        guard let c = config else { alert("没找到安装信息。请在终端里运行一次安装命令（见 docs/deploy.md）。"); return }
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 400), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "检查更新"
        panel.isReleasedWhenClosed = false
        let scroll = NSTextView.scrollableTextView()
        let text = scroll.documentView as! NSTextView
        text.isEditable = false
        text.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        panel.contentView = scroll
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        logPanel = panel
        log = text
        append("正在检查更新…\n")

        let p = Process()
        p.executableURL = URL(fileURLWithPath: c.node)
        p.arguments = ["\(c.root)/scripts/mac-app.mjs", "update"]
        p.currentDirectoryURL = URL(fileURLWithPath: c.root)
        p.environment = ["PATH": c.path, "HOME": home.path, "LANG": "zh_CN.UTF-8"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        var output = ""
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
            DispatchQueue.main.async { output += s; self.append(s) }
        }
        p.terminationHandler = { proc in
            DispatchQueue.main.async {
                pipe.fileHandleForReading.readabilityHandler = nil
                self.updating = nil
                if proc.terminationStatus != 0 { self.append("\n✗ 更新没有完成。上面是原因，可以截图发给 Claude。\n"); return }
                self.append("\n✓ 更新完成。\n")
                if output.contains("MAC_APP_REBUILT") {
                    let a = NSAlert()
                    a.messageText = "App 本身也更新了"
                    a.informativeText = "点“重新打开”换成新版本。"
                    a.addButton(withTitle: "重新打开")
                    a.runModal()
                    self.relaunch()
                } else {
                    self.start()
                }
            }
        }
        do { try p.run(); updating = p } catch { append("启动更新失败：\(error.localizedDescription)\n") }
    }

    func append(_ s: String) {
        guard let t = log else { return }
        t.textStorage?.append(NSAttributedString(string: s, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.textColor]))
        t.scrollToEndOfDocument(nil)
    }

    func relaunch() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", Bundle.main.bundlePath]
        try? p.run()
        NSApp.terminate(nil)
    }

    // MARK: navigation: stay on the family server, open other links in the browser, save downloads

    func isLocal(_ u: URL) -> Bool {
        guard let s = u.scheme else { return true }
        if s == "about" || s == "blob" || s == "data" { return true }
        return (s == "http" || s == "https") && (u.host == "127.0.0.1" || u.host == "localhost") && (u.port ?? 80) == port
    }

    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = a.request.url else { decisionHandler(.allow); return }
        if url.scheme == "adw" {
            if url.absoluteString.hasSuffix("retry") { start() } else if url.absoluteString.hasSuffix("log") { showLog(nil) }
            decisionHandler(.cancel); return
        }
        if a.shouldPerformDownload { decisionHandler(.download); return }
        if !isLocal(url) && a.targetFrame?.isMainFrame != false {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(r.canShowMIMEType ? .allow : .download)
    }

    func webView(_ w: WKWebView, navigationAction a: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
    func webView(_ w: WKWebView, navigationResponse r: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }

    func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let stem = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var url = dir.appendingPathComponent(name)
        var i = 1
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(stem) (\(i))" : "\(stem) (\(i)).\(ext)")
            i += 1
        }
        downloads[ObjectIdentifier(d)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ d: WKDownload) {
        if let u = downloads.removeValue(forKey: ObjectIdentifier(d)) { NSWorkspace.shared.activateFileViewerSelecting([u]) }
    }

    func download(_ d: WKDownload, didFailWithError e: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(d))
        alert("下载没有成功：\(e.localizedDescription)")
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        guard w === web, (e as NSError).code != NSURLErrorCancelled else { return }
        if selftest { finishSelftest(false, e.localizedDescription); return }
        status("连不上服务器", e.localizedDescription, links: [("重试", "retry"), ("查看日志", "log")])
    }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        guard selftest, w === web, w.url?.path.hasPrefix("/parent") == true else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            w.evaluateJavaScript("(document.querySelector('#pin') ? 'login form; ' : '') + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120)") { r, err in
                let text = (r as? String) ?? ""
                self.finishSelftest(text.contains("login form") && text.contains("家长端"), text + (err.map { " error: \($0.localizedDescription)" } ?? ""))
            }
        }
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

    // MARK: windows from the page: lesson previews, alerts, file pickers

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        guard let url = a.request.url else { return nil }
        if !isLocal(url) { NSWorkspace.shared.open(url); return nil }
        let v = WKWebView(frame: .zero, configuration: c)
        v.navigationDelegate = self
        v.uiDelegate = self
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        win.title = "预览"
        win.contentView = v
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.center()
        win.makeKeyAndOrderFront(nil)
        popups.append(win)
        return v
    }

    func webViewDidClose(_ v: WKWebView) { v.window?.close() }

    func windowWillClose(_ n: Notification) {
        guard let w = n.object as? NSWindow, w !== window else { return }
        (w.contentView as? WKWebView)?.loadHTMLString("", baseURL: nil) // stop sound and 3D in a closed preview
        popups.removeAll { $0 === w }
    }

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = m
        a.addButton(withTitle: "好")
        a.runModal()
        completionHandler()
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = m
        a.addButton(withTitle: "确定")
        a.addButton(withTitle: "取消")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = p
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = d ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "确定")
        a.addButton(withTitle: "取消")
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let o = NSOpenPanel()
        o.allowsMultipleSelection = p.allowsMultipleSelection
        o.canChooseDirectories = false
        o.canChooseFiles = true
        o.begin { r in completionHandler(r == .OK ? o.urls : nil) }
    }

    // MARK: menus

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "关于 AI 探索世界", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "检查更新…", action: #selector(checkUpdate(_:)), keyEquivalent: "u")
        app.addItem(withTitle: "重启服务器", action: #selector(restartServer(_:)), keyEquivalent: "")
        app.addItem(withTitle: "查看服务器日志", action: #selector(showLog(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "隐藏 AI 探索世界", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "退出（服务器继续在后台运行）", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "显示")
        view.addItem(withTitle: "重新载入", action: #selector(reload(_:)), keyEquivalent: "r")
        view.addItem(.separator())
        view.addItem(withTitle: "放大", action: #selector(zoomIn(_:)), keyEquivalent: "+")
        view.addItem(withTitle: "缩小", action: #selector(zoomOut(_:)), keyEquivalent: "-")
        view.addItem(withTitle: "实际大小", action: #selector(zoomReset(_:)), keyEquivalent: "0")
        viewItem.submenu = view

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let win = NSMenu(title: "窗口")
        win.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }

    func alert(_ m: String) {
        let a = NSAlert()
        a.messageText = m
        a.runModal()
    }

    func finishSelftest(_ ok: Bool, _ detail: String) {
        guard selftest else { return }
        print("SELFTEST \(ok ? "PASS" : "FAIL"): \(detail)")
        exit(ok ? 0 : 1)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
