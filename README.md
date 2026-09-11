# @brglng/pi-session-sync

[Chinese](README.zh-CN.md)

Bidirectional session synchronization extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It synchronizes Pi’s `.json`, `.jsonl`, and `.md` files between Pi’s effective local session root (plus `<agentDir>/missions`) and one portable target directory.

Local paths become `pi-session-sync://` URIs in the target and return to machine-local paths during reverse sync.

## User guide

### Install

```bash
pi install npm:@brglng/pi-session-sync
```

- Requires Pi `@earendil-works/pi-coding-agent >=0.84.0` for public session-root, idle, and refresh APIs.

### Configure

Create global file `~/.pi/agent/extensions/pi-session-sync/config.json`:

```json
{
  "targetDir": "~/sync/pi-sync"
}
```

- Project-level configuration is not supported.
- `targetDir` is required: use an absolute or `~` path to an existing real, non-symlink directory.
- The synchronization target roots are `targetDir/sessions` and `targetDir/missions`; the child roots are created when missing and must never be symlinks.
- `homeLabel` defaults to `HOME`; `rootLabel` defaults to `ROOT`; `extraPrefixes` defaults to `{}`.
- `extraPrefixes` maps absolute path prefixes to portable labels.

### Run

Start Pi, then run:

```text
/session-sync
```

- Sync is manual. There is no automatic background sync.

### What happens

- An in-memory or `--no-session` session without an actual session directory is refused before fallback, machine-id, or state access.
- Both source roots may be symlinks and all source-tree symlinks are followed (their targets may live outside the roots). A MISSING or DANGLING source root is skipped with a missing-root warning (`rootPresent:false`, `rootUnavailable:false`); a source root that EXISTS but cannot be read (`EACCES`/`EPERM`/`ENOTDIR`/`ELOOP`) is skipped with a root-specific warning and marked `rootUnavailable:true`. Either way only that tree freezes while the other root keeps syncing. A local source symlink whose resolved target is `targetDir` itself or anything inside it is a security error: it is recorded in `SyncSummary.errors` as a nonfatal error (distinct from ordinary warnings), skipped, and never followed, copied, or deleted; other safe files keep syncing.
- Every string inside `.json`, JSONL, and Markdown frontmatter that is an absolute path under `sessionsRoot` or `missionsRoot` is rewritten as a portable URI; out-of-root paths, relative values, and identifiers stay unchanged. Values beginning with `pi-session-sync:` that are not legal root-namespaced URIs are file errors when the value comes from a local source. On target-to-local copies those malformed cwd/URI values are preserved verbatim with a warning instead of failing the sync, and the destination is chosen from the target tree's portable mapping.
- Current-format portable names and URI portable-name parts use the canonical strict spelling only. Legacy loose `encodeURIComponent` spellings (literal `*`, terminal dots) are old/inapplicable content: target-to-local copies preserve them verbatim with a warning, and local-to-target passes reject them as file errors before any write.
- Local-to-target `parentSession` values are strictly validated: an absolute parent must resolve inside `sessionsRoot` to a sessions file URI, and Windows-shaped/UNC, out-of-root, missions-root, malformed, or loose-URI spellings are file errors that stop the sync before staging.

## Technical reference

### Naming

- Portable names combine labels with URL percent encoding; no dependency on `@brglng/pi-portable-sessions`.
- Labels are non-empty, cross-platform-safe Unicode path/URI segments.
- Labels reject `/`, `\\`, `%`, `:`, `?`, `*`, `"`, `<`, `>`, `|`, NUL, controls, `.`, `..`, and trailing `.` or spaces.
- Labels also reject `.pi-session-sync-state.json` and case-insensitive Windows device names `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, and `LPT1`–`LPT9`, including extensions.
- Prefixes and labels may overlap. Prefix matching uses path-segment boundaries and the longest match; distinct equal-length matches are configuration errors.
- An extra prefix equal to built-in `HOME` or `ROOT` overrides that built-in mapping.
- Decoding uses the longest label. One label mapping to multiple prefixes is ambiguous and fails.
- Labels retain semantics: `ROOT` remains `ROOT` even when its decoded path falls under the current machine’s home.
- POSIX identity is case-sensitive and treats `\\` literally; native Windows identity is case-insensitive and treats it as a separator.
- Windows-shaped absolute keys such as `C:/work` and `//server/share` decode on every platform using configured prefix spelling.
- On POSIX, decoded drive and UNC paths are file errors, not local session paths. Schema paths are cross-platform; runtime checks use native rules.

### Root and layout

