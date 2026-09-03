# @brglng/pi-session-sync

Bidirectional session synchronization for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

The extension keeps Pi's local session directories in Pi's normal
`--<encoded-cwd>--` layout and mirrors their `.jsonl` and `.md` files into one
portable target directory. Windows is not actively supported by this project;
pull requests are welcome. Session metadata is rewritten while it is mirrored:

- local absolute `cwd` values become `pi-session-sync://<label><encoded-remainder>`
  using configured naming labels;
- target `cwd` URIs become the current machine's absolute paths;
- absolute `parentSession` paths become portable file URIs and are restored on
  the local machine. Flat references keep the referenced path's own mapping;
  they are not assigned the current file's mapping when unresolved.

## Installation

```bash
pi install npm:@brglng/pi-session-sync
```

Pi loads the package extension from its `pi.extensions` entry. The extension
requires `@earendil-works/pi-coding-agent` 0.84.0 or newer for its public
session-root and refresh APIs.

## Configuration

Create the global configuration file
`~/.pi/agent/extensions/pi-session-sync/config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/brglng/pi-session-sync/main/schemas/config.schema.json",
  "targetDir": "~/sync/pi-sessions",
  "homeLabel": "HOME",
  "rootLabel": "ROOT",
  "extraPrefixes": {}
}
```

`targetDir` is required and must already exist as a real directory. Schema
path forms are a cross-platform superset: they accept absolute spellings and
paths beginning with `~`; runtime expands and validates paths using native
platform rules. `homeLabel` and `rootLabel`
default to `HOME` and `ROOT`; `extraPrefixes` defaults to `{}`. Each
`extraPrefixes` key must be an absolute path and each value must be a non-empty cross-platform-safe
Unicode label segment. Labels must not contain `/`, `\\`, `%`, `:`, `?`, `*`, `"`, `<`, `>`, or `|`,
NUL, or control characters. Labels must not end in a dot or space, use a reserved Windows device
name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, or `LPT1`–`LPT9`, case-insensitively, including
extensions), equal `.pi-session-sync-state.json` (case-insensitively), or equal `.` or `..`.
Prefixes and labels may overlap. Schema accepts cross-platform absolute
prefix spellings; runtime validates each prefix with native platform rules.
Windows-shaped `extraPrefixes` keys (for example `C:/work` or `//server/share`)
are intentionally supported on every platform so a target directory written on
another machine can be decoded cross-machine. Decoding returns the configured
prefix spelling; matching and naming-config fingerprints compare case-insensitively
only on native Windows. A Windows-shaped name decoded on POSIX is never treated
as a native local absolute path: such target trees are file errors, not local
sessions.
Matching uses path-segment boundaries, chooses the longest prefix, and rejects
distinct equal-length prefixes. An extra prefix equal to HOME or
ROOT is allowed and overrides that built-in mapping. Decoding chooses the
longest label, but rejects labels that map to more than one configured prefix.
Labels must never equal the reserved state filename
`.pi-session-sync-state.json` (case-insensitively); that basename is reserved
for the sync state manifest at the target root and is never synchronized as a
session file. Project configuration is not supported.

The command captures Pi's process cwd, `ctx.sessionManager.getSessionDir()`, and CLI
`--session-dir` provenance before its idle wait, so Pi's actual effective
session root is used. The public `usesDefaultSessionDir()` method reports path
equality, not override provenance. When an explicit CLI, environment,
global-settings, or project-settings `sessionDir` happens to equal Pi's
computed default child and that provenance is observable, captured provenance
keeps that root's custom flat semantics instead of trusting path equality.
When no explicit override is observable and the reported path equals Pi's
default child, default nested semantics take priority even if argv provenance
is unavailable. An embedded host that passes that same path as a custom flat
root without provenance cannot be distinguished and may be treated as nested;
ordinary default launches are not rejected for missing argv provenance.

If an older host does not expose the actual session directory, the extension
uses observable CLI arguments and settings in Pi's precedence order:

1. `--session-dir <dir>` in `process.argv`;
2. `PI_CODING_AGENT_SESSION_DIR`;
3. `sessionDir` from the Pi startup project's `.pi/settings.json`, merged over
   `~/.pi/agent/settings.json`;
4. `<agentDir>/sessions`.

Relative fallback `sessionDir` values resolve from Pi's process cwd, not a
resumed session cwd. An explicitly configured `sessionDir` is treated as Pi's
flat session root: root and nested `.jsonl`/`.md` files are grouped by their
`cwd` values and written under target portable directories. Files without a
`cwd` inherit the nearest unambiguous containing-directory mapping; files with
no mapping are errors. With no explicit setting, `<agentDir>/sessions` uses
Pi's nested `--<encoded-cwd>--` layout.

A launcher that hides or rewrites `--session-dir` or makes effective
session-directory provenance unreadable cannot be distinguished through Pi
0.84's public APIs when the reported path equals the computed default child.
The extension gives default nested semantics priority for that ambiguous
equal-path launch; preserve provenance or use a distinct custom session root
when flat semantics are required. It still captures `getSessionDir()` itself
and never substitutes a configured fallback when that public value exists.

Portable directory names use configured labels with URL percent encoding.
Defaults are `HOME` and `ROOT`; extra prefixes can assign labels to paths such
as shared workspaces. Native Windows CWD casing differences share one mapping
identity, while POSIX paths remain case-sensitive. Labels remain semantic when
decoded: a `ROOT`-labeled path that happens to be under a machine's current home
directory remains `ROOT`, and round trips preserve its original label. The
extension does not read or depend on `@brglng/pi-portable-sessions`.

