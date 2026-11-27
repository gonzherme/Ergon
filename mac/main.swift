// Ergon's own Mac app: a window showing Ergon's page in WebKit, with Ergon's menus instead of a
// browser's. Everything Ergon does happens in the page; this only gives it a home on the Mac, with
// a Jot box that opens over any app, Today's count on the Dock icon, and a place in the login items.

import AppKit
import Carbon.HIToolbox
import ServiceManagement
import WebKit

let address = URL(string: Bundle.main.object(forInfoDictionaryKey: "ErgonURL") as? String ?? "http://127.0.0.1:8001/")!

func isErgon(_ url: URL) -> Bool {
    url.scheme == address.scheme && url.host == address.host && url.port == address.port
}

// Links to anything but Ergon open in the browser.
@MainActor var openOutside: (URL) -> Void = { _ = NSWorkspace.shared.open($0) }

// A color of Ergon's page, in light and dark.
func pageColor(_ light: Int, _ dark: Int) -> NSColor {
    func rgb(_ hex: Int) -> NSColor {
        NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
    return NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? rgb(dark) : rgb(light) }
}

// The page's background, so the title bar, and the window before the page appears, match it.
let paper = pageColor(0xf6f5f1, 0x161816)
// The Jot box's own colors, as the page has them.
let panelColor = pageColor(0xfffefa, 0x1e211e), inkColor = pageColor(0x262a26, 0xd8ded6), softColor = pageColor(0xa3a69f, 0x676d65)

// Right-click keeps what a Mac app offers, such as Look Up and Copy, without a browser's Reload or
// Open in New Window.
final class PageView: WKWebView {
    static let browserItems: Set<String> = [
        "WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
        "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierOpenImageInNewWindow", "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierOpenFrameInNewWindow", "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierDownloadMedia", "WKMenuItemIdentifierInspectElement",
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        var kept: [NSMenuItem] = []
        for item in menu.items where !Self.browserItems.contains(item.identifier?.rawValue ?? "") {
            // No separator first, last, or twice in a row.
            if item.isSeparatorItem && kept.last?.isSeparatorItem ?? true { continue }
            kept.append(item)
        }
        if kept.last?.isSeparatorItem == true { kept.removeLast() }
        menu.items = kept
        // With nothing left, as on a task, no menu at all.
        if kept.isEmpty { menu.cancelTrackingWithoutAnimation() }
    }
}