- Before idle, capture startup cwd, CLI provenance, active-file values, and public `ctx.sessionManager.getSessionDir()`.
- On Pi `>=0.84`, the actual public session directory wins when available; there is no source-root configuration setting.
- If unavailable, fallback precedence is CLI `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, project `.pi/settings.json` over global `~/.pi/agent/settings.json`, then `<agentDir>/sessions`.
- Relative fallback `sessionDir` values resolve from Pi’s process cwd.
- Explicit CLI, environment, and settings roots are flat; the implicit `<agentDir>/sessions` root uses nested `--<encoded-cwd>--` directories.
- `usesDefaultSessionDir()` reports path equality, not provenance; observable equal-path overrides remain flat.
- Without explicit override, nested semantics win if argv provenance is unavailable; equal-path custom embedded roots may be treated as nested.
- Missing argv provenance alone does not reject ordinary defaults; preserve provenance or use a distinct root for flat semantics.

### Lifecycle

- `/session-sync` reserves a runtime lock before waiting for full idle; the lock survives extension reloads in the same Pi process.
- During sync, the process guards switching, forking, tree navigation, compaction, new input, tool calls, and user bash.
- Target replacement commits, then calls public `ctx.switchSession(currentSessionFile)` to refresh Pi’s manager and session tree.
- Only the matching refresh switch is allowed; unrelated lifecycle operations remain blocked, and canceled refresh is failure.
- Refresh target `.jsonl` must begin with a header containing `type: "session"`, string `id`, and string `cwd`; the cwd value must be decodable, but its decoded local path need not exist or be a directory during synchronization.
- Missing or invalid headers, missing `cwd` fields, or undecodable cwd values fail before commit.
- Deleting the active local file or logical target counterpart fails before commit and leaves both sides unchanged.
- The active session directory must be inside `sessionsRoot`: flat equals root; nested is one direct child. The active file dirname must equal it.
- Nested files under custom flat roots or default nested trees are rejected because refresh could move Pi’s session root.

### Transforms

- `.json`, `.jsonl`, and `.md` synchronize. JSON and JSONL parse strictly; Markdown reads standard YAML frontmatter. Every string value that is an absolute path under `sessionsRoot` or `missionsRoot` is recursively rewritten: sessions paths become `pi-session-sync://sessions/<portableName>/<relativePath>`, missions paths become `pi-session-sync://missions/<relativePath>`, and `cwd` keeps its rootless `pi-session-sync://<portableName>` form. Target URIs restore to local absolute paths on reverse sync.
- JSON and YAML number precision is not preserved; ordinary parse/stringify rounding applies.
- Only one terminal newline is allowed; internal or extra blank lines fail.
- Any `pi-session-sync:` prefix must be a valid case-insensitive `pi-session-sync://` URI. (strict for local sources; target-to-local copies preserve invalid values verbatim with a warning).
- Local absolute `parentSession` paths inside `sessionsRoot` become `pi-session-sync://sessions/<portableName>/<relativePath>`; relative values remain unchanged and reverse URIs restore locally. Old rootless file URIs are rejected.
- Parent URI relative paths use `/`, canonical percent-encoded cross-platform-safe segments, and no traversal. Existing references must be regular files; not-yet-created references may be valid.
- POSIX rejects Windows drive and UNC-shaped absolute parents. Flat absolute parents use their own exact or containing mapping, never the current file’s mapping.
- Markdown reads only standard YAML frontmatter at file start, recursively rewrites `cwd`, and leaves the body unchanged. No frontmatter means no `cwd` mapping.
- Frontmatter `parentSession` gets JSONL-equivalent type, URI, range, and Windows-shaped-path validation, but its bytes remain unchanged.
- Valid Markdown absolute and sync references are canonicalized separately for mapping and content hashes.
- YAML AST mutation preserves standard tags, anchors, aliases, comments, scalar values, delimiter whitespace, and significant trailing whitespace/newlines.
- Shared scalar anchors are cloned at `cwd` use sites when needed, protecting non-`cwd` values and the remaining anchor/alias graph. A scalar anchor shared by a `parentSession` field and generic fields is cloned at the `parentSession` use site so parentSession semantics never depend on field order or visited-node dedup; the generic use sites keep the shared graph and may be rewritten independently.

#### Conversion examples

Session `.jsonl`/`.json`/frontmatter (`cwd` keeps its rootless form; every other path-valued field is a generic field):

