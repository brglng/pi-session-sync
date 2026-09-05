本项目是一个 Pi coding agent 的扩展，用于同步 Pi 会话数据。

## 相关的另一个项目

- 位置：`~/github/brglng/pi-portable-sessions`

该项目使用软链接来实现将会话目录的名称编码为一个可移植的名称。

问题：

- 一些扩展要求会话目录必须不能是软链接
- 会话 `.jsonl` 和 `.md` 文件中的 `cwd` 字段没有改写，其在不同机器上的路径不一致

## 需求

- 包名：`@brglng/pi-session-sync`
- peer 依赖 Pi `@earendil-works/pi-coding-agent >=0.84.0`，使用 session-level idle 语义避免旧版本 flush 尚未完成
- 当前只支持位于 `~/.pi/agent/extensions/pi-session-sync/config.json` 的配置文件，不支持项目级配置
- 配置格式兼容 `pi-portable-sessions`：`{ "targetDir": "...", "homeLabel": "HOME", "rootLabel": "ROOT", "extraPrefixes": { ... } }`
- `targetDir` 必填，只接受绝对路径或 `~` 前缀路径；`homeLabel` 默认 `HOME`，`rootLabel` 默认 `ROOT`，`extraPrefixes` 默认 `{}`
- `extraPrefixes` 的 key 为绝对路径前缀，value 为非空 label；label 与 prefix 允许相互重叠
- label 为单个跨平台安全路径/URI 段：允许 Unicode，但拒绝 `/`、`\\`、`%`、`:`、`?`、`*`、`"`、`<`、`>`、`|`、NUL、控制字符、末尾的 `.` 或空格、Windows 保留设备名（大小写不敏感的 `CON`、`PRN`、`AUX`、`NUL`、`COM1`-`COM9`、`LPT1`-`LPT9` 及其扩展名）以及 `.`、`..`、保留的 `.pi-session-sync-state.json`
- 本机源目录不配置，固定为当前 Pi 实际使用的唯一 sessions 根目录；以当前 Pi `SessionManager` 暴露的实际 sessionDir 为准，覆盖 CLI `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、当前 cwd 下合并后的 global/project settings `sessionDir`、默认 `<agentDir>/sessions`；配置只提供一个 `targetDir` 目标同步目录，不支持多组映射
- 当前 Pi session 为 in-memory/`--no-session` 且没有实际 sessionDir 时，命令必须拒绝同步，不得回退到持久 sessions 根目录
- 当有效 `sessionDir` 是显式 custom 目录（包括 CLI `--session-dir`）时，根部的 `.jsonl`/`.md` 是会话文件，按各文件 cwd 分组到 targetDir/<portableName>/；默认 `<agentDir>/sessions` 布局仍只扫描 `--...--` 会话子目录并忽略根部文件
- 目标同步目录中的子目录，按照 `pi-portable-sessions` 的可移植名称方式编码映射
- 可移植名称使用配置的 `homeLabel`、`rootLabel`、`extraPrefixes` 与 URL percent 编码规则；不读取 `pi-portable-sessions` 配置，不依赖该扩展
- POSIX 路径只将 `/` 视为分隔符，反斜杠是字面字符并应 percent-encode；Windows 路径按原生规则将反斜杠视为分隔符
- 多个 `extraPrefixes` 匹配时，按规范化路径段边界选择最长 prefix；相同长度的不同 prefix 视为配置错误；extra prefix 与 HOME 或 ROOT 规范化后相同的，允许并由显式 extra prefix 覆盖对应内置 prefix
- labels 可以重叠，解码时选择最长匹配 label；同一个 label 对应 home、root 或多个 extra prefix 时视为配置错误/文件错误，不能猜测
- portable label 是名称语义的一部分；跨机器解码后必须保留原 label，不能因目标路径恰好位于当前机器 HOME 下而重新分类
- 不依赖任何其他扩展，不依赖 `@brglng/pi-portable-sessions`
- 允许增加 `yaml` npm 运行时依赖，用于解析标准 YAML frontmatter
- 每次同步时，对 Pi 的会话文件与目标同步目录的会话文件进行双向同步
- 同步时，只同步 `.jsonl` 和 `.md` 文件
- 将本机目录同步到目标目录时，所有 `.jsonl` 和 `.md` 文件中的 `cwd` 字段改写为可移植名称，以 `pi-session-sync://<portableName>` 形式写入；可移植名称规则兼容当前 `pi-portable-sessions` 实现
- 从本机目录同步到目标目录时，`.jsonl` 中的绝对路径 `parentSession` 字段也改写为 `pi-session-sync://<portableName>/<relativePath>`；relativePath 是相对对应会话目录的 POSIX 路径；相对路径 `parentSession` 不改写
- parentSession 同步 URI 为 opaque scheme：portableName 保留兼容编码，relativePath 各段 percent 编码、使用 `/` 分隔，禁止绝对路径与 `..` 越界；relativePath segment 必须是跨平台可表达的安全路径段，拒绝 Windows 设备名、末尾点/空格、冒号、反斜杠及控制字符等会改变 Win32 语义的名称
- parentSession 非字符串、非法同步 URI、越界 relativePath、未按规范 percent 编码的 relativePath segment、sessions 根外绝对路径均视为文件错误并停止同步；合法相对路径原样保留；任何 `pi-session-sync:` scheme 前缀但不是合法 `pi-session-sync://...` URI 的值均视为错误
- 从目标目录同步到本机时，所有 `.jsonl` 和 `.md` 文件中的 `cwd` 字段改写为本机绝对路径，且将文件保存在所对应的 Pi 会话目录（以 Pi 自己的形式编码的目录名）中；如果目录不存在，则创建它
- 从目标目录同步到本机时，`.jsonl` 中的同步 URI `parentSession` 字段改写为本机绝对路径；相对路径 `parentSession` 不改写
- 绝对路径 `parentSession` 如果不在当前 Pi sessions 根目录内，视为文件错误并停止同步；parentSession 指向尚不存在的文件时，只要路径范围、URI 语法和目录边界有效，仍正常改写
- `.jsonl` 按行解析 JSON，递归改写所有名为 `cwd` 的字符串字段；除允许的文件末尾换行外，空白行均视为错误；`.md` 只解析文件开头 `---` 到 `---` 的标准 YAML frontmatter，递归改写其中所有名为 `cwd` 的字符串字段，正文不改；无 frontmatter 视为无 cwd
- Markdown frontmatter 使用 YAML AST 修改，保留非 cwd 字段的标准 tagged scalar 与其它内容；其中出现的 `parentSession` 也必须执行与 JSONL 相同的类型、URI、范围和 Windows-shaped 路径校验；Markdown 输出不改写合法 `parentSession`，但规范 hash 仍须将其中合法的本机绝对路径与同步 URI 归一为同一 portable 表示
- YAML scalar anchor 同时被 cwd 与非 cwd 字段引用时，以保护非 cwd 值为优先；克隆每个 cwd use-site 后改写，保留非 cwd anchor/alias 原值，cwd alias 关系允许必要拆开
- 应考虑会话被删除的情况，同步时要删除已被删除的会话，且防止已被删除的会话重新出现；使用保存在目标目录根部的 `.pi-session-sync-state.json` 隐藏 JSON 状态清单识别删除，状态清单随目标目录跨机器保存
- 首次没有状态清单时，不把单边现有文件判为删除，按 mtime 处理双方现有文件后建立共同基线
- 同步扫描发现一侧缺失时，以发现时的 `now` 记录 tombstone；之后同名文件只有 mtime 严格晚于 tombstone 且内容 hash 相对本机/共同基线确有变化才视为新文件并恢复，否则继续删除；单纯 touch 不恢复；tombstone 过期判断优先于 equal-mtime 冲突判断
- 两端同名文件内容冲突时，按 mtime 较新的一端覆盖较旧的一端
- 状态清单记录每个逻辑文件的共同基线、两端规范内容 hash/mtime 与删除标记；单边删除且另一边未改变时传播删除，删除与修改冲突时按删除时间/修改时间较新者处理；两边内容不同且 mtime 相等时报错
- 规范内容 hash 先将 cwd 与 parentSession 的本机路径/同步 URI 归一为同一 portable 表示后计算；Windows native identity 下 parentSession relativePath segment 仅大小写不同也须归一为同一 hash；复制改写后的文件时保留源文件 mtime，避免表示转换造成 mtime 漂移
- JSONL 中超出 JavaScript 安全整数范围或 finite 范围的数字若无法无损保留，视为文件错误并在 staging 前停止，不得 stringify 成 `null` 或被舍入
- Windows 扁平映射 identity 必须接受 native CWD 仅大小写不同的路径；label 语义仍须区分，POSIX 路径继续使用大小写敏感语义
- 标准 YAML frontmatter 中非 cwd 内容（包括 anchor/alias、tagged scalar 及 frontmatter delimiter 的合法尾部空白）不得因 cwd 改写而失效或丢失
- 应考虑会话内可能含有子会话，应递归同步并保留相对树形；默认布局下每个逻辑会话根目录 basename 映射为 portableName，其下子目录和文件保留相对路径；每个同步相对路径 segment 必须跨平台可表达，POSIX 上遇到 Windows 设备名、末尾点/空格、冒号、反斜杠或控制字符等名称也按文件错误处理；每个目录优先使用其中的 cwd 建立归属，无 cwd 文件继承最近可识别的所在目录归属；完全无法映射时按文件错误处理
- 本机与目标文件都必须严格校验 cwd 与所在逻辑会话目录匹配；默认布局同一会话目录树递归扫描到多个不同 cwd 映射时视为文件错误并停止同步；显式 custom 扁平 sessionDir 根部允许多个 cwd，并按文件分别分组
- 同一 nested Pi localName 下，live target tree 与 parent-only reference（包括 JSONL 及 Markdown frontmatter 中的合法 `parentSession`）若使用不同 semantic portable label，即使解码 cwd 相同，也视为映射错误并停止同步，不能让 parent-only mapping 覆盖 live tree mapping；仅含旧 label tombstone 文件的旧树按旧 key 处理，不得作为新 label 的 first-seen tree，也不得因此阻断 tombstone 传播
- 保留相对树形时，嵌套子目录中的 cwd 必须与顶层会话 cwd 一致；不同 cwd 视为归属错误并停止同步
- 提供 `/session-sync` 命令，用于手动进行同步，暂不支持自动同步

