# Git View

[中文](README.md) · [English](README.en.md)

[![Source checks](https://github.com/XSY-28/git-view/actions/workflows/check.yml/badge.svg)](https://github.com/XSY-28/git-view/actions/workflows/check.yml) · [MIT License](LICENSE)

Git View is a local Git GUI for viewing file changes, browsing commit history, comparing revisions, and reading articles about a project's evolution. It supports whole-file staging, commits, and local branch operations, with a preview and confirmation before writes.

The interface supports Chinese and English. Repository data is read through local Git without requiring a remote service. The app is currently a desktop preview, with installers for macOS Apple silicon and Windows x64.

![Commit history and file changes in a browser-based demo repository](docs/verification/screenshots/history-simplification-browser.png)

## Features

| View | Features |
| --- | --- |
| Changes | Separate staged, unstaged, and untracked files; unified or side-by-side diffs with line wrapping. |
| History | Browse the commit graph with visible author dates, filter by branch or tag, and inspect each commit's file changes. |
| Compare | Compare two branches, tags, or commits and inspect commits unique to either side; compare endpoints directly or compare their common ancestor with B. |
| Major changes | Import a Markdown article about the current repository's evolution, with an outline, tables, Mermaid diagrams, and local images; enlarge diagrams for reading. |
| History tools | Search by commit subject, author, ID, or file path; inspect file history, line origins (`git blame`), stashes, and reflogs. |
| Repository operations | Stage or unstage whole files, commit staged contents, and create or switch local branches. |

Selecting a branch in the history sidebar only filters history. Use the current-branch control at the top to create or switch branches. Creating a branch leaves the current branch unchanged; switching requires a clean working tree.

Dates appear directly in the history list so they can be compared with dates in an article. These are author dates displayed in the local time zone; hover to see the full timestamp. Adding dates does not change the existing commit ordering.

## Understanding a project through its evolution

A project may be complex today, but looking back often reveals a sequence of problems and choices that shaped it. What I want to understand is what the problem was, why a particular change was made, and what it cost.

That is why I added the Major changes view. An AI can first organize an article from Git history, which can then be imported into Git View. Read the main changes first and switch to history when a comparison would help, without having to start by reading every line of code. The article's facts and judgments still need verification; Git View displays the material.

The **“航母是怎样建成的”** skill (How an Aircraft Carrier Is Built; `evolutionary-understanding`) is a recommended companion. Use it to trace key design changes through a project's Git history and explain the problems, choices, and tradeoffs behind them. Save the result as Markdown and import it into Major changes. The skill organizes and explains the material; Git View provides the reading interface. Articles written manually or prepared with other tools can also be imported.

![Reading an article about DSH's evolution in Git View](docs/verification/screenshots/major-changes-native-article.png)

To use it:

1. Open a repository, select Major changes, and click Import article.
2. Choose a Markdown file, or a folder containing the article and its images. If the folder contains several articles, choose the main document.
3. Read using the outline. Tables and Mermaid diagrams render in the article; images and diagrams can be opened and enlarged.

The article and its images are saved locally and remain readable after moving the source files or restarting the app. Each repository currently holds one article; use Replace article to update it. Switching to history and back preserves your reading position. A [DSH example in Chinese](docs/examples/dsh-evolution.md) is available to download and try.

> Major changes and dates in the history list are implemented in the current source. The public v0.3.0 installers do not include these features yet. To use them now, [build from source](#building-from-source-macos).

<details>
<summary>Article format and limits</summary>

Use UTF-8 Markdown. Standard headings produce the outline, and Mermaid code blocks are rendered locally. Images may be PNG, JPEG, GIF, WebP, or SVG and must use relative paths within the article folder; download remote images first. Limits are 512 KiB for the document, 4 MiB per image, and 6 MiB for all images combined.

Linked worktrees share the article. Missing images or diagram syntax errors are reported separately without blocking the rest of the text. A failed import preserves the previous article. Dates in the article remain as written and are not automatically linked to commits.

Article reading has been checked in the installed macOS app. Physical Windows machines have not been retested. See the [verification record in Chinese](docs/verification/2026-10-28-major-changes.md).

</details>

## Installation

Download an installer and its `.sha256` checksum file from [GitHub Releases](https://github.com/XSY-28/git-view/releases/latest); no login is required. Both packages bundle Node.js. Running the app requires system Git but no separate Node.js, pnpm, or Rust installation.

- **macOS Apple silicon:** download `macos-arm64.dmg`, quit Git View, open the disk image, and double-click **Install Git View.command**. The app is installed at `~/Applications/Git View.app`; the previous version is saved as a ZIP. Eject the disk image when finished. Do not create another copy in `/Applications`.
- **Windows x64:** download `windows-x64-setup.exe`, run the installer, and open the app from the Start menu. Git for Windows and WebView2 are required; the installer downloads WebView2 if needed. The Windows desktop app supports staging, unstaging, commits, and creating or switching local branches.

The packages are not code-signed or notarized by Apple, so the system may be unable to verify the publisher. After checking the download source, use the system's “Run anyway” or “Privacy & Security → Open Anyway” option rather than disabling system security. Full installation, checksum, and removal instructions are in the [installation guide in Chinese](docs/INSTALL.md).

### Building from source (macOS)

Building requires Git, Node.js **24.19.0**, pnpm **11.7.0**, Rust, and Xcode Command Line Tools. CI uses Rust 1.99.0.

Quit any running Git View instance, then run:

```sh
git clone https://github.com/XSY-28/git-view.git
cd git-view
pnpm install --frozen-lockfile
pnpm build
pnpm build:desktop
pnpm install:desktop --dry-run
pnpm install:desktop
open "$HOME/Applications/Git View.app"
```

`--dry-run` only checks installation prerequisites. The app is installed at `~/Applications/Git View.app`, and the previous version is saved as a ZIP. The installer removes the build copy.

The installed app bundles Node.js and still requires system Git. Running it does not require a separate Node.js, Rust, or Swift installation.

> ⚠️ The desktop package is not notarized.

Press `⌘O` or click **Open repository… / 打开仓库…** to select a local Git repository. An absolute path can also be entered in the repository switcher.

Click a file to inspect its diff; select its checkbox to include it in a staging operation. Staged changes compare HEAD with the index; unstaged changes compare the index with working files. A commit uses only staged contents.

<details>
<summary>Demo repository</summary>

Run this from the project root:

```sh
node scripts/create-demo.mjs
```

The script creates a repository in a temporary directory and prints its absolute path without modifying existing repositories. Enter that path in the app's manual path field to open it.

The demo's `hello.txt` was staged and then edited again, so it appears in both staged and unstaged lists, with a separate diff for each.

</details>

## Updating

Installer users should quit Git View, download the new version, and reinstall. On macOS, the previous version is backed up as a ZIP.

For a macOS source installation, quit Git View and run this from the project root:

```sh
pnpm update:desktop
open "$HOME/Applications/Git View.app"
```

`update:desktop` builds and installs the app. If it has already been built, use `pnpm install:desktop`. For restoring a backup or addressing duplicate Spotlight entries, see the [desktop installation notes in Chinese](docs/verification/2026-10-06-desktop-install.md).

## Support and limitations

The macOS Apple silicon app has been checked on a physical machine. Windows CI verifies actual installation, the native window, and repository operations; physical Windows 10/11 machines have not been retested. See the [installer verification record in Chinese](docs/verification/2026-10-07-windows-operations.md).

- Push, merge, rebase, and history rewriting are not available. Remote-tracking refs come from the local repository and are not fetched automatically.
- Staging operates on whole files, not selected lines or hunks. Writes require a conventional repository and index; conflicts, ongoing Git operations, submodules, special index modes, and external content filters are rejected. Git's built-in `text`, `eol`, and autocrlf line-ending conversions are supported; `ident` and `working-tree-encoding` conversions are not.
- Commits preserve the repository's hooks and signing settings, and switching branches runs configured hooks. The preview asks for authorization. If the repository changes after preview, a new preview is required.
- Text previews are not expanded for binary or non-UTF-8 content, files larger than 1 MiB, or files with more than 10,000 lines. Bare repositories and partial/promisor clones are unsupported. Working files are not scanned when external clean/process filters are in use.

File history follows ordinary renames along the first-parent chain, and blame refers to committed versions. Reflog inspection supports only the files ref-storage backend. Stashes and reflogs can be inspected but not restored or deleted. Common-ancestor comparisons require a unique merge base.

Details and verification results are documented in Chinese for [staging](docs/verification/2026-10-06-stage-files.md), [commits and branches](docs/verification/2026-10-06-commit-branches.md), [revision comparison](docs/verification/2026-10-06-revision-comparison.md), and [history tools](docs/verification/2026-10-07-history-investigation.md). Passing CI does not mean every platform's native interface has been verified.

## Browser and CLI

A browser interface is also available on macOS. It requires local Node.js 24, Git, and a browser. After installing dependencies and running `pnpm build` in the project root, run:

```sh
node dist/cli.mjs open --repo "/absolute/path/to/your/repository" --json
```

Replace the path with the absolute path of your local repository. `pnpm open` opens this project's repository. The service listens only on `127.0.0.1`. After rebuilding, run `pnpm stop` before opening it again.

To query only the repository overview:

```sh
node dist/cli.mjs inspect --repo "/absolute/path/to/your/repository" --json
```

For the desktop CLI and Codex integration, see the [local entry-point guide in Chinese](integrations/codex/README.md). Language preferences, recent repositories, and runtime metadata are stored under `~/.local/share/git-view` by default. Set `GIT_VIEW_HOME` to use another directory.

## Development

Install dependencies in the project root, then run:

```sh
pnpm check
pnpm exec playwright install chrome
pnpm test:e2e
pnpm test:install-desktop
```

`pnpm check` checks for numbered file copies, type errors, source-test failures, and build failures. Installation tests run on macOS; test repositories use temporary directories, and system registration and search-service operations use substitutes.

For local desktop development, install with `pnpm update:desktop` as described above and open the app from its fixed installation path. Use `pnpm build:desktop` for CI or packaging without installation.

Implementation notes in Chinese cover the [core architecture](docs/decisions/0001-implementation-baseline.md), [desktop host](docs/decisions/0002-desktop-host.md), and [maintenance conventions](docs/decisions/0005-maintenance-contracts.md).

Issues and pull requests are welcome on [GitHub](https://github.com/XSY-28/git-view/issues). Include the platform, version, reproduction steps, and expected versus actual behavior. Remove private information from logs and screenshots before sharing them.

## License

[MIT](LICENSE). The desktop package includes the [Node.js runtime license](apps/desktop/licenses/node-v24.19.0-LICENSE); third-party dependencies retain their respective licenses.