## Synchronize

Run the command in Pi:

```text
/session-sync
```

The command waits for Pi to become idle. A command context reporting an
in-memory/`--no-session` session is refused before config fallback, machine-id,
or state access. During synchronization, session switching, forking, tree
navigation, compaction, new input, tool calls, and user bash commands are
guarded in the current Pi process. The runtime-shared lock survives extension
reloads in the same Pi process. Pi may still append a synthetic record for a
blocked operation; these public guards do not promise a record-free transcript.

When target data replaces the current active session file, the command calls
public `ctx.switchSession(currentSessionFile)` after commit to refresh Pi's
in-memory session manager and treats that switch as terminal. A target JSONL
used for this refresh must have a valid first entry that is a Pi session header
with `type: "session"`, string `id`, and string `cwd`; its decoded cwd must
still exist as a directory. Missing or invalid headers, missing cwds, and
non-directory cwds are rejected before commit because Pi would fall back to
process cwd or reject the switch. Ordinary
non-active cwd-less files remain valid. The captured active session directory
itself must be inside effective `sessionsRoot`: flat layout requires it to equal
the root, while nested layout requires one direct child. The active file dirname
must equal that directory using native path semantics (case-sensitive on POSIX).
Nested files under custom flat roots or default nested session trees are rejected
before commit, because switching them would drift Pi's session root. During the
intentional refresh switch, only the matching `session_before_switch` target is
allowed; unrelated switches and all fork/tree/compact operations remain blocked.
If synchronization would delete the active local session file, it fails before
commit and leaves both sides unchanged.

Pi has no public cancellable hook around direct SessionManager persistence for
metadata commands such as `/name`, model changes, thinking-level changes, or
RPC metadata writes. The extension cannot safely monkey-patch private
persistence paths; such direct or synthetic records remain a host API
limitation after the idle barrier.

Before writing either side, the extension parses and validates every selected
file and stages rewritten copies in a temporary directory. A parse error,
malformed URI, ownership mismatch, invalid target, or other file error stops the
sync before staged files are committed.

Only `.jsonl` and `.md` files are synchronized. JSONL is parsed line by line;
all recursive `cwd` and `parentSession` string fields are handled. Only one
empty split element from a terminal newline is allowed; internal or extra
whitespace-only lines are errors. Cwd and parent-session sync URIs accept the
scheme case-insensitively; parent-session URIs also require canonical
percent-encoded relative segments. Windows drive- and UNC-shaped absolute
`parentSession` values are rejected even when running on POSIX.
Markdown rewrites only recursive `cwd` fields inside standard YAML frontmatter
at the start of the file; Markdown body text and frontmatter `parentSession`
fields are unchanged. Frontmatter is mutated as a YAML AST, so unrelated
standard tags, anchors, aliases, comments, and values are preserved. Scalar
anchors used by `cwd` fields are isolated at every `cwd` use-site, even when no
unrelated alias exists; unrelated anchors and aliases retain their original
value and graph. Rendering
removes only the serializer-added document line break; comment-only frontmatter
and significant scalar trailing whitespace/newlines are retained.

A `.pi-session-sync-state.json` file at the target root records scopes keyed
by effective sessions root/layout, portable logical file baselines, hashes,
mtimes, directory mappings, deletion tombstones, per-machine local snapshots,
and each scope's normalized naming configuration. Changing labels or prefixes
causes synchronization to stop rather than migrating existing target trees. Scope identity retains case-sensitive root distinctions, while
filesystem destination checks remain conservative. Each machine keeps its stable identity in
`~/.pi/agent/extensions/pi-session-sync/machine-id`. A machine without a local
snapshot restores target files first; an already-known machine can propagate
its own deletions. Tombstoned flat-path mappings are retired only after their
old logical entry is absent, so a later portable tree may reuse that relative
path. If a complete initial local scan is unavailable, persisted nested and
flat mappings remain available through the retry; they are retired only after
a successful local rescan and its decisions. Nested semantic-label migration
moves live entries only; stale tombstoned old-label files are processed under
their old key before a same-cwd target label is adopted. The first run creates
a baseline without inferring deletions. Later one-sided deletions propagate
and are kept from reappearing unless a recreated file has an mtime strictly
later than its tombstone and a content hash change relative to the current
machine snapshot or common baseline. For a known machine, the current machine
snapshot is used when available; otherwise the common baseline is used. A
merely touched unchanged file does not revive a deletion. When both sides
changed, the newer mtime wins; equal mtimes are reported as conflicts.

The source `sessionsRoot` itself must already exist as a real directory;
a missing, symlinked, or non-directory source root is a fatal configuration error, not an ignored child.
`targetDir` itself must already be an existing real non-symlink directory; a
symlinked target root, missing target, or non-directory target is fatal. Target
ancestors are allowed to be symlinks and are not inspected, including macOS
`/var` and `/tmp` system aliases. Symlinked files and directories below either
root are ignored with warnings and never followed; child symlink safety checks
block only affected logical paths. Unknown root/tree entries are likewise
ignored with warnings. Root and target validation happens before creating
machine-id, state, or session files. Empty session directories are removed
after propagated deletions. The extension makes no cross-process race or full atomicity promise. Rollback is
not part of the current acceptance scope; the guarantee is correct staged files
and no synchronization commit when parsing, validation, staging, or preflight
fails.
