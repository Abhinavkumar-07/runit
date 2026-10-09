# Security

## What runit does

runit does what you would do by hand: it installs a project's dependencies and runs the project's own code. Dependencies can run install scripts. **Only run it on projects you trust.** It is not a sandbox.

## Protections built in

**Before anything runs**
- The first time you run a project in a terminal, runit shows the install commands, the real script text and any install hooks, and asks to continue. It asks again if the project's dependency files change. `--yes` skips this.
- A project that sets its own package registry or Python package source is refused unless you confirm (or pass `--yes`). Git and URL dependencies produce a warning.
- It warns when run as root/administrator, and will not start more than 5 services unless you pass `--all`.
- Text that comes from a project (names, commands) cannot draw on your terminal.

**While installing and running**
- `--safe` skips dependency install scripts (npm, pnpm, yarn, bun `--ignore-scripts`) and installs only prebuilt Python packages.
- Installs never receive cloud or CI secrets from your shell (AWS, GitHub, and similar). `--clean-env` (plus `--env=NAME`) limits what the app itself receives.
- It never runs a Python interpreter that a repository ships as a script, never modifies a virtual environment that belongs to another project, and ignores dependency lines that are really installer options (for example `--index-url`).
- `npm install --no-save` / `npm ci`: your `package.json` and lockfile are not rewritten.
- The built-in static server listens on the local machine only, refuses hidden files (also through symlinks), checks the Host header, and cannot leave the project folder.

**Cleanup and footprint**
- Ctrl+C, SIGTERM, a closed terminal, or `kill -9` on runit stop everything it started. Programs that detach themselves are found by a hidden tag (Linux and macOS). `runit status` and `runit stop` manage sessions.
- It tells you which files it added to your project (`.env`, `.venv`, `node_modules`). It writes nothing outside the project except small notes in `~/.runit/`.

## What it cannot protect you from

- A malicious project can do anything your user account can do once you run it. A container or virtual machine is the right tool for code you do not trust.
- Your shell's other environment variables (such as an `OPENAI_API_KEY`) are passed to the app unless you use `--clean-env`, because many apps need them.

## Reporting a problem

Please open a private security advisory on the GitHub repository, or email the maintainer. Include the exact command, the project layout, and the output. Do not post exploits publicly before a fix is available.