```text
// local                         // target
{"cwd": "/home/u/work"}          {"cwd": "pi-session-sync://HOME/work"}
{"recordPath": "/home/u/work"}   {"recordPath": "pi-session-sync://sessions/HOME/work/session.jsonl"}
{"ownerSessionId": "/…"}         {"ownerSessionId": "pi-session-sync://sessions/HOME/work"}
```

Missions mirror their tree directly, without portable names:

```text
// local                           // target
{"missionPath": "/…/missions/index/abc.json"}
      →                       {"missionPath": "pi-session-sync://missions/index/abc.json"}
```

Generic fields (any field name besides `cwd`) follow the same recursive path rules as `recordPath`/`ownerSessionId`/`sessionPath`/`artifactPaths` above; they are ordinary path rewrites, and a sessions URI in a generic field never becomes `parentSession` mapping/replay/validation evidence. Only values under the literal `parentSession` key are treated as parent references. `artifactPaths` arrays and other nested values are rewritten element-wise.

On target-to-local copies, invalid portable values are preserved verbatim with a warning instead of failing the sync: the copied local file keeps the raw target spelling and the sync completes. Because the next local→target pass validates strictly, those preserved malformed values will then fail the next sync as file errors (the copied file is written back to the target tree only when Pi later rewrites it); remove or fix the malformed values on the target side to resume.

### Mappings, state, and tombstones

- Target session trees use `<targetDir>/sessions/<portableName>/...`; missions mirror `<targetDir>/missions/...` with their relative tree preserved. Logical state keys namespace missions files with a literal `missions/` prefix; mission entries share the single `targetDir/.pi-session-sync-state.json` with sessions entries. Every file’s logical cwd must match its directory mapping.
- Nested children keep the top-level session cwd. Cwd-less files inherit the nearest unambiguous containing mapping; no mapping is an error.
- Flat roots group each file by its `cwd`. Valid parent references from JSONL or Markdown may establish parent-only mappings without live files.
- Live mapping wins over parent-only evidence, but different semantic labels for one decoded cwd fail, including live versus parent-only references.
- Mission-derived evidence is stored per OWNER entry, not just on the scope. `cwdEvidence` holds the cwd labels a mission file proved, and `missionSessionMappings` holds the parent-only session directory mappings it proved. Both are sliced by machine scope key (`<layout>:<sessionsRoot>::<machineId>`), so one machine’s records never overwrite another’s. Only evidence whose recorded layout matches the current one is read; foreign-layout records are preserved verbatim but never feed the resolver, and a tombstoned owner contributes nothing, so a retired mapping is never resurrected.
- A frozen sessions root keeps the scope mapping fields verbatim and relies on those owner entries: the next round with an available sessions root seeds the persisted `missionSessionMappings` before scanning, so a surviving local absolute spelling re-encodes to its original portable URI. When preflight blocks a mission copy or delete, the owner evidence is recomputed with the blocked sets — a blocked action keeps its side’s on-disk content, so its evidence still counts — and a brand-new mission file whose only transfer was blocked persists a source-side-only entry that never records the blocked transfer as completed. A frozen sessions root still validates mission parent-only evidence against the live target-derived mappings, so an incompatible semantic label for the same Pi local directory stops the sync even though no scope mapping is written.
- Target-root `.pi-session-sync-state.json` is real version-1 JSON with scopes by effective `sessionsRoot` and layout.
- State records logical baselines, canonical hashes and mtimes, directory mappings, deletion tombstones, per-machine snapshots, and normalized naming configuration.
- Scope roots stay case-sensitive; destination checks are conservative. Stable machine id: `~/.pi/agent/extensions/pi-session-sync/machine-id`.
- No local snapshot restores target first; known machines can propagate local deletions.
- Naming changes stop sync instead of migrating existing target trees.
- The first run establishes a common baseline and infers no one-sided deletions. Later missing sides record discovery-time tombstones and can propagate deletion.
- Recovery requires mtime strictly later than the tombstone and changed hash against the current-machine snapshot or common baseline; touching unchanged content does not revive it.
- Newer mtime wins when both sides change; equal mtimes conflict.
- Deletion versus modification uses deletion and modification times.
- Flat tombstoned mappings retire only after their old logical entry is absent. Nested migration moves live entries only; old tombstones stay under their old key before new labels are adopted.
- Tombstone-only old-label trees never become new-label first-seen trees.
- Canonical hashes normalize local paths and sync URIs to one portable representation; native Windows case-folds parent-relative segments, and copies preserve source mtimes.

### Validation and commit boundary

