# @brglng/pi-session-sync

[中文说明](README.zh-CN.md)

`@brglng/pi-session-sync` is a manual, bidirectional synchronization extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It synchronizes Pi session and mission files between the effective local roots and one portable target directory.

## Install

```bash
pi install npm:@brglng/pi-session-sync
```

Requires `@earendil-works/pi-coding-agent >=0.84.0`.

If you load this checkout directly as a directory from `settings.json`, Pi does not install that directory’s npm dependencies automatically. Install the runtime dependencies once in the extension directory:

```bash
cd /path/to/pi-session-sync
npm install --omit=dev
```

Alternatively, install the local directory as a Pi package with `pi install /path/to/pi-session-sync`, or use the npm installation above. The `yaml` package is a runtime dependency required for Markdown frontmatter.

## Configure

Create the global configuration file:

`~/.pi/agent/extensions/pi-session-sync/config.json`

```json
{
  "targetDir": "~/sync/pi-session-sync"
}
```

Important points:

- Only the global extension configuration is supported.
- `targetDir` is required and must be an existing real directory that is not a symlink. Its `sessions` and `missions` children are managed by the extension.
- `homeLabel` defaults to `HOME`; `rootLabel` defaults to `ROOT`; `extraPrefixes` defaults to `{}`.
- Labels and prefixes determine portable names. Keep the configuration stable on each machine if you want predictable names.
- The local session root is taken from Pi’s effective `SessionManager` configuration. The extension does not provide a separate session-root setting.

## Run

Start Pi and run:

```text
/session-sync
```

Synchronization is manual. There is no background watcher.

## What is synchronized

- Session files: `.json`, `.jsonl`, and `.md`.
- Mission files: `.json`, `.jsonl`, and `.md`, preserving their relative tree.
- Absolute paths under the sessions or missions roots are converted to `pi-session-sync://` URIs in the target and restored on reverse sync. Known Pi conversation and tool-content subtrees, such as `message` content and tool arguments/results, are preserved as content and are not inspected for paths.
- `cwd` uses a rootless URI such as `pi-session-sync://HOME/project`.
- `parentSession` and other path-valued fields use the namespaced `sessions` or `missions` URI format.
- Non-hidden empty descendant directories are synchronized and deletion is propagated. A session root that contains no synchronizable session file is not synchronized as a root.
- Deleted files and directories are tracked with tombstones so deletion can propagate without immediately resurrecting unchanged content.

## State file

The target root contains `pi-session-sync-state.json`.

The state stores synchronization data such as file baselines, hashes, mtimes, tombstones, empty-directory baselines, and per-machine snapshots. It does **not** store local-directory-to-portable-name mappings, generic mapping evidence, `cwd` evidence, or mission session mappings. Those mappings are derived from the current machine’s configuration and current scan evidence.

This means that mapping continuity across machines is not guaranteed. The extension does not compare or validate whether two machines’ naming configurations produce the same local mapping. This is an intentional limitation.

## Important limitations

- Synchronization is not a full cross-process transaction. A failure during the final commit may leave already-written local, target, or state changes in place.
- Pi does not expose a cancellable public hook around every direct session metadata write; synthetic host records may still be possible.
- A missing or unreadable local source root freezes that tree for the current run while the other source tree may continue.
- Windows is not actively supported by this project.
- The extension does not automatically migrate old target layouts or old state formats.

## Safety behavior

The extension validates roots, file types, structured content, portable URIs, parent-session references, and symlink boundaries before writing staged results. Parse, validation, preflight, or staging errors stop the sync before destination writes begin.
