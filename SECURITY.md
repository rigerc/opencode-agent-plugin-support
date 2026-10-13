# Security

Claude settings hooks execute shell commands with your OS permissions. Installing this plugin globally runs commands configured by any project that uses it, including potentially untrusted repositories. Review `.claude/settings.json` and `.claude/settings.local.json` before opening unfamiliar projects.

Do not put credentials in hook definitions. `PreToolUse` timeouts are blocked, but unrelated hook failures may not block execution.

Report suspected vulnerabilities through GitHub's private vulnerability reporting if enabled, or contact the repository maintainer privately.
