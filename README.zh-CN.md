# @brglng/pi-session-sync

[English](README.md)

面向 [Pi coding agent](https://github.com/earendil-works/pi-mono) 的双向同步扩展。它在 Pi 的两个有效本地根目录（`sessions` 与 `<agentDir>/missions`）与一个可移植父目标目录之间同步 Pi 的 `.json`、`.jsonl` 和 `.md` 文件。

两个根目录内的本地路径会在目标目录中转换为 `pi-session-sync://` URI，反向同步时再还原为机器本地路径：sessions 文件映射为 `pi-session-sync://sessions/<portableName>/<relativePath>`，missions 文件映射为 `pi-session-sync://missions/<relativePath>`，`cwd` 保持无根名的 `pi-session-sync://<portableName>` 形式。

## 使用指南

### 安装

```bash
pi install npm:@brglng/pi-session-sync
```

- 需要 Pi `@earendil-works/pi-coding-agent >=0.84.0`，才能使用公开的 session-root、idle 和 refresh API。

### 配置

创建全局配置文件 `~/.pi/agent/extensions/pi-session-sync/config.json`：

```json
{
  "targetDir": "~/sync/pi-sessions"
}
```

- 仅支持全局配置，不支持项目级配置。
- `targetDir` 必填：使用绝对路径或 `~` 路径；父目录必须是已存在的真实目录，且不能是符号链接。
- 同步目标为 `targetDir/sessions` 与 `targetDir/missions` 两个子树；子目录缺失时创建，且本身不能是符号链接。
- `homeLabel` 默认为 `HOME`；`rootLabel` 默认为 `ROOT`；`extraPrefixes` 默认为 `{}`。
- `extraPrefixes` 将绝对路径前缀映射为可移植标签。

### 运行

启动 Pi，然后运行：

```text
/session-sync
```

- 同步只能手动执行，不提供自动后台同步。
- 两个本机源根目录都允许是符号链接并跟随，源树内部的符号链接也跟随；缺失的源根目录忽略并提示 warning。本机源树中解析目标为 `targetDir` 本身或其内部目录/文件的符号链接属于安全错误：按物理真实路径（含祖先别名解析后）判定，作为与 warning 区分的非致命 error 显式记录并跳过该链接，不跟随、不复制、不删除其内容，其它安全文件继续同步。
- `.json`、JSONL 及 Markdown frontmatter 中所有完整表示 sessions/missions 根内绝对路径的字符串都会被改写为 portable URI；根外路径、相对值与普通 ID 原样保留。任何以 `pi-session-sync:` 开头但并非合法根命名空间 URI 的值，在来自本机源时均视为文件错误；从 target 同步回本机时，非合法 URI 及无法解码为可移植路径的 `cwd`/路径字段会原样保留并提示 warning，不中止整次同步，本地落点由 target 树形 portableName 映射确定。
- 当前格式只接受严格规范拼写的可移植名与 URI 可移植名部分。旧的宽松 `encodeURIComponent` 拼写（字面 `*`、末尾点号）属于过时内容：target → local 复制时原样保留并提示 warning，local → target 时作为文件错误拒绝。
- local → target 的 `parentSession` 严格校验：绝对 parent 必须解析到 `sessionsRoot` 内的 sessions 文件 URI，Windows 风格/UNC、根外、missions 根、畸形或宽松拼写的 URI 都会在 staging 前作为文件错误停止同步。

### 运行时行为

- 没有实际 session 目录的内存 session 或 `--no-session` session，会在执行回退处理、访问 machine-id 或 state 之前被拒绝。

## 技术参考

### 命名

- 可移植名称由标签和 URL 百分号编码组成；不依赖 `@brglng/pi-portable-sessions`。
- 标签必须是非空、跨平台安全的 Unicode 路径/URI 段。
- 标签不能包含 `/`、`\\`、`%`、`:`、`?`、`*`、`"`、`<`、`>`、`|`、NUL、控制字符、`.`、`..`，也不能以 `.` 或空格结尾。
- 标签也不能是 `.pi-session-sync-state.json` 或不区分大小写的 Windows 设备名 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`，包括带扩展名的形式。
- 前缀和标签可以重叠。前缀匹配遵循路径段边界，并选择最长匹配；长度相同但彼此不同的匹配属于配置错误。
- 与内置 `HOME` 或 `ROOT` 相同的额外前缀会覆盖相应的内置映射。
- 解码选择最长标签。一个标签对应多个前缀时，结果有歧义，操作失败。
- 标签保留语义：即使 `ROOT` 解码后的路径位于当前机器的 home 目录下，仍保留为 `ROOT`。
- POSIX 标识区分大小写，并将 `\\` 视为字面字符；原生 Windows 标识不区分大小写，并将其视为分隔符。
- `C:/work`、`//server/share` 等 Windows 风格的绝对键，在所有平台上都按配置中的前缀拼写解码。
- 在 POSIX 上，解码出的驱动器路径和 UNC 路径会被视为文件错误，而不是本地 session 路径。schema 中的路径可跨平台使用；运行时检查遵循本机规则。

### 根目录与布局

- 在等待 idle 前，捕获启动时的 cwd、CLI 来源信息、活动文件值，以及公开的 `ctx.sessionManager.getSessionDir()`。
- 在 Pi `>=0.84` 中，只要公开的 session 目录可用，就以实际目录为准；不存在 `source-root` 配置项。
- 如果实际目录不可用，按以下顺序回退：CLI `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、项目 `.pi/settings.json`、全局 `~/.pi/agent/settings.json`，最后是 `<agentDir>/sessions`。
- 回退所用的相对 sessionDir 值，以 Pi 进程的 cwd 为基准解析。
- 通过 CLI、环境变量或设置文件显式指定的根目录都是 flat；隐式的 `<agentDir>/sessions` 根目录使用嵌套的 `--<encoded-cwd>--` 目录。
- `usesDefaultSessionDir()` 报告路径是否相同，而不是来源信息；即使覆盖后的路径相同，仍按 flat 处理。
- 没有显式覆盖时，如果 argv 来源信息不可用，则优先采用 nested 语义；路径相同的自定义根目录也可能被当作 nested。
- 单独缺少 argv 来源信息不会拒绝普通默认值；要表达 flat 语义，请保留 argv 来源信息或使用不同的根目录。

### 生命周期

- 运行 `/session-sync` 时，先获取运行时锁，再等待完全空闲；同一 Pi 进程内重载扩展不会释放该锁。
- 同步期间，进程会阻止 session 切换、fork、树导航、compaction、新输入、工具调用和用户执行的 bash 命令。
- 目标替换提交后，会调用公开的 `ctx.switchSession(currentSessionFile)`，刷新 Pi 的管理器和 session 树。
- 只允许与当前 session 匹配的刷新切换；其他生命周期操作仍会被阻止；refresh 被取消则视为失败。
- refresh 目标 `.jsonl` 必须以 header 开头：`type` 必须是 `"session"`，`id` 和 `cwd` 必须是字符串；cwd 值必须可解码，但同步时不校验解码后的本机路径是否存在或是否为目录。
- 缺少或无效的 header、缺少 cwd 或无法解码的 cwd 值，都会在提交前失败。
- 删除活动本地文件或逻辑上对应的目标文件，会在提交前失败，并保持两侧不变。
- 活动 session 目录必须位于 `sessionsRoot` 内：flat 布局中必须等于根目录，nested 布局中必须是根目录的直接子目录。活动文件的 dirname 必须等于该目录。
- 自定义 flat 根目录下的嵌套文件，或默认 nested 树中的嵌套文件，都会被拒绝，因为 refresh 可能移动 Pi 的 session 根目录。

### 转换

- 只同步 `.json`、`.jsonl` 和 `.md`。JSON 与 JSONL 严格解析；Markdown 读取开头标准 YAML frontmatter。所有完整表示 `sessionsRoot`/`missionsRoot` 内绝对路径的字符串值都会被递归改写：sessions 路径转为 `pi-session-sync://sessions/<portableName>/<relativePath>`，missions 路径转为 `pi-session-sync://missions/<relativePath>`，`cwd` 保持无根名的 `pi-session-sync://<portableName>` 形式；反向同步时 target URI 还原为本地绝对路径。
- 只允许一个末尾换行符；内部换行或多余空行都会失败。
- 凡是以 `pi-session-sync:` 开头的值，都必须是有效的 `pi-session-sync://` URI；方案名匹配不区分大小写。（本机源严格校验；target → local 复制时非法值原样保留并提示 warning，不停止同步。）
- 位于 `sessionsRoot` 内的本地绝对 JSONL `parentSession` 路径，会转为 `pi-session-sync://<portableName>/<relativePath>`；`relativePath` 相对于被引用的 session 目录。相对值保持不变，反向同步时 URI 会还原为本地路径。
- 父级 URI 的相对路径必须使用 `/`、规范化的百分号编码和跨平台安全的路径段，且不得包含目录穿越。已有引用必须指向普通文件；尚未创建的引用目标也可以是有效引用。
- POSIX 拒绝 Windows 驱动器路径和 UNC 风格的绝对父级路径。flat 布局中的绝对父级路径使用自身的精确映射或包含它的映射，绝不使用当前文件的映射。
- Markdown 只读取文件开头的标准 YAML frontmatter，递归重写 `cwd`，并保持正文不变。没有 frontmatter 时不进行 `cwd` 映射。
- frontmatter 中的 `parentSession` 采用与 JSONL 等价的类型、URI、范围和 Windows 风格路径验证，但其中的字节内容保持不变。
- 有效的 Markdown 绝对引用和 sync 引用会分别按映射和内容哈希进行规范化。
- 修改 YAML AST 时，会保留标准的标签（tags）、锚点（anchors）、别名（aliases）、注释（comments）、标量值（scalar values）和分隔符空白（delimiter whitespace），以及有意义的尾随空白和换行。
- 必要时，会在 `cwd` 使用位置克隆共享的标量锚点，以保护非 `cwd` 值和其余的锚点/别名图。当同一个标量锚点同时被 `parentSession` 字段与普通字段引用时，会在 `parentSession` 使用位置克隆，使 parentSession 语义不依赖字段顺序或共享标量的去重顺序；普通字段继续使用共享图并各自独立改写。
- JSON 和 YAML 数值不再要求无损保留；本次变更不考虑任何数值变化，普通 JavaScript/YAML 解析与序列化造成的数值舍入均可接受。

#### 转换示例

session 的 `.jsonl`/`.json`/frontmatter（`cwd` 保持无根形式；其它所有路径字段均按通用字段规则处理）：

```text
// 本地                            // target
{"cwd": "/home/u/work"}           {"cwd": "pi-session-sync://HOME/work"}
{"recordPath": "/home/u/work"}    {"recordPath": "pi-session-sync://sessions/HOME/work/session.jsonl"}
{"ownerSessionId": "/…"}          {"ownerSessionId": "pi-session-sync://sessions/HOME/work"}
```

missions 直接镜像其相对树形，不引入可移植名：

```text
// 本地                               // target
{"missionPath": "/…/missions/index/abc.json"}
      →                         {"missionPath": "pi-session-sync://missions/index/abc.json"}
```

`cwd` 以外的任意字段（`recordPath`、`ownerSessionId`、`sessionPath`、`artifactPaths` 等）都是通用字段，遵循同样的递归路径规则；它们是普通路径改写，通用字段中的 sessions URI 永远不会成为 `parentSession` 映射/重放/校验证据。只有字面 `parentSession` 键下的值才作为父级引用处理。`artifactPaths` 数组及其它嵌套值逐元素改写。

target → local 复制时，非可移植值原样保留并提示 warning，不停止同步：本地副本保留 target 的原始拼写，同步正常完成。但下一次 local → target 同步会严格校验这些值：被保留的畸形值届时会作为文件错误停止同步（本地副本只有在 Pi 后续重写时才会被写回 target 树）；请在 target 侧修复或删除这些畸形值以恢复同步。

### 映射、状态与 tombstone（删除标记）

- 目标目录树使用 `<targetDir>/sessions/<portableName>/...` 与 `<targetDir>/missions/<relativePath>`；nested 布局下的本地子项保留相对路径。每个文件的逻辑 `cwd` 必须与其目录映射一致。
- nested 子项保留顶层 session 的 `cwd`。不含 `cwd` 的文件继承最近且无歧义的包含映射；找不到映射则出错。
- flat 根目录按每个文件的 `cwd` 分组。JSONL 或 Markdown 中的有效父级引用，可以建立没有现存文件的仅父级映射。
- 现存文件的映射优先于仅父级证据，但同一个解码后的 `cwd` 若对应不同的语义标签会失败，包括现存映射与仅父级引用之间的冲突。
- target 根目录下的 `.pi-session-sync-state.json` 是实际存在的 version-1 JSON 状态文件，按 effective `sessionsRoot` 和 layout 划分作用域。
- 状态文件记录逻辑基线、规范化哈希和 mtime、目录映射、删除 tombstone、各机器快照，以及规范化命名配置。
- 作用域根目录保持区分大小写；目标检查采用保守策略。稳定的机器 ID 位于 `~/.pi/agent/extensions/pi-session-sync/machine-id`。
- 没有本地快照的机器会优先从目标端恢复数据；已知机器可以传播本地删除。
- 命名变化会停止同步，而不是迁移现有目标目录树。
- 首次运行建立共同基线，不推断单侧删除。之后，缺失的一侧会记录发现时刻的 tombstone，并可传播删除。
- 恢复要求 mtime 严格晚于 tombstone，且 hash 必须相对当前机器快照或共同基线发生变化；仅 touch 未改变的内容不能使其复活。
- 两侧都发生变化时，mtime 较新的一侧胜出；mtime 相同则冲突。
- 删除与修改的处理依据删除时间和修改时间。
- flat 布局中的 tombstone 映射，只有在旧逻辑条目消失后才会退役。nested 迁移只移动现存条目；采用新标签前，旧 tombstone 仍保留在旧 key 下。
- 仅含 tombstone 的旧标签目录树，永远不会被当作新标签首次发现时使用的目录树。
- 规范化哈希会将本地路径和 sync URI 规范化为同一种可移植表示；原生 Windows 会对相对于父级的路径段做大小写折叠，副本保留源文件 mtime。

### 验证与提交边界

- `sessionsRoot` 允许是符号链接（本机源根目录跟随）；`targetDir` 必须是已存在的真实、非符号链接目录，且两者不得重叠。
- 不检查目标目录祖先的符号链接，包括 macOS 的 `/var` 和 `/tmp` 别名。
- 本机源树（根目录及内部）的符号链接跟随；目标根目录下的符号链接文件和目录永远不会被跟随，会被忽略并发出警告。
- 未知条目、默认根目录文件和不支持的类型会被忽略并发出警告；不安全的相对路径段会报错。
- local → target 的 `parentSession` 必须严格指向父会话文件：sessions 目录 URI（`pi-session-sync://sessions/<portableName>`，无相对路径）或被引用目标存在但不是普通文件，都会在 staging 前作为文件错误停止同步；被引用文件不存在时，只要 URI、范围与路径段规则通过仍然有效。绝对 parent 必须解析到 `sessionsRoot` 内；Windows 风格/UNC、根外、missions 根、畸形或宽松拼写的值同样在 staging 前停止同步。
- 根目录、类型、包含关系、符号链接、跨平台路径段和状态检查都会在写入 session 前完成。
- 遍历顺序确定：本机源与 missions 目录条目按排序后的顺序遍历，真实节点去重与映射优先级绝不依赖 readdir 顺序。
- 状态文件必须位于 target root 下，且是实际存在的普通 version-1 JSON 文件。
- 当前格式的状态文件若畸形（非法 JSON、版本不受支持、version-1 结构损坏，或当前命名空间条目/scope 与旧的无根名/旧 schema 拓扑混存），会在扫描和暂存之前停止整个同步，绝不静默当作空状态覆盖。`entries`/`scopes` 容器畸形或任一 scope 值畸形时，即使文件其余部分看似旧格式，也是硬错误。只有当状态文件的整体拓扑都可识别为旧格式（全部为无根名 entry key 和/或全部为旧 schema scope）时，才以 warning 形式忽略，且旧状态清单在磁盘上原样保留：不迁移、不删除、不静默替换，本次同步以空状态继续。
- 旧的可移植名称宽松拼写及 targetDir 顶层的旧布局条目均属于过时数据：以 warning 忽略，绝不作为物理别名，也不通过它们执行任何读取、写入、删除或清理。
- 所有选中文件都会先解析和验证，再将重写后的副本暂存到临时目录；序列化后的 next state 也必须在任何本机、target 或 state 目标发生写入前完整暂存到该目录。
- 解析、验证、预检或暂存失败，会在提交 session/state 前停止整个同步；不会提交任何暂存结果。

### 限制

- 不提供跨进程竞争保护，也不保证完整原子性。正式提交阶段不执行 rollback，提交中途失败时不恢复已经写入本机、target 或 state 的结果；preflight 为阻止不安全写入而进行的内存状态恢复仍属于同步安全机制。
- Pi 没有围绕直接 `SessionManager` 元数据持久化提供可取消的公开钩子（hook）；公开的生命周期防护仍可能允许生成合成记录（synthetic records）。
- Windows 目前不是本项目积极支持的平台；欢迎提交 PR。跨平台命名和外来前缀兼容性已实现。
