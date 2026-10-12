# @brglng/pi-session-sync

[English](README.md)

`@brglng/pi-session-sync` 是面向 [Pi coding agent](https://github.com/earendil-works/pi-mono) 的手动双向同步扩展。它在 Pi 实际使用的本机会话／任务目录与一个可移植目标目录之间同步文件。

## 安装

```bash
pi install npm:@brglng/pi-session-sync
```

需要 `@earendil-works/pi-coding-agent >=0.84.0`。

如果在 `settings.json` 中直接导入本地目录，Pi 不会自动为该目录安装 npm 依赖。首次使用前，请在扩展目录执行一次：

```bash
cd /path/to/pi-session-sync
npm install --omit=dev
```

也可以使用 `pi install /path/to/pi-session-sync` 将本地目录作为 Pi package 安装，或使用上面的 npm 安装方式。`yaml` 是 Markdown frontmatter 所需的运行时依赖。

## 配置

创建全局配置文件：

`~/.pi/agent/extensions/pi-session-sync/config.json`

```json
{
  "targetDir": "~/sync/pi-session-sync"
}
```

需要注意：

- 只支持扩展全局配置，不支持项目级扩展配置。
- `targetDir` 必填，必须是已存在的真实目录，且不能是符号链接。扩展会管理其中的 `sessions` 和 `missions` 子目录。
- `homeLabel` 默认是 `HOME`；`rootLabel` 默认是 `ROOT`；`extraPrefixes` 默认是 `{}`。
- portable name 在 HOME、ROOT 和全部 `extraPrefixes` 中按绝对路径段边界选择最长匹配 prefix；显式 extra prefix 与内置 prefix 相同时优先使用显式配置。
- 本机 session 根目录以 Pi 当前 `SessionManager` 的有效配置为准，扩展没有额外的 session 根目录配置项。

## 运行

启动 Pi 后执行：

```text
/session-sync
```

同步是手动操作，不提供后台自动监听。

## 同步内容

- Session 文件：`.json`、`.jsonl` 和 `.md`。
- Mission 文件：`.json`、`.jsonl` 和 `.md`，保留 missions 根目录下的相对目录结构。
- sessions 或 missions 根目录内的绝对路径，会在 target 中转换为 `pi-session-sync://` URI，反向同步时再恢复为本机路径。Pi 对话和工具内容子树（例如 `message` 内容、工具参数和结果）视为普通内容，不进行路径或 URI 检查。
- `cwd` 使用无根名 URI，例如 `pi-session-sync://HOME%2Fproject`。同步树外的通用绝对路径只要可由配置 prefix 编码，也使用无根名 URI。
- Session 和 mission 引用使用对应的 `sessions` 或 `missions` 命名空间；`parentSession` 使用 sessions 文件 URI。JSON、JSONL 和 Markdown frontmatter 执行相同转换。
- 当前配置支持的已有 URI 先解码为当前机器的绝对路径，再按当前最长 prefix 重新编码；canonical hash 和 session portable name 同样使用当前规则，不保留原 label，也不会推断其它机器的 HOME 并擅自迁移路径。
- 通用字段中受支持的 rootless URI 与等价绝对路径使用相同编码：missions 根内和已映射 sessions 根内的引用使用对应命名空间；缺少当前 session 映射时，使用当前最长 prefix 的 rootless URI，不虚构 session 名称。`cwd` 和 `parentSession` 保持各自的专用语义。
- 被引用路径无需存在，包括 `parentSession`；不检查其本机存在性或文件类型，仍校验 URI 结构、路径范围和安全路径段。
- 非隐藏空子目录会同步，目录删除也会传播。没有可同步 session 文件的 session 根目录本身不参与同步。
- 删除文件和目录会记录 tombstone，在避免无变化内容立即复活的同时传播删除。

## State 文件

目标根目录下会有 `pi-session-sync-state.json`。

State 保存文件基线、哈希、mtime、tombstone、空目录基线和各机器快照等同步信息；**不会**保存本地目录到 portable name 的映射、通用 mapping evidence、`cwd` evidence 或 mission session mapping。这些映射完全根据当前机器的配置和当前扫描证据重新决定。

因此，不保证不同机器之间的 mapping continuity。扩展不会比较或校验不同机器的命名配置是否产生相同的本地映射。这是扩展明确接受的固有限制。

## 重要限制

- 同步不是跨进程完整事务。最终提交阶段如果中途失败，已经写入的本机、target 或 state 结果不会自动回滚。
- Pi 没有围绕所有直接 session metadata 写入提供可取消的公开 hook，宿主仍可能生成 synthetic record。
- 本机源根目录缺失或不可读时，本次只冻结该目录树，另一棵源树仍可能继续同步。
- Windows 目前不是本项目积极支持的平台。
- 扩展不会自动迁移旧 target 布局或旧 state 格式。

## 安全行为

扩展会在写入前检查实际源／目标根目录与文件类型、结构化内容、portable URI 语法、路径范围和符号链接边界。活动会话刷新仍须满足有效 session header 和可解码 string `cwd` 等 Pi 公开 `switchSession` API 的安全条件。解析、校验、preflight 或 staging 失败时，会在目标写入前停止同步。
