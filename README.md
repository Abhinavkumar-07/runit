# runit

**One command to install and run a project you did not write.**

You cloned a repo, got a folder from a friend, or an AI gave you a project, and you do not know how to start it. Python needs a virtual environment and `pip`. React needs `npm install` and `npm run dev`. Something else needs something else. `runit` looks at the folder, installs what is missing, starts the app, and prints a clickable `localhost` link.

```
cd some-project
runit
```

```
✔ frontend (Next.js) is ready -> http://localhost:3000   (Ctrl+click to open)
✔ backend (FastAPI) is ready -> http://127.0.0.1:8000
   API docs -> http://127.0.0.1:8000/docs
```

> **Beta (0.x).** It handles common project types well, but it is not magic. See [Limits](#limits).

## Install

```
npm install -g runit-cli
```

Needs Node.js 18 or newer. No other dependencies. Or try it once with `npx runit-cli`.

## Usage

```
runit [folder] [options]
runit status            show runit sessions that are running
runit stop [folder]     stop everything a session started
```

| Option | What it does |
|---|---|
| `--dry`, `--dry-run` | Show what it found and would run. Changes nothing. |
| `--no-open` | Do not open the browser automatically. |
| `--yes`, `-y` | Do not ask for confirmation, and allow package sources the project chose itself. |
| `--safe` | Install without running dependency install scripts (npm, pnpm, yarn, bun `--ignore-scripts`; pip prebuilt packages only). |
| `--clean-env` | Give the project only a short list of environment variables. Add more with `--env=NAME,NAME`. |
| `--all` | Allow starting more than 5 services at once. |
| `--version`, `--help` | Version and help. |

The first time you run a project in a terminal, runit shows the install commands, the real script text and any install hooks, and asks `Continue? [Y/n]`. It remembers your answer until the project's dependency files change.

## What it runs

| Stack | How it is recognised | Started with |
|---|---|---|
| Next.js, Nuxt, Astro, SvelteKit, Remix, Gatsby, Vite (React/Vue/Svelte), Angular, CRA, Vue CLI | `package.json` dependencies | the `dev` / `develop` / `start` / `serve` script |
| Express, Fastify, Koa, NestJS, plain Node | `package.json` | the same scripts, or a server file |
| Django | `manage.py` | `manage.py runserver` |
| FastAPI | `FastAPI(` in the code, or the dependency | `uvicorn` |
| Flask | `Flask(` / `create_app()` | `flask run`, or the file itself |
| Streamlit | `import streamlit` | `streamlit run` |
| Plain Python app | `app.py`, `main.py`, `server.py`, ... plus a dependency file | `python <file>` |
| Go, Spring Boot (Maven/Gradle), PHP, Laravel, Rust, Ruby/Rails | project files | `go run`, `mvn`/`gradle`, `php`, `artisan serve`, `cargo run`, `rails` |
| Static HTML | `index.html` | a small built-in local server |
| Docker Compose | `docker-compose.yml` | `docker compose up` |

A repo with `frontend/` and `backend/` folders (also `apps/web`, `client/` + `server/`) starts every part together, with colour-coded logs. Shared libraries in `packages/` and `libs/` are not started. A service that fails because another one is still starting gets one automatic retry.

## What it installs, and only what is missing

- **Python:** reuses an existing `.venv` / `venv` / `env`. If everything is already installed it does nothing. Otherwise it creates `.venv` that can see the packages already on your computer (so numpy, pandas and similar are not downloaded again) and installs only the missing ones. Understands `requirements.txt` (also `requirements/base.txt`, UTF-16 files from PowerShell), `Pipfile`, `pyproject.toml` (PEP 621 and Poetry), `setup.py`, and the `pip:` list in `environment.yml`.
- **Node:** picks npm, pnpm, yarn or bun from the lockfile or the `packageManager` field (also in the workspace root). Skips the install when nothing changed. Uses `npm ci` when there is a lockfile (falls back to `npm install --no-save`), so your `package.json` and lockfile are not rewritten. A peer-dependency conflict is retried once with `--legacy-peer-deps`.
- If a tool is missing (Node, Python, Go, Java, ...), it says which one and how to install it on your system.
- A `.env` is created from `.env.example` when there is no `.env`. Fill in real keys yourself.
- After setup it tells you what it added to your project folder, so you can delete it to undo.

## Helpful messages

Port already in use, a Python or Node package missing from the dependency list, a setting the app needs, database updates Django is waiting for, a Node version that is too old, compile tools that are missing, a registry that needs a login, and no internet. Each one says what to try.

## Safety

`runit` does what you would do by hand: it installs the project's dependencies and runs the project's code. Dependencies can run install scripts. **Only use it on projects you trust.** It is not a sandbox. See [SECURITY.md](SECURITY.md).

Built-in protections: confirmation on first run, `--safe` and `--clean-env`, installs never receive your cloud/CI secrets, refusal to use a package registry the project chose without `--yes`, never running an interpreter a repo ships as a script, a local-only static server that hides dotfiles, a root/administrator warning, and a limit of 5 services unless `--all`.

Everything runit starts is stopped on Ctrl+C, when the terminal closes, or with `runit stop`, including programs that detach themselves (Linux and macOS).

It keeps small notes in `~/.runit/` (so a second run can skip installing). Notes for deleted projects are cleaned up automatically.

## Limits

- It cannot invent configuration: databases, API keys, secrets and seed data must still be set up by you.
- Not supported yet: .NET, Elixir, Deno, Quarkus, Micronaut, Dart/Flutter, conda environments (it tells you the command to run instead).
- One main stack per folder. If a folder holds Node, Python and Go together, it starts the main one and tells you about the rest.
- A server that only listens on a Unix socket has no web address to show.
- Tested mostly on Linux. Windows and macOS are covered by the automated tests in CI but have had less real-world use.

## Development

```
npm test        # smoke tests, no network needed
```

## License

MIT
