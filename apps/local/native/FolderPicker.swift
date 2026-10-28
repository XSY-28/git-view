import AppKit
import Foundation

private struct FolderChoice: Encodable {
    let cancelled: Bool
    let path: String?
}

@main
struct FolderPicker {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.finishLaunching()

        let panel = NSOpenPanel()
        panel.title = "选择 Git 仓库"
        panel.prompt = "打开仓库"
        panel.message = "选择本机 Git 仓库所在的文件夹。"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.resolvesAliases = true
        let kind = CommandLine.arguments.dropFirst().first
        if kind == "article-file" || kind == "article-folder" {
            panel.title = "导入重大变更文章"
            panel.prompt = "选择"
            panel.message = "选择 Markdown 文章，或包含文章和图片的资料文件夹。"
            panel.canChooseFiles = kind == "article-file"
            panel.canChooseDirectories = kind == "article-folder"
            if kind == "article-file" { panel.allowedFileTypes = ["md", "markdown"] }
        }

        application.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        let response = panel.runModal()
        let choice: FolderChoice
        if response == .OK, let url = panel.url, url.isFileURL {
            choice = FolderChoice(cancelled: false, path: url.path)
        } else {
            choice = FolderChoice(cancelled: true, path: nil)
        }
        panel.orderOut(nil)
        application.deactivate()
        do {
            let encoded = try JSONEncoder().encode(choice)
            FileHandle.standardOutput.write(encoded)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            FileHandle.standardError.write(Data("Folder picker result encoding failed.\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
