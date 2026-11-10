import Cocoa
import WebKit

// SalaryTimer —— 原生悬浮窗口壳（WKWebView 承载本地界面）
// 数据落盘：~/Library/Application Support/SalaryTimer/state.json
// 导出目录：~/Documents/SalaryTimer/exports/

let fm = FileManager.default
let homeDir = fm.homeDirectoryForCurrentUser
let supportDir = homeDir.appendingPathComponent("Library/Application Support/SalaryTimer", isDirectory: true)
let stateURL = supportDir.appendingPathComponent("state.json")
let frameURL = supportDir.appendingPathComponent("window.json")
let exportDir = homeDir.appendingPathComponent("Documents/SalaryTimer/exports", isDirectory: true)

func ensureDirs() {
    for dir in [supportDir, exportDir] {
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
    }
}

func readStateJSON() -> String {
    guard let data = try? Data(contentsOf: stateURL),
          let text = String(data: data, encoding: .utf8),
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "null" }
    return text
}

func jsonString(_ value: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [value], options: [])
    let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
}

// MARK: - 窗口与桥

final class BoardController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var bridge: Bridge!
    var frameSaveTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureDirs()

        bridge = Bridge()
        bridge.owner = self

        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        let seed = "window.__NATIVE__ = true; window.__INITIAL_STATE__ = \(readStateJSON());"
        userContent.addUserScript(WKUserScript(source: seed, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        userContent.add(bridge, name: "bridge")
        config.userContentController = userContent

        let rect = restoredFrame()
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered,
                          defer: false)
        window.title = "SalaryTimer"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.isMovableByWindowBackground = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.minSize = NSSize(width: 320, height: 420)
        window.backgroundColor = NSColor(srgbRed: 0.980, green: 0.965, blue: 0.937, alpha: 1)
        window.isReleasedWhenClosed = false
        window.delegate = self

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(webView)

        let uiDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "app/ui")
        let indexURL = uiDir.appendingPathComponent("index.html")
        guard fm.fileExists(atPath: indexURL.path) else {
            FileHandle.standardError.write("找不到界面文件: \(indexURL.path)\n".data(using: .utf8)!)
            NSApp.terminate(nil)
            return
        }
        webView.loadFileURL(indexURL, allowingReadAccessTo: uiDir)

        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        persistFrame()
    }

    // MARK: 位置与尺寸

    private func restoredFrame() -> NSRect {
        let fallbackSize = NSSize(width: 340, height: 540)
        var frame = NSRect(origin: .zero, size: fallbackSize)
        if let screen = NSScreen.main {
            let visible = screen.visibleFrame
            frame.origin = NSPoint(x: visible.maxX - fallbackSize.width - 28,
                                   y: visible.maxY - fallbackSize.height - 12)
        }
        guard let data = try? Data(contentsOf: frameURL),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let x = (obj["x"] as? NSNumber)?.doubleValue,
              let y = (obj["y"] as? NSNumber)?.doubleValue,
              let w = (obj["w"] as? NSNumber)?.doubleValue,
              let h = (obj["h"] as? NSNumber)?.doubleValue,
              w >= 200, h >= 200 else { return frame }

        var restored = NSRect(x: x, y: y, width: max(w, 320), height: max(h, 420))
        // 防止改过显示器分辨率后窗口跑到屏幕外
        let onScreen = NSScreen.screens.contains { $0.visibleFrame.intersects(restored) }
        if !onScreen, let screen = NSScreen.main {
            restored.origin = NSPoint(x: screen.visibleFrame.maxX - restored.width - 28,
                                      y: screen.visibleFrame.maxY - restored.height - 12)
        }
        return restored
    }

    func persistFrame() {
        guard window != nil else { return }
        let f = window.frame
        let obj: [String: Double] = ["x": f.origin.x, "y": f.origin.y, "w": f.width, "h": f.height]
        if let data = try? JSONSerialization.data(withJSONObject: obj) {
            try? data.write(to: frameURL, options: .atomic)
        }
    }

    private func scheduleFramePersist() {
        frameSaveTimer?.invalidate()
        frameSaveTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: false) { [weak self] _ in
            self?.persistFrame()
        }
    }

    // MARK: 拖拽（网页里的 header 区域）

    private var dragTimer: Timer?
    private var dragGap = NSPoint.zero

    func startDrag() {
        guard let window = window else { return }
        let mouse = NSEvent.mouseLocation
        dragGap = NSPoint(x: window.frame.origin.x - mouse.x, y: window.frame.origin.y - mouse.y)
        dragTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            guard let self = self, let win = self.window else { return }
            // 鼠标已经在窗口外松开时，别让窗口继续跟着光标跑
            if NSEvent.pressedMouseButtons & 1 == 0 {
                self.stopDrag()
                return
            }
            let now = NSEvent.mouseLocation
            win.setFrameOrigin(NSPoint(x: now.x + self.dragGap.x, y: now.y + self.dragGap.y))
        }
        RunLoop.main.add(timer, forMode: .common)
        dragTimer = timer
    }

    func stopDrag() {
        dragTimer?.invalidate()
        dragTimer = nil
        persistFrame()
    }

    func windowDidMove(_ notification: Notification) { scheduleFramePersist() }
    func windowDidEndLiveResize(_ notification: Notification) { persistFrame() }
    func windowDidResize(_ notification: Notification) { scheduleFramePersist() }
}

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var owner: BoardController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "save":
            saveState(body["state"])
        case "export":
            exportCSV(name: body["filename"] as? String ?? "SalaryTimer-记录.csv",
                      content: body["content"] as? String ?? "")
        case "quit":
            owner?.persistFrame()
            NSApp.terminate(nil)
        case "dragStart":
            owner?.startDrag()
        case "dragEnd":
            owner?.stopDrag()
        case "log":
            if let text = body["text"] as? String { print(text) }
        default:
            break
        }
    }

    private func saveState(_ state: Any?) {
        guard let state = state else { return }
        ensureDirs()
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]) else {
            notifyJS("window.onSaveResult && window.onSaveResult(false)")
            return
        }
        do {
            try data.write(to: stateURL, options: .atomic)
            notifyJS("window.onSaveResult && window.onSaveResult(true)")
        } catch {
            notifyJS("window.onSaveResult && window.onSaveResult(false)")
        }
    }

    private func exportCSV(name: String, content: String) {
        ensureDirs()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmm"
        let stamp = formatter.string(from: Date())
        let base = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ".csv", with: "")
        let filename = "\(base)-\(stamp).csv"
        let url = exportDir.appendingPathComponent(filename)
        let payload = "\u{FEFF}" + content  // BOM，Excel 才不认成乱码
        do {
            try payload.write(to: url, atomically: true, encoding: .utf8)
            NSWorkspace.shared.activateFileViewerSelecting([url])
            notifyJS("window.onExportResult && window.onExportResult(\(jsonString(url.path)))")
        } catch {
            notifyJS("window.onExportResult && window.onExportResult(null)")
        }
    }

    private func notifyJS(_ script: String) {
        owner?.webView?.evaluateJavaScript(script, completionHandler: nil)
    }
}

// 无 Dock 图标的应用没有系统菜单栏，手动装一份，保证 ⌘C/⌘V/⌘Q 可用
func installMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    mainMenu.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "退出 SalaryTimer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu

    let editItem = NSMenuItem()
    mainMenu.addItem(editItem)
    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu

    NSApp.mainMenu = mainMenu
}

let controller = BoardController()
let app = NSApplication.shared
app.delegate = controller
app.setActivationPolicy(.accessory)
installMenu()
app.run()