// The Jot box floats over whatever app is in front, without bringing Ergon forward. A panel with
// no title bar only takes typing if it says it can.
final class JotPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor final class Shell: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
                              NSWindowDelegate, NSTextFieldDelegate, NSMenuItemValidation {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    let page = PageView(frame: .zero, configuration: WKWebViewConfiguration())
    let unreachable = NSTextField(labelWithString: "Can't reach Ergon. Trying again…")
    let jotPanel = JotPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 54),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let jotField = NSTextField()
    let jotHint = NSTextField(labelWithString: "Goes to Inbox")
    private(set) var jotShortcut: EventHotKeyRef?
    private var titleWatch: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = menuBar(for: self)

        let content = NSView()
        window.contentView = content
        page.frame = content.bounds
        page.autoresizingMask = [.width, .height]
        content.addSubview(page)
        unreachable.textColor = .secondaryLabelColor
        unreachable.isHidden = true
        unreachable.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(unreachable)
        NSLayoutConstraint.activate([
            unreachable.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            unreachable.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])

        window.title = "Ergon"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = paper
        window.minSize = NSSize(width: 380, height: 420)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        if !window.setFrameUsingName("Ergon") { window.center() }
        window.setFrameAutosaveName("Ergon")

        page.navigationDelegate = self
        page.uiDelegate = self
        page.configuration.userContentController.add(self, name: "todayCount")
        // Weeks start on the Mac's first weekday, as in Calendar, rather than the one its language would pick.
        page.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.systemFirstWeekday = \(Calendar.current.firstWeekday - 1)",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Safari's Develop menu can inspect the page.
        page.isInspectable = true
        page.underPageBackgroundColor = paper
        page.pageZoom = ((UserDefaults.standard.object(forKey: "Zoom") as? Double).map { CGFloat($0) } ?? 1) * Self.actualZoom
        // Shown once loaded, so the window never flashes white.
        page.isHidden = true
        // The title stays hidden, but names the window in the Window menu and Mission Control.
        titleWatch = page.observe(\.title) { [weak self] page, _ in
            MainActor.assumeIsolated { self?.window.title = page.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Ergon" }
        }
        page.load(URLRequest(url: address))
        // The page only syncs while it's on screen; this keeps the Dock's count right when it isn't.
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { if self?.page.isHidden == false { self?.page.evaluateJavaScript("refresh()") } }
        }
        buildJotPanel()
        listenForJotShortcut()
        openAtLoginOnce()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    // Closing the window keeps Ergon open, as Notes does; the Dock icon brings it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showWindow(nil)
        return false
    }

    @objc func showWindow(_ sender: Any?) {
        window.makeKeyAndOrderFront(sender)
    }

    // How large the page shows. Its actual size is a quarter larger than in a browser; View › Zoom In and
    // Zoom Out step from there, as in Safari, and the size it's left at is kept.
    static let actualZoom: CGFloat = 1.25
    static let zoomSteps: [CGFloat] = [0.75, 0.85, 1, 1.15, 1.25, 1.5, 1.75, 2]

    var zoom: CGFloat { page.pageZoom / Self.actualZoom }
    @objc func zoomIn(_ sender: Any?) { setZoom(Self.zoomSteps.first { $0 > zoom + 0.01 } ?? zoom) }
    @objc func zoomOut(_ sender: Any?) { setZoom(Self.zoomSteps.last { $0 < zoom - 0.01 } ?? zoom) }
    @objc func actualSize(_ sender: Any?) { setZoom(1) }

    func setZoom(_ zoom: CGFloat) {
        page.pageZoom = zoom * Self.actualZoom
        UserDefaults.standard.set(Double(zoom), forKey: "Zoom")
    }

    // A menu command the page carries out, as its own key would.
    @objc func command(_ sender: NSMenuItem) {
        showWindow(nil)
        guard let name = sender.representedObject as? String else { return }
        page.evaluateJavaScript("menuCommand('\(name)')")
    }

    // The page sends Today's count as it changes, for the Dock icon, as Mail shows its unread mail.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let count = message.body as? Int ?? 0
        let label = count > 0 ? String(count) : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    // Ergon's own pages open here, and any other link in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, navigationAction.targetFrame?.isMainFrame == true,
              !isErgon(url), url.scheme != "about" else {
            decisionHandler(.allow)
            return
        }
        openOutside(url)
        decisionHandler(.cancel)
    }

    // Links that would open a new window, as a task's links do, go to the browser too.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { openOutside(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        unreachable.isHidden = true
        page.isHidden = false
    }

    // Without Ergon's server there is nothing to show, so the window says so and keeps trying.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        page.isHidden = true
        unreachable.isHidden = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.page.load(URLRequest(url: address))
        }
    }

    // WebKit can stop a page that has been in the background a long time; it comes back where it was.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: webView.url ?? address))
    }

    // The Jot box: the page's own, as a panel of its own.
    func buildJotPanel() {
        jotField.font = .systemFont(ofSize: 17)
        jotField.textColor = inkColor
        jotField.placeholderAttributedString = NSAttributedString(string: "Jot something down",
                                                                  attributes: [.font: NSFont.systemFont(ofSize: 17), .foregroundColor: softColor])
        jotField.isBordered = false
        jotField.drawsBackground = false
        jotField.focusRingType = .none
        jotField.cell?.usesSingleLineMode = true
        jotField.cell?.isScrollable = true
        jotField.delegate = self
        jotField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        jotHint.font = .systemFont(ofSize: 12)
        jotHint.setContentCompressionResistancePriority(.required, for: .horizontal)
        let row = NSStackView(views: [jotField, jotHint])
        row.distribution = .fill
        row.spacing = 12
        row.edgeInsets = NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
        row.translatesAutoresizingMaskIntoConstraints = false

        let box = NSBox()
        box.boxType = .custom
        box.borderWidth = 0
        box.cornerRadius = 12
        box.fillColor = panelColor
        box.contentViewMargins = .zero
        box.contentView?.addSubview(row)
        jotPanel.contentView = box
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: box.leadingAnchor), row.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            row.topAnchor.constraint(equalTo: box.topAnchor), row.bottomAnchor.constraint(equalTo: box.bottomAnchor),
        ])
        jotPanel.backgroundColor = .clear
        jotPanel.isOpaque = false
        jotPanel.hasShadow = true
        jotPanel.isFloatingPanel = true
        jotPanel.hidesOnDeactivate = false
        // On whichever Space is showing, even over an app in full screen.
        jotPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        jotPanel.isReleasedWhenClosed = false
        jotPanel.delegate = self
    }

    // ⌃⌥Space opens the Jot box from any app, while Ergon is open.
    func listenForJotShortcut() {
        var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            MainActor.assumeIsolated { (NSApp.delegate as? Shell)?.toggleJot() }
            return noErr
        }, 1, &pressed, nil, nil)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x45726a6f), id: 1),
                            GetApplicationEventTarget(), 0, &jotShortcut)
    }

    // Shows the Jot box where the page puts its own, centered a fifth of the way down the screen; if
    // it's already showing, puts it away, keeping what was typed.
    func toggleJot() {
        if jotPanel.isVisible { return closeJot(keepText: true) }
        let screen = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        let size = jotPanel.frame.size
        jotPanel.setFrameOrigin(NSPoint(x: (screen.midX - size.width / 2).rounded(),
                                        y: (screen.maxY - screen.height * 0.22 - size.height).rounded()))
        jotHint.stringValue = "Goes to Inbox"
        jotHint.textColor = softColor
        jotPanel.makeKeyAndOrderFront(nil)
        jotPanel.makeFirstResponder(jotField)
    }

    func closeJot(keepText: Bool) {
        if !keepText { jotField.stringValue = "" }
        jotPanel.orderOut(nil)
    }

    // The page adds the task, as its own Jot box does.
    func jot() {
        let title = jotField.stringValue
        if title.allSatisfy(\.isWhitespace) { return closeJot(keepText: false) }
        guard !page.isHidden else { return couldNotJot() }
        page.callAsyncJavaScript("return createTask(title, 'inbox') !== null", arguments: ["title": title], in: nil, in: .page) { [weak self] result in
            if case .success = result { self?.closeJot(keepText: false) } else { self?.couldNotJot() }
        }
    }

    // What was typed stays, to try again once Ergon is back.
    func couldNotJot() {
        jotHint.stringValue = "Can't reach Ergon"
        jotHint.textColor = .systemRed
    }

    // Enter adds what was typed and Esc throws it away, as in the page.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)): jot()
        case #selector(NSResponder.cancelOperation(_:)): closeJot(keepText: false)
        default: return false
        }
        return true
    }

    // Clicking anywhere else puts the Jot box away, keeping what was typed, as in the page.
    func windowDidResignKey(_ notification: Notification) {
        if notification.object as? NSWindow === jotPanel { closeJot(keepText: true) }
    }

    // Ergon opens at login, so the Jot box and the Dock's count are there from the start. Only until
    // that works once, so turning it off, here or in System Settings, stays off.
    func openAtLoginOnce() {
        guard !UserDefaults.standard.bool(forKey: "AddedToLoginItems"), (try? SMAppService.mainApp.register()) != nil else { return }
        UserDefaults.standard.set(true, forKey: "AddedToLoginItems")
    }

    @objc func toggleOpenAtLogin(_ sender: NSMenuItem) {
        let app = SMAppService.mainApp
        if app.status == .enabled { try? app.unregister() } else { try? app.register() }
        if app.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleOpenAtLogin(_:)) { item.state = SMAppService.mainApp.status == .enabled ? .on : .off }
        return true
    }
}