## 错误处理

- 同步时，应不允许 Pi 进行任何影响会话记录的操作，但暂只考虑当前 Pi 进程；命令先等待当前 agent 完全 idle，同步期间取消会话切换、fork、tree、compact，并通过公开 ExtensionAPI 尽力阻断新输入、tool call、user bash
- 不使用 Pi 私有 API 做记录写入闸门；Pi 对直接 metadata 写入及被阻断操作产生的 synthetic record 没有公开可取消钩子，作为当前版本已知 host 限制记录
- 如果同步将 target 内容写入当前活动 session 文件，使用公开 `ctx.switchSession(currentSessionFile)` 自动重新打开当前会话，刷新 Pi 内存中的 SessionManager 与会话树；如果 switchSession 被取消，不得静默报告成功
- 如果删除传播计划删除当前活动 session 文件，则在提交前拒绝整个同步且不写入任何结果；用户退出或切换该会话后再同步
- 如果活动文件不在当前有效 sessionDir 根部，公开 `switchSession(path)` 会造成 sessionDir 漂移时（包括 custom flat 或默认 nested 会话树中的嵌套文件），在提交前拒绝整个同步且不写入任何结果；activeSessionDir 必须位于有效 sessionsRoot 内，flat 布局必须等于 sessionsRoot，nested 布局必须是 sessionsRoot 的直接子目录，activeSessionFile 的 dirname 必须等于 activeSessionDir；POSIX 上这些归属、刷新和删除判断使用原生大小写敏感路径语义
- 本机 sessionsRoot 不存在、是符号链接或非目录时视为配置错误，直接报错并停止整个同步，不读写任一端；会话树内的符号链接文件和目录直接忽略并提示警告；目标目录本身是符号链接仍是配置错误，目标祖先符号链接不校验
- targetDir 根部或会话树内的未识别普通目录、普通文件（非 `.jsonl`、`.md`、状态文件）忽略并提示警告
- 当前版本暂时不考虑竞态、完整原子性或提交阶段 rollback；改写文件与序列化后的 next state 都必须先在临时目录内完整生成，再开始任何本机、target 或 state 目标写入。正式提交按既定顺序执行，提交中途失败不恢复已经写入的本机、target 或 state 结果。preflight 为阻止不安全写入而进行的 blocked decision／nested replacement 内存状态恢复仍然保留
- 同步前应先创建一个临时目录用于临时存放改写后的文件，全部文件写完，没有错误时，才将临时目录中的文件写入目标目录或本机目录
- 如果文件不存在 `cwd` 字段，则认为文件归属于它所在目录对应的会话/子会话目录
- 配置中出现以下情况时，认为是错误的配置，不进行同步，且应提示用户修改配置：
  - 本机 sessions 根目录和目标目录重叠
  - 目标目录不存在
  - 目标目录本身是符号链接；目标目录的祖先路径不做符号链接校验