- `sessionsRoot` may be a symlink (source roots are followed); `targetDir` must be an existing real, non-symlink directory, and the two must not overlap.
- Target ancestors are not inspected for symlinks, including macOS `/var` and `/tmp` aliases.
- A local source root (`sessionsRoot` or the `<agentDir>/missions` root) is classified independently and never stops the other tree: the safe root keeps its own files, deletions, tombstones, and empty-directory cleanup. A MISSING or DANGLING root (an absent path, or a root symlink whose target does not resolve) is reported with a missing-root warning and yields `rootPresent:false` with `rootUnavailable:false`. An EXISTING root that cannot be inspected or read (`EACCES`, `EPERM`, `ENOTDIR`, `ELOOP`/symlink cycle, or any other unreadable error) is reported with a root-specific warning and yields `rootUnavailable:true`. Either way only that root is treated as unavailable for the round.
- An unavailable root FREEZES its tree for the round: no file decision, deletion, tombstone, state-entry change, or empty-directory cleanup is derived from the missing/unreadable root, and neither the local nor the target side of that tree is written or removed on its behalf. A frozen sessions tree also keeps the persisted scope mapping fields verbatim: mission-derived session mappings are still used transiently for that round's missions work, but they persist only after a successful local sessions rescan. A frozen missions tree keeps the parent-only session mappings that its surviving target mission content still proves, unless the sessions tree is frozen too and the scope mapping fields therefore stay verbatim.
- Root validation itself defers these missing/unreadable roots to the scanner instead of failing the sync; only a source root that exists and is neither a directory nor a symlink (or a symlinked root that resolves to a non-directory) is a configuration error.
- An unavailable root is distinct from the forbidden source-symlink errors: a source symlink entry whose resolved target lies in `targetDir` is a per-entry nonfatal error in `SyncSummary.errors`, and a source root that itself resolves into `targetDir` is a blocked root whose surviving evidence is preserved. Neither is a `rootUnavailable` warning and neither freezes a tree because a link is unsafe.
- Source-tree symlinks (root and internal) are followed; symlinked files and directories below the target roots are never followed and are ignored with warnings. A local source symlink resolving into targetDir (compared against the physical, fully-resolved target identity so aliased ancestors are covered) is reported as a nonfatal ERROR, distinct from warnings, and is skipped without following, copying, or deleting; other safe files continue syncing.
- Unknown entries, default-root files, and unsupported types are ignored with warnings; unsafe relative segments are errors.
- Local → target `parentSession` strictly references a parent session FILE: a sessions-directory URI (`pi-session-sync://sessions/<portableName>` with no relative path) or a referenced target that exists as a non-regular file is a file error before staging. A missing referenced file stays valid when URI, range, and segment rules pass. Absolute parents must resolve inside `sessionsRoot`; Windows-shaped/UNC, out-of-root, missions-root, malformed, or loose-spelled values stop the sync before staging.
- Root, type, containment, symlink, cross-platform segment, and state checks run before session writes.
- Traversal is deterministic: source and mission directory entries are walked in sorted order, so real-node dedup and mapping precedence never depend on filesystem readdir order.
- State file must be real regular version-1 JSON at target root.
- Malformed current state — invalid JSON, unsupported versions, a malformed version-1 file, or a MIXTURE of current namespaced entries/scopes with old rootless/old-schema topology — stops the sync before scanning or staging and is never silently overwritten. A malformed `entries`/`scopes` container or a malformed scope value is a hard error even when the rest of the file looks old. Only a state file whose ENTIRE topology is recognizably old (all rootless entry keys and/or all old-schema scopes) is ignored with a warning, and its manifest is then preserved on disk unchanged: ignored without migration, deletion, or replacement, while the sync continues with an empty current state.
- Legacy loose portable-name spellings and old top-level `targetDir` layout entries are old/inapplicable content: they are ignored with warnings, never become physical aliases, and no read, write, delete, or cleanup is routed through them.
- All selected files are parsed and validated, then rewritten copies are staged in a temporary directory; the serialized next state is staged there too before any local, target, or state destination is mutated.
- Parse, validation, preflight, or staging failure stops the entire sync before session/state commit; no staged result commits.

### Limitations

- No cross-process race protection or full atomicity guarantee. The commit phase performs no rollback and does not restore local, target, or state results after a mid-commit failure; preflight in-memory restoration for blocked decisions remains part of synchronization safety.
- Pi exposes no cancellable public hook around direct `SessionManager` metadata persistence; public lifecycle guards may still permit synthetic records.
- Windows is not actively supported by this project; pull requests are welcome. Cross-platform naming and foreign-prefix compatibility are implemented.