@MainActor func menuBar(for shell: Shell) -> NSMenu {
    func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }
    func item(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        return item
    }
    func own(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let entry = item(title, action, key)
        entry.target = shell
        return entry
    }
    func command(_ title: String, _ name: String, _ key: String = "") -> NSMenuItem {
        let entry = own(title, #selector(Shell.command(_:)), key)
        entry.representedObject = name
        return entry
    }

    let services = menu("Services", [])
    NSApp.servicesMenu = services.submenu
    let window = menu("Window", [
        item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
        item("Zoom", #selector(NSWindow.performZoom(_:))),
        .separator(),
        own("Ergon", #selector(Shell.showWindow(_:)), "0"),
        .separator(),
        item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
    ])
    NSApp.windowsMenu = window.submenu
    let help = menu("Help", [command("Keyboard Shortcuts", "shortcuts")])
    NSApp.helpMenu = help.submenu

    let bar = NSMenu()
    [
        menu("Ergon", [
            item("About Ergon", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            own("Open at Login", #selector(Shell.toggleOpenAtLogin(_:))),
            .separator(),
            services,
            .separator(),
            item("Hide Ergon", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Ergon", #selector(NSApplication.terminate(_:)), "q"),
        ]),
        menu("File", [
            command("New Task", "newTask", "n"),
            command("Jot to Inbox", "jot", "j"),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ]),
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Delete", #selector(NSText.delete(_:))),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            command("Find…", "find", "f"),
        ]),
        menu("View", [
            command("Today", "today", "t"),
            command("Week", "week", "u"),
            command("Sprint Plan", "plan", "U"),
            command("Inbox", "inbox", "i"),
            command("Repeating", "habits"),
            command("Goals", "goals"),
            .separator(),
            command("Search", "search", "l"),
            .separator(),
            own("Actual Size", #selector(Shell.actualSize(_:))),
            own("Zoom In", #selector(Shell.zoomIn(_:)), "+"),
            // ⌘= zooms in too, without Shift.
            { let entry = own("Zoom In", #selector(Shell.zoomIn(_:)), "="); entry.isHidden = true; entry.allowsKeyEquivalentWhenHidden = true; return entry }(),
            own("Zoom Out", #selector(Shell.zoomOut(_:)), "-"),
            .separator(),
            // Picks up a change to Ergon's page.
            { let entry = item("Reload", #selector(WKWebView.reload(_:)), "r"); entry.target = shell.page; return entry }(),
        ]),
        window,
        help,
    ].forEach(bar.addItem)
    return bar
}

// Start

// Uninstalling takes Ergon out of the login items, which only Ergon can do, and forgets it was put
// there, so installing it again puts it back.
if CommandLine.arguments.contains("--leave-login-items") {
    try? SMAppService.mainApp.unregister()
    UserDefaults.standard.removeObject(forKey: "AddedToLoginItems")
    exit(0)
}

MainActor.assumeIsolated {
    let shell = Shell()
    NSApplication.shared.delegate = shell
    NSApplication.shared.run()
}