- 当目标目录中的 `.jsonl` 和 `.md` 文件中的 `cwd` 字段出现以下情况时，认为是文件错误，不进行同步，且应提示用户检查文件内容：
  - `cwd` 字段不是可移植路径
  - `cwd` 字段无法解码为本机路径
  - `cwd` 字段所对应的目录与文件所在的会话目录不匹配
- 不同步 Pi sessions 根目录内的文件，直接忽略并提示警告，不报错
- `cwd` 解码后的本机路径无需存在，也无需是目录；同步不校验该路径的存在性或目录类型，正常同步
- 删除同步文件后，清理会话树内的空目录，但不删除 sessions 根或 targetDir 根
- 本机 sessions 根部的未知普通目录、普通文件（非会话目录、非 `.jsonl`、`.md`）忽略并提示警告，不复制、不删除
- 本机目录内文件全部没有 cwd 且状态清单也没有该目录映射时，视为错误并停止同步
- 同步过程中，如果遇到错误文件，则停止整个同步，临时目录中的文件不会被写入目标目录或本机目录
- cwd 字段值必须是字符串；JSONL 任意行无法解析，或 Markdown frontmatter 无法解析为合法 YAML，均视为错误文件并停止同步
- config.json 缺失、无法解析或 targetDir 缺失/非法时不执行同步；未知配置字段忽略并提示警告
- 状态文件只接受 targetDir 根部的真实普通 `version=1` JSON 文件；符号链接、目录、非法 JSON 或不支持版本均视为错误并停止同步
- `version=1` 状态清单允许按本机身份保存 local 快照：本机扩展目录持久化 machineId，target 状态保存各机器的 local 快照；没有当前机器快照时按 target 优先恢复，有当前机器快照时才传播本机删除
- 命名配置写入状态 scope；命名配置变化或不同机器命名配置不一致时，视为配置错误并停止同步，不自动迁移旧 target 子目录

