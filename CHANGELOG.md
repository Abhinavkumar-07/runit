# Changelog

## 0.8.0
- **Docker Compose Prioritization**: when `docker-compose.yml` (or `compose.yaml`) exists and Docker is available, `runit` prioritizes the containerized stack over downloading and compiling host dependencies (`npm install` / `pip install`), preventing dependency conflicts and missing service errors.
- **Dockerfile Support**: added native detection and execution for standalone `Dockerfile` / `Dockerfile.dev` projects (builds image and runs container with host port binding).
- **Docker CLI Flags**: added `--docker` (explicitly prefer Docker environment) and `--no-docker` (disable Docker and force local host runtime execution).
- **AI / ML Frameworks**: added native detection and default port (7860) for Gradio (`gr.Interface`, `gr.Blocks`, `gr.ChatInterface`), and support for Litestar ASGI applications.
- **Modern Python Lockfiles**: added lockfile change tracking (`poetry.lock`, `uv.lock`, `pdm.lock`) into installation stamp checks so environment updates are triggered automatically.
- **Actionable Runtime Diagnostics**:
  - Detects privileged port (< 1024) `EACCES` permission errors with root/admin and alternate port suggestions.
  - Detects legacy OpenSSL 3.0 crypto incompatibilities (`ERR_OSSL_EVP_UNSUPPORTED`) and suggests `NODE_OPTIONS=--openssl-legacy-provider`.
  - Detects offline Docker daemon errors (`Cannot connect to the Docker daemon`).
  - Detects missing Ubuntu/Debian Python `venv` package (`ensurepip is not available`) and recommends `sudo apt install python3-venv`.
  - Actionable hints for local database connection failures (`ECONNREFUSED` on PostgreSQL, MySQL, MongoDB, and Redis).
- **Go Project Layout Edge Cases**:
  - Supports single-file Go applications without `go.mod` (runs `go run main.go`).
  - Detects alternative Go server layouts (`cmd/main.go`, `server/main.go`, `api/main.go`, `backend/main.go`, `app/main.go`, `src/main.go`).
- **Rust Layout Edge Cases**: supports multiple binaries or `src/bin/*.rs` when root `src/main.rs` is absent (`cargo run --bin <name>`).
- **Environment Templates**: expanded automatic template copying to support `.env.dist`, `.env.local.example`, and `.env.development`.
- **CLI Diagnostics**: added `--verbose` CLI flag and structured debug output (`[runit:debug:<topic>]`).
- **PyPI Names**: expanded module-to-package mappings for `fitz` (`pymupdf`), `faiss` (`faiss-cpu`), `pptx` (`python-pptx`), `torchvision`, `torchaudio`, `websocket`, `telegram` (`python-telegram-bot`), `pydantic_settings`, and `OpenGL` (`PyOpenGL`).

## 0.7.1
- **Monorepos**: full support for npm, pnpm, yarn, and Bun workspace member discovery (`workspaces`, `pnpm-workspace.yaml`, and `lerna.json`).
- **Pre-run UI build**: automatically builds unbuilt frontend packages in monorepos (e.g. `@countersign/web`) before starting backend servers that serve static assets.
- **Concurrent workspaces**: discovers and concurrently runs decoupled frontend (e.g. Vite) and backend services across monorepo members.
- **Cached builds**: skips re-building frontend UI if build output directories (`dist`, `build`, etc.) already exist.

## 0.7.0
- Refactor: organized all module-level constants into a unified section to eliminate temporal-dead-zone risks.
- Refactor: extracted modular helpers for package manager resolution, Node/Python version checking, registry scanning, Python venv creation and installation, line parsing, stream handling, and port polling.
- Tests: improved test termination and timeout handling for Windows processes (`isWin ? 150 : 80` poll deadline).
- CI: added automated syntax check (`node --check index.js`) across all platforms and Node versions.

## 0.6.3
- Fix: a duplicate internal function (`procStart`) caused process-tracking comparisons to fail on non-Linux platforms and could leak background processes; now a single, correct definition is used everywhere.
- Fix: `capture()` (used for Python version checks and dry-run pip) now has a 30-second timeout to prevent hangs.
- Fix: session files (`run-PID.json`) are now written atomically (temp file + rename) so `runit status` and `runit stop` never see a half-written file.
- Fix: the stderr tail buffer in install steps no longer allocates a new string on every data event (reduces GC pressure during long installs).
- Fix: `readRuns()` no longer deletes session files on permission errors (only on parse/read errors).
- Removed dead code: duplicate null check in Python detection, unused variable, unreachable branch in Python version matching.
- Moved `STAMP_DIR` declaration to the top of the file, eliminating a fragile forward reference.

## 0.6.2
- The cleanup helper now also checks every second that runit is still alive (a second way to notice a hard kill), and writes a log when `RUNIT_DEBUG=1` is set.

## 0.6.1
- Windows: the cleanup helper now runs from a small file instead of a command-line string (quoting on Windows could break it). If runit is killed hard, the helper stops everything it started.
- Tests wait longer for the cleanup on Windows.

## 0.6.0
- `runit status` lists running sessions; `runit stop [folder]` stops everything a session started (also when runit itself was killed).
- Every program runit starts carries a hidden tag, so programs that detach themselves (daemons, `setsid`) are found and stopped on Ctrl+C (Linux and macOS).
- After setup, runit tells you what it added to the project folder (`.env`, `.venv`, `node_modules`).

## 0.5.0
- Asks before the first run of a project (shows the install commands, the real script text and install hooks); asks again when dependency files change. `--yes` skips it. Only when run in a terminal.
- `--safe`: skip dependency install scripts (npm/pnpm/yarn/bun `--ignore-scripts`, pip `--only-binary=:all:`).
- `--clean-env` / `--env=NAME`: give the project only a short list of environment variables. Installs never receive cloud/CI secrets from your shell.
- Warns about custom package registries / sources (.npmrc, .yarnrc, requirements, pyproject, Pipfile) and git/URL dependencies.
- "Found:" shows the real script text and install hooks; project text can no longer draw on the terminal.
- Static server no longer serves dotfiles through symlinks. Hints only repeat plausible package names.
- `npm ci` when a lockfile exists (falls back to `npm install` if it is out of date).
- Clearer messages: two services wanting one port, `~` paths, package.json that is not a regular file.

## 0.4.0
- A service that fails because another one is still starting gets one automatic retry.
- Smoke-test suite (`npm test`) and GitHub Actions CI on Linux, macOS and Windows.

## 0.3.0
- Python detection rewritten: reads the code first; Flask factories, FastAPI variable names, `requirements/` folders, UTF-16 files, Pipfile pins and git sources, Poetry, conda `pip:` lists, `requires-python`.
- Safer: no planted interpreters, no foreign virtual environments, safe file reads, option-looking dependencies ignored, service cap, root warning.
- Static server hardened (local only, no dotfiles, no path escape, streaming, Host check).
- Reliable shutdown (Ctrl+C, SIGTERM, SIGHUP, kill -9) including servers that ignore SIGTERM.
- URLs are announced only when the app really listens on that port; the port is matched to the app's own process tree.
- Helpful hints for common failures; OS-aware install hints.

## 0.2.0
- First usable version.
