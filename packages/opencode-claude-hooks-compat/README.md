# OpenCode Claude Hooks Compatibility

Independent OpenCode plugin that runs **Claude Code command hooks from settings files**. It is based on the hook-translation approach in this repository but does **not** load Claude plugin marketplaces, skills, or MCP packages. OpenCode v2 is the primary target; v1 support is provided where object plugin entrypoints are available.

**This package is currently local/source-install only and is not published to npm.** Node.js 20+ is required. Runtime uses only built-in Node modules.

## Settings scopes

Hooks load in deterministic **global → project → project-local** order:

| Scope | Claude Code settings |
| --- | --- |
| Global | `~/.claude/settings.json` |
| Project | `<project>/.claude/settings.json` |
| Project-local | `<project>/.claude/settings.local.json` |

Hook groups in all selected files are appended (not replaced). The last explicit `disableAllHooks` boolean wins, with project-local taking precedence. No settings files are modified, and files are loaded at plugin startup: restart OpenCode after changes.

## Install (OpenCode v2)

Clone this repository and add the **absolute path to this package directory** to your global `~/.config/opencode/opencode.jsonc` or project `opencode.jsonc`:

```json
{
  "plugins": ["/absolute/path/to/opencode-agent-plugin-support/packages/opencode-claude-hooks-compat"]
}
```

The directory contains its own root `index.js`, which OpenCode v2 requires for local directory plugins. Installing it globally enables both global and per-project Claude settings hooks in every project that uses it. Installing it in one project's OpenCode configuration limits activation to that project; by default, the plugin still reads your global Claude settings in that project.

To exclude the global hooks for a project, use an object-style plugin entry on OpenCode releases that support package options:

```json
{
  "plugins": [{
    "package": "/absolute/path/to/opencode-agent-plugin-support/packages/opencode-claude-hooks-compat",
    "options": {
      "scopes": {"global": false, "project": true, "local": true}
    }
  }]
}
```

Avoid loading this package both globally and locally in the same OpenCode session: duplicate plugin instances may run hooks twice.

On OpenCode v1 (1.18.29+), use the `plugin` field rather than `plugins` if local folder plugins are supported by your release.

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
            "command": "node \"\u0024{CLAUDE_PROJECT_DIR}/.claude/hooks/pretool.mjs\"",
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
cd packages/opencode-claude-hooks-compat
npm run check
npm test
```

The tests use Node's built-in test runner and mocked OpenCode event surfaces; no running OpenCode service is used.

## License and attribution

MIT. Adapted conceptually from [opencode-agent-plugin-support](https://github.com/rigerc/opencode-agent-plugin-support), copyright HarnessTap.
