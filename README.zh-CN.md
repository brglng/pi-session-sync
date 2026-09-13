# @brglng/pi-session-sync

[English](README.md)

`@brglng/pi-session-sync` 是面向 [Pi coding agent](https://github.com/earendil-works/pi-mono) 的手动双向同步扩展。它在 Pi 实际使用的本机会话／任务目录与一个可移植目标目录之间同步文件。

## 安装

```bash
pi install npm:@brglng/pi-session-sync
```

需要 `@earendil-works/pi-coding-agent >=0.84.0`。

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
- portable name 由 label 和 prefix 配置决定。若希望不同机器生成稳定的目录名，请分别维护一致的命名配置。
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
- sessions 或 missions 根目录内的绝对路径，会在 target 中转换为 `pi-session-sync://` URI，反向同步时再恢复为本机路径。
- `cwd` 使用无根名 URI，例如 `pi-session-sync://HOME/project`。
- `parentSession` 和其它路径字段使用带 `sessions` 或 `missions` 命名空间的 URI。
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

扩展会在写入前检查根目录、文件类型、结构化内容、portable URI、`parentSession` 引用和符号链接边界。解析、校验、preflight 或 staging 失败时，会在目标写入前停止同步。
