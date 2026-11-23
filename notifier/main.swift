// The small app macOS requires for notifications to appear under Ergon's name
// and icon. The server runs it with a title and body for each reminder. macOS
// runs it with no arguments when a notification is clicked.

import AppKit
import UserNotifications

let installedWebApps = [
    "Applications/Brave Browser Apps.localized/Ergon.app",
    "Applications/Chrome Apps.localized/Ergon.app",
]

// Ergon's own Mac app if it is installed, then Ergon installed from a browser, then a browser tab.
func openErgon() {
    if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "local.ergon.app") {
        NSWorkspace.shared.open(app)
        return
    }
    let home = FileManager.default.homeDirectoryForCurrentUser
    let webApp = installedWebApps
        .map { home.appendingPathComponent($0) }
        .first { FileManager.default.fileExists(atPath: $0.path) }
    let address = Bundle.main.object(forInfoDictionaryKey: "ErgonURL") as? String ?? "http://127.0.0.1:8001/"
    if let target = webApp ?? URL(string: address) {
        NSWorkspace.shared.open(target)
    }
}

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var openedFromClick = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        if arguments.count >= 3 {
            post(title: arguments[1], body: arguments[2])
            return
        }
        // Started from Finder or Spotlight rather than a click: just open Ergon.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if !self.openedFromClick { openErgon() }
            NSApp.terminate(nil)
        }
    }

    func post(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            guard granted else {
                FileHandle.standardError.write(Data("Notifications are not allowed: \(String(describing: error))\n".utf8))
                exit(3)
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request) { error in
                if let error {
                    FileHandle.standardError.write(Data("\(error)\n".utf8))
                    exit(4)
                }
                exit(0)
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        openedFromClick = true
        openErgon()
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}

let notifier = Notifier()
let application = NSApplication.shared
application.delegate = notifier
application.setActivationPolicy(.prohibited)
application.run()
