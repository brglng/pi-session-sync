# Project Requirements

## Scope

This repository contains the Pi extension `@brglng/pi-session-sync`.

The extension synchronizes Pi session and mission files between:

- Pi’s effective local `sessionsRoot`;
- `<agentDir>/missions`;
- one configured target directory containing `sessions/` and `missions/`.

The current requirements below supersede earlier version sections. Do not use older requirements to justify behavior that conflicts with this document.

## Product rules

- Package name: `@brglng/pi-session-sync`.
- Peer dependency: `@earendil-works/pi-coding-agent >=0.84.0`.
- Configuration is global only: `~/.pi/agent/extensions/pi-session-sync/config.json`.
- `targetDir` is required and must be an existing real, non-symlink directory. The extension manages `targetDir/sessions` and `targetDir/missions`; those child roots may be created but may not be symlinks.
- Naming uses `homeLabel`, `rootLabel`, and `extraPrefixes`, compatible with the portable-name rules used by this extension. Unknown configuration fields are ignored with a warning.
- The local sessions root comes from Pi’s effective public `SessionManager` configuration. Do not add a separate source-root mapping setting or fall back from an in-memory/`--no-session` session to a persistent root.
- Synchronization is manual through `/session-sync`; automatic background synchronization is not supported.
- Sync `.json`, `.jsonl`, and `.md` files. Missions preserve their local relative tree.
- Recursively rewrite path-valued fields according to the current portable URI rules. `cwd` uses a rootless URI; sessions and missions file paths use their respective namespaces; `parentSession` keeps its parent-file safety rules.
- Known conversation and tool-content subtrees, including Pi `message` content and tool arguments/results, are content rather than path metadata and must be preserved without URI/path inspection. Actual path fields outside those subtrees remain recursively checked.
- Non-hidden empty descendant directories are synchronizable content. A session root containing no synchronizable session file is not synchronizable as a root.
- Propagate file and directory deletion with the existing baseline, mtime, hash, and tombstone rules.

## State format: v0.5

The target root state file is `pi-session-sync-state.json`, version 1.

Persist only synchronization state:

- file baselines, hashes, mtimes, tombstones, and per-machine snapshots;
- empty-directory baselines and tombstones;
- scope identity (`format`, `layout`, `sessionsRoot`).

Do **not** persist or validate as current state any local-to-portable mapping relationship, including:

- nested local directory mappings;
- flat relative-file mappings;
- generic mapping evidence;
- mission `cwd` evidence;
- mission session mappings;
- naming configuration snapshots.

Mappings are derived from the current machine’s naming configuration and current local/target scan evidence. Mapping continuity across machines is not guaranteed. The extension must not compare, reject, migrate, or preserve mapping relationships because another machine used different labels or prefixes. This is an intentional extension limitation.

When reading older state, legacy mapping fields may be ignored. When writing state, they must never be emitted. State structural safety for file entries, snapshots, tombstones, logical file keys, and directory baselines remains required.

## Safety and commit boundary

- Source roots may be symlinks and are followed. Source-tree symlinks may resolve outside the source root.
- A source symlink resolving to `targetDir` or anything inside it is a nonfatal synchronization error: skip that link and continue safe work.
- Target-tree symlinks are not followed and are ignored or blocked according to the existing safety rules.
- Missing or unreadable source roots freeze only that tree for the current run; the other tree may continue.
- Validate roots, structured files, portable URIs, parent references, path segments, active-session ownership, and symlink boundaries before destination writes.
- Generate every rewritten file and the next state completely in a temporary directory before commit.
- Parse, validation, preflight, or staging errors must stop before any destination commit.
- The final commit is not fully atomic and does not roll back already-written results after a mid-commit failure.
- Use Pi public APIs only. Active-session replacement uses public `switchSession`; canceled or unsafe refresh is a failure.
- Pi’s lack of a cancellable public hook around direct metadata writes is a known host limitation.

## Runtime and development constraints

- Runtime behavior must not depend on Git or inspect Git metadata.
- Review does not block on Windows behavior; Windows is not an active project acceptance target.
- Backward compatibility is not required unless explicitly stated by a later requirement.
- Do not publish or push changes without explicit user permission.
- Keep implementation and code comments in English. Preserve existing formatting and avoid unrelated refactors.
- Run `pnpm run check`, relevant Vitest tests, and `pnpm run build:types` before declaring an implementation complete.
