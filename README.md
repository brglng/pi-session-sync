# @brglng/pi-session-sync

Bidirectional session synchronization extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It synchronizes only Pi’s `.jsonl` and `.md` files between Pi’s effective local session root and one portable target directory.

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
  "targetDir": "~/sync/pi-sessions"
}
```

- Project-level configuration is not supported.
- `targetDir` is required: use an absolute or `~` path to an existing real, non-symlink directory.
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
- Refresh target `.jsonl` must begin with header `type: "session"`, string `id`, and string `cwd`; decoded cwd must exist as a directory.
- Missing or invalid headers, missing cwds, and non-directories fail before commit.
- Deleting the active local file or logical target counterpart fails before commit and leaves both sides unchanged.
- The active session directory must be inside `sessionsRoot`: flat equals root; nested is one direct child. The active file dirname must equal it.
- Nested files under custom flat roots or default nested trees are rejected because refresh could move Pi’s session root.

### Transforms

- Only `.jsonl` and `.md` synchronize. JSONL parses line by line and recursively transforms string `cwd` and `parentSession` fields; local `cwd` becomes `pi-session-sync://<portableName>`, and target URI becomes local absolute path.
- Only one terminal newline is allowed; internal or extra blank lines fail.
- Any `pi-session-sync:` prefix must be a valid case-insensitive `pi-session-sync://` URI.
- Local absolute JSONL `parentSession` paths inside `sessionsRoot` become `pi-session-sync://<portableName>/<relativePath>` relative to the referenced session directory; relative values remain unchanged and reverse URIs restore locally.
- Parent URI relative paths use `/`, canonical percent-encoded cross-platform-safe segments, and no traversal. Existing references must be regular files; not-yet-created references may be valid.
- POSIX rejects Windows drive and UNC-shaped absolute parents. Flat absolute parents use their own exact or containing mapping, never the current file’s mapping.
- Markdown reads only standard YAML frontmatter at file start, recursively rewrites `cwd`, and leaves the body unchanged. No frontmatter means no `cwd` mapping.
- Frontmatter `parentSession` gets JSONL-equivalent type, URI, range, and Windows-shaped-path validation, but its bytes remain unchanged.
- Valid Markdown absolute and sync references are canonicalized separately for mapping and content hashes.
- YAML AST mutation preserves standard tags, anchors, aliases, comments, scalar values, delimiter whitespace, and significant trailing whitespace/newlines.
- Shared scalar anchors are cloned at `cwd` use sites when needed, protecting non-`cwd` values and the remaining anchor/alias graph.
- JSON and YAML numbers JavaScript cannot preserve losslessly are rejected before staging, never rounded or converted to `null`.

### Mappings, state, and tombstones

- Target trees use `<targetDir>/<portableName>/...`; nested local children retain relative paths. Every file’s logical cwd must match its directory mapping.
- Nested children keep the top-level session cwd. Cwd-less files inherit the nearest unambiguous containing mapping; no mapping is an error.
- Flat roots group each file by its `cwd`. Valid parent references from JSONL or Markdown may establish parent-only mappings without live files.
- Live mapping wins over parent-only evidence, but different semantic labels for one decoded cwd fail, including live versus parent-only references.
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

- `sessionsRoot` and `targetDir` must be existing real, non-symlink directories and must not overlap.
- Target ancestors are not inspected for symlinks, including macOS `/var` and `/tmp` aliases.
- Symlinked files and directories below either root are never followed; they are ignored with warnings.
- Unknown entries, default-root files, and unsupported types are ignored with warnings; unsafe relative segments are errors.
- Root, type, containment, symlink, cross-platform segment, and state checks run before session writes.
- State file must be real regular version-1 JSON at target root.
- All selected files are parsed and validated, then rewritten copies are staged in a temporary directory.
- Parse, validation, preflight, or staging failure stops the entire sync before session/state commit; no staged result commits.

### Limitations

- No cross-process race protection or full atomicity guarantee; rollback is outside acceptance scope.
- Pi exposes no cancellable public hook around direct `SessionManager` metadata persistence; public lifecycle guards may still permit synthetic records.
- Windows is not actively supported by this project; pull requests are welcome. Cross-platform naming and foreign-prefix compatibility are implemented.