## 开发时要求

- 不要参考任何历史版本
- 后续 review 不检查 Windows 相关问题；Windows 行为不作为本项目当前验收阻塞条件
- 后续 review 不把提交阶段 rollback 作为验收条件；提交阶段不执行 rollback，也不要求提交中途失败后恢复已经写入本机、target 或 state 的结果。必须保证临时目录内生成的每个改写文件完整、正确；解析、校验、staging 或 preflight 出现错误时不执行提交。preflight 为保证安全而进行的 blocked decision／nested replacement 状态恢复不属于提交阶段 rollback，继续保留

## 已确认的宿主边界

- 当 `SessionManager` 暴露的 `getSessionDir()` 与 Pi 计算出的默认子目录相同，扩展同时读取可观察的 `process.argv` 及有效的环境／global／project settings provenance；明确的 CLI `--session-dir` 或显式 `sessionDir` 即使路径等于默认子目录且 provenance 可观察，也必须按 flat 根处理。没有任何显式覆盖且 Pi 报告默认语义时，默认 nested 优先，即使 argv provenance 不可用；普通 default launch 不得仅因 argv 不可用而拒绝。嵌入式宿主若私自传入同一路径 custom 且不提供 provenance，无法通过 Pi `0.84` 公开 API 区分，可能按 nested 处理，作为已知宿主限制接受。
- 目标 `targetDir` 本身在读取状态、扫描和 staging 前必须是已存在的真实非符号链接目录；不校验目标目录祖先是否为符号链接（包括 macOS 的 `/var` 与 `/tmp` 系统别名）。会话树内部的符号链接仍只警告并忽略。
- 活动刷新只接受目标 `.jsonl` 的首个 entry 是有效 Pi session header（`type=session`、`id` 为字符串、`cwd` 为字符串且可解码）；同步不校验解码后的 cwd 对应本机路径是否存在或是否为目录。缺失／无效 header、缺少 cwd 或无法解码的 cwd 值时拒绝整个刷新；cwd 与文件所在会话目录的映射一致性仍须校验，避免公开 `switchSession` 回退到进程 cwd 或被 Pi 拒绝后留下过期内存状态。普通非活动 cwd-less 文件仍按一般归属规则有效。
- POSIX 上，解码 portable ROOT name 后若是 Windows drive 或 UNC absolute syntax，视为非本机 absolute path，在 target scan、local path computation 和 staging 前拒绝；native Windows decoding 及有效 POSIX／Unicode paths 保持不变。
- 初始本机扫描不完整或 retry 失败时，不能据此退休已有 nested 或 flat mapping；只有成功本机 rescan 并完成决策后才可按既有 tombstone 与 symlink 规则安全退休。nested 语义 label 迁移只迁移 live state；旧 label 的 tombstone 文件先按旧 key 处理，不能作为新 label 的 first-seen 文件。
- 同步保证范围包含：所有改写文件及序列化后的 next state 在临时目录内完整生成；解析、校验、preflight 或 staging 失败时不执行任何提交；正式提交阶段按既定顺序写入，不执行 rollback，提交中途失败时不恢复已写入结果。preflight 内为避免被阻断的 nested replacement 产生错误 state 而进行的内存状态恢复继续保留。

## 需求变更

- 每当有需求发生变更，应更新本文档以反应新的需求
