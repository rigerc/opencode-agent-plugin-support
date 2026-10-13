# OpenCode Claude Hooks Compatibility

OpenCode plugin that runs **Claude Code command hooks from settings files**. This is the sole plugin in this repository. It does **not** load Claude plugin marketplaces, skills, or MCP packages. OpenCode v2 is the primary target; v1 support is provided where object plugin entrypoints are available.

**Install directly from GitHub with OpenCode v2—no local checkout or npm publication is required.** Node.js 20+ is required. Runtime uses only built-in Node modules.

## Settings scopes

Hooks load in deterministic **global → project → project-local** order:

| Scope | Claude Code settings |
| --- | --- |
| Global | `~/.claude/settings.json` |
| Project | `<project>/.claude/settings.json` |
| Project-local | `<project>/.claude/settings.local.json` |

Hook groups in all selected files are appended (not replaced). The last explicit `disableAllHooks` boolean wins, with project-local taking precedence. No settings files are modified, and files are loaded at plugin startup: restart OpenCode after changes.

## Installation (OpenCode v2)

**Recommended: install directly from GitHub.** OpenCode v2 supports npm-compatible Git package specifications. You do **not** need an npm release or a local checkout.

### Global installation (OpenCode CLI)

Install once for all projects:

```bash
opencode plugin add github:rigerc/opencode-agent-plugin-support
opencode plugin list
```

OpenCode fetches the plugin from GitHub. Restart an existing session if necessary:

```bash
opencode service restart
```

Global **plugin** installation means the adapter is available across your projects; the Claude **hooks** it runs are resolved for each current project.

### Global installation (configuration)

Alternatively, add this to `~/.config/opencode/opencode.jsonc` (or `opencode.json`):

```json
{
  "plugins": ["github:rigerc/opencode-agent-plugin-support"]
}
```

Append the entry to any existing `plugins` array. Use either the CLI or the global configuration approach, not both.

### Project-only installation

Add the same entry in `<project>/opencode.jsonc` (or `opencode.json`):

```json
{
  "plugins": ["github:rigerc/opencode-agent-plugin-support"]
}
```

The adapter is then loaded only in that project. By default, it still reads the user's global Claude hooks (`~/.claude/settings.json`) *plus* the project's `.claude/settings.json` and `.claude/settings.local.json`.

### Exclude global Claude hooks

To enable project and project-local hooks only, use the object form in the project's `opencode.jsonc`:

```json
{
  "plugins": [
    {
      "package": "github:rigerc/opencode-agent-plugin-support",
      "options": {
        "scopes": {
          "global": false,
          "project": true,
          "local": true
        }
      }
    }
  ]
}
```

These options control **Claude settings file scopes**; they do not change the scope of the OpenCode plugin installation. Place the same object in the global OpenCode configuration if these defaults should apply to every project.

### Pin to a commit or tag

For reproducibility, use a revision (replace `<FULL_COMMIT_SHA>` with an actual SHA):

```json
{
  "plugins": ["github:rigerc/opencode-agent-plugin-support#<FULL_COMMIT_SHA>"]
}
```

OpenCode also supports Git branches and tags. A full commit SHA is pinned; an unpinned Git package can receive updates through OpenCode's plugin manager.

### Manage and uninstall

For global packages installed with `opencode plugin add`:

```bash
opencode plugin list
opencode plugin check
opencode plugin update
opencode plugin remove github:rigerc/opencode-agent-plugin-support
```

For installations configured in `opencode.json(c)`, remove the `github:` entry from that file to uninstall. Do not install this plugin both globally and locally, or its hooks may execute twice.

### Local checkout (optional, for development)

You can also run the source directly:

```bash
git clone https://github.com/rigerc/opencode-agent-plugin-support.git
cd opencode-agent-plugin-support
npm run check
npm test
```

Add the **absolute directory path** (not `index.js`) to the desired global or project OpenCode configuration:

```json
{
  "plugins": ["/absolute/path/to/opencode-agent-plugin-support"]
}
```

The repository root has the `index.js` entrypoint OpenCode v2 expects. The local checkout is an *alternative* to GitHub package installation, not a prerequisite.

**Requirements:** OpenCode v2 and Node.js 20+. The plugin has no runtime npm dependencies. It is **not currently published to npm** as `opencode-claude-hooks-compat`; use the Git package specification above. For OpenCode v1 (1.18.29+), the legacy `plugin` key and local directory installation may work, but these Git install instructions target v2.

See the [OpenCode v2 plugin documentation](https://dev.opencode.ai/v2/docs/plugins).

## Configure Claude hooks

Example `<project>/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/pretool.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Commands receive Claude-like event JSON on stdin, including `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input` and `tool_use_id` where applicable. They run with the project as their current working directory and with `CLAUDE_PROJECT_DIR` set.

For a PreToolUse rejection, exit with code `2`, or output a JSON object such as:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Command denied by policy"
  }
}
```

`hookSpecificOutput.updatedInput` updates pending tool arguments; `additionalContext` injects text where the corresponding OpenCode event permits it. `PermissionRequest` accepts `hookSpecificOutput.decision.behavior` (`allow` or `deny`). Plain stdout on `SessionStart` and `UserPromptSubmit` is treated as context.

## Hook mappings and limitations

| Claude hook | OpenCode behavior |
| --- | --- |
| `SessionStart` | Session creation, or first session context; once per session |
| `SessionEnd` | Session deletion event |
| `UserPromptSubmit` | Before prompt admission; may block or inject context |
| `PreToolUse` | Before tool execution; may block or modify arguments |
| `PostToolUse` | After successful tool execution; may amend the result |
| `PostToolUseFailure` | After failed tool execution; side effects only |
| `PermissionRequest` | Permission evaluation; allow/deny |
| `PreCompact` | Before compaction; may block or add context |
| `Stop` | Session-idle notification **only**; cannot resume OpenCode |

Only `type: "command"` is supported. Other Claude handler types (`prompt`, `agent`, `http`, `mcp`) and Claude-only lifecycle events are not emulated. Tool names such as OpenCode `shell`, `patch` and `subagent` map to Claude `Bash`, `Edit` and `Task`; MCP tool-name mappings are best effort.

Matchers support exact pipe/comma-delimited tool names and regular expressions. The handler `if` filter implements a conservative `Bash(command glob)`/file-tool subset; unknown conditions are skipped, not treated as unconditional. The default timeout is 30 seconds; `PreToolUse` timeouts fail closed. JSON hook output is interpreted only for supported event behaviors. `async: true` runs without awaiting decisions.

**Security:** Hook commands execute with the user's OS permissions and environment. A global installation will execute commands defined in any project you open. Review `.claude/settings*.json` in untrusted repositories before enabling the plugin. Do not rely on `Stop` hooks to enforce policy in OpenCode.

## Development

```bash
npm run check
npm test
```

The tests use Node's built-in test runner and mocked OpenCode event surfaces; no running OpenCode service is used.

## License and attribution

MIT. The hook execution approach was informed by the former MIT-licensed project by HarnessTap; its original license and copyright notice are retained in `LICENSE`. This repository is now independently maintained.
