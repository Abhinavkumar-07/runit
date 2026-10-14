#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const os = require("os");
const readline = require("readline");
const { StringDecoder } = require("string_decoder");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--no-open", "--dry", "--dry-run", "--all", "--yes", "-y", "--safe", "--clean-env", "--verbose", "--docker", "--no-docker", "--help", "-h", "--version", "-v"]);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const isWin = process.platform === "win32";

/** User-facing error: only .message is shown (no stack trace) */
class Err extends Error {}
const paint = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const say = (m) => console.log(`${paint(36, "[runit]")} ${m}`);
// text that comes from a project (names, commands) must never be able to draw on the terminal
const cleanText = (x) => String(x).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "?");
// colour codes (CSI) and hyperlinks (OSC 8)
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const unknownFlag = [...flags].find((f) => !KNOWN_FLAGS.has(f) && !/^--env=[A-Za-z_][A-Za-z0-9_,]*$/.test(f));
if (unknownFlag) {
  console.error(`runit: unknown option "${unknownFlag}"\nRun "runit --help" to see what is available.`);
  process.exit(2);
}
if (flags.has("--version") || flags.has("-v")) {
  try {
    console.log(JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version);
  } catch {
    console.log("unknown");
  }
  process.exit(0);
}
if (flags.has("--help") || flags.has("-h")) {
  console.log(`runit - detect, install and run any project

Usage:  runit [folder] [--no-open] [--dry]
        runit status           show runit sessions that are running
        runit stop [folder]    stop everything a runit session started

  --no-open        don't open the browser automatically
  --dry, --dry-run only show what would be installed/run, change nothing
  --all            allow starting more than 5 services at once
  --yes, -y        do not ask for confirmation before the first run of a project
  --safe           install without running dependency install scripts (more careful, some packages may need them)
  --clean-env      give the project only a short list of environment variables (add more with --env=NAME,NAME)
  --verbose        show detailed detection and runtime diagnostics
  --docker         prefer running in Docker (docker-compose or Dockerfile) instead of installing host dependencies
  --no-docker      do not use Docker even if docker-compose.yml or Dockerfile exists
  --version        print the version

Supports: Node/React/Next/Vite/Angular, Python (Django, FastAPI, Flask,
Streamlit, Gradio, Litestar), Go, Java (Maven/Gradle), PHP/Laravel, Rust,
Ruby/Rails, static HTML, Docker Compose, Dockerfile. Frontend + backend folders run together.
Note: runit runs the project's own code and installs its dependencies,
exactly like doing it by hand. Only use it on projects you trust.`);
  process.exit(0);
}
const folders = argv.filter((a) => !a.startsWith("-"));
// "runit stop" / "runit status" are commands, unless a folder with that name exists here
const SUB = ["stop", "status"].includes(folders[0]) && !fs.existsSync(path.resolve(folders[0])) ? folders[0] : null;
if (folders.length > (SUB ? 2 : 1)) {
  console.error("runit: please give only one folder.");
  process.exit(2);
}
const root = path.resolve((SUB ? folders[1] : folders[0]) || ".");
const NO_OPEN = flags.has("--no-open");
const DRY = flags.has("--dry") || flags.has("--dry-run");
const SAFE = flags.has("--safe");
let approved = flags.has("--yes") || flags.has("-y"); // needed before using a package source the project chose itself
const CLEAN_ENV = flags.has("--clean-env");
const EXTRA_ENV = new Set([...flags].filter((f) => f.startsWith("--env=")).flatMap((f) => f.slice(6).split(",")));
const VERBOSE = flags.has("--verbose") || process.env.RUNIT_VERBOSE === "1";
const DOCKER = flags.has("--docker");
const NO_DOCKER = flags.has("--no-docker");
const debug = (topic, ...msg) => {
  if (VERBOSE) console.log(`${paint(90, `[runit:debug:${topic}]`)} ${msg.join(" ")}`);
};

// ---------- helpers ----------
const exists = (d, f) => fs.existsSync(path.join(d, f));
const readText = (d, f) => {
  try {
    const full = path.join(d, f);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > 5 * 1024 * 1024) return "";
    const b = fs.readFileSync(full);
    if (b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le").replace(/^\ufeff/, "");
    if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b).swap16().toString("utf16le").replace(/^\ufeff/, "");
    return b.toString("utf8").replace(/^\ufeff/, "");
  } catch {
    return "";
  }
};
const canExec = (d, f) => {
  try {
    fs.accessSync(path.join(d, f), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const safeReaddir = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
const sh = (cmd, args = []) => ({ cmd, args, shell: isWin }); // npm, mvn... are .cmd on Windows
const exe = (cmd, args = []) => ({ cmd, args, shell: false }); // real executables
function spawnX(fn, step, opts) {
  if (step.shell) return fn([step.cmd, ...step.args.map(q)].join(" "), { ...opts, shell: true });
  return fn(step.cmd, step.args, opts);
}

const VERSION_ARGS = { go: ["version"], java: ["-version"] };
const HINT_PKG = {
  // command: [winget id, brew formula, apt package(s), url]
  node: ["OpenJS.NodeJS.LTS", "node", "nodejs npm", "https://nodejs.org"],
  python: ["Python.Python.3.12", "python", "python3 python3-venv python3-pip", "https://www.python.org/downloads (tick 'Add to PATH')"],
  go: ["GoLang.Go", "go", "golang", "https://go.dev/dl"],
  java: ["EclipseAdoptium.Temurin.21.JDK", "openjdk", "default-jdk", "https://adoptium.net"],
  mvn: [null, "maven", "maven", "https://maven.apache.org/download.cgi"],
  gradle: [null, "gradle", "gradle", "https://gradle.org/install"],
  php: [null, "php", "php-cli", "https://www.php.net/downloads"],
  composer: [null, "composer", "composer", "https://getcomposer.org"],
  cargo: ["Rustlang.Rustup", "rustup", "cargo", "https://rustup.rs"],
  ruby: [null, "ruby", "ruby-full", "https://www.ruby-lang.org/en/downloads"],
  docker: ["Docker.DockerDesktop", "--cask docker", "docker.io", "https://docs.docker.com/get-docker"],
};
function buildHints() {
  const out = {
    bundle: "Install Bundler: gem install bundler",
    pnpm: "Install pnpm: npm i -g pnpm",
    yarn: "Install yarn: npm i -g yarn",
    bun: "Install Bun: npm i -g bun  (or https://bun.sh)",
  };
  for (const [cmd, [win, brew, apt, url]] of Object.entries(HINT_PKG)) {
    const how = isWin ? (win ? `winget install ${win}` : null) : process.platform === "darwin" ? `brew install ${brew}` : `sudo apt install ${apt}`;
    out[cmd] = `Install ${cmd === "cargo" ? "Rust" : cmd}: ${how ? how + "  (or " + url + ")" : url}`;
  }
  return out;
}
const HINTS = buildHints();

const cmdCache = {};
function hasCmd(cmd) {
  if (!(cmd in cmdCache)) {
    const r = spawnX(spawnSync, sh(cmd, VERSION_ARGS[cmd] || ["--version"]), { stdio: "ignore" });
    cmdCache[cmd] = r.status === 0;
  }
  return cmdCache[cmd];
}
function findPython() {
  const found = (isWin ? ["python", "py", "python3"] : ["python3", "python"]).find(hasCmd);
  if (!found) throw new Err(`Python is not installed. ${HINTS.python}`);
  return found;
}
function need(cmd) {
  if (cmd === "python") return findPython();
  if (!hasCmd(cmd)) throw new Err(`'${cmd}' is not installed. ${HINTS[cmd] || ""}`);
}

// ---------- constants ----------
const STAMP_DIR = path.join(os.homedir(), ".runit");
const RUN_ID = crypto.randomBytes(6).toString("hex"); // every program runit starts carries this tag in its environment

const FRAMEWORKS = [
  ["next", "Next.js", 3000, "frontend"],
  ["nuxt", "Nuxt", 3000, "frontend"],
  ["@angular/core", "Angular", 4200, "frontend"],
  ["react-scripts", "Create React App", 3000, "frontend"],
  ["@sveltejs/kit", "SvelteKit", 5173, "frontend"],
  ["@remix-run/dev", "Remix", 5173, "frontend"],
  ["@react-router/dev", "React Router", 5173, "frontend"],
  ["astro", "Astro", 4321, "frontend"],
  ["gatsby", "Gatsby", 8000, "frontend"],
  ["vite", "Vite", 5173, "frontend"],
  ["@vue/cli-service", "Vue CLI", 8080, "frontend"],
  ["@nestjs/core", "NestJS", 3000, "backend"],
  ["express", "Express", null, "backend"],
  ["fastify", "Fastify", null, "backend"],
  ["koa", "Koa", null, "backend"],
];
const LOCKS = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];
const LOCK_FILES = LOCKS.map((l) => l[0]);
const MODULE_MARKERS = [".package-lock.json", ".modules.yaml", ".yarn-integrity", ".yarn-state.yml"];

const PYPI_NAMES = {
  serial: "pyserial", cv2: "opencv-python", PIL: "pillow", yaml: "pyyaml", sklearn: "scikit-learn", bs4: "beautifulsoup4",
  dotenv: "python-dotenv", jwt: "pyjwt", MySQLdb: "mysqlclient", dateutil: "python-dateutil", skimage: "scikit-image",
  attr: "attrs", Crypto: "pycryptodome", OpenSSL: "pyopenssl", git: "gitpython", docx: "python-docx", magic: "python-magic",
  usb: "pyusb", zmq: "pyzmq", win32api: "pywin32", jose: "python-jose", socks: "pysocks", psycopg2: "psycopg2-binary",
  fitz: "pymupdf", faiss: "faiss-cpu", pptx: "python-pptx", torchvision: "torchvision", torchaudio: "torchaudio",
  websocket: "websocket-client", telegram: "python-telegram-bot", pydantic_settings: "pydantic-settings",
  bio: "biopython", Bio: "biopython", OpenGL: "PyOpenGL",
};

const DENY_ENV = /^(AWS_|AZURE_|GOOGLE_APPLICATION|GCP_|GCLOUD_|GITLAB_|SLACK_|STRIPE_|DOCKER_|GITHUB_TOKEN$|GH_TOKEN$|SSH_AUTH_SOCK$|KUBECONFIG$)|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL/i;
const KEEP_ENV = /^(NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_|PIP_|HTTPS?_PROXY|NO_PROXY)/i;
const ALLOW_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES.*|PROGRAMDATA|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|USER|USERNAME|LOGNAME|SHELL|TERM|COLORTERM|LANG|LC_.*|TZ|NODE_.*|NPM_CONFIG_.*|PYTHON.*|PIP_.*|VIRTUAL_ENV|CI|FORCE_COLOR|NO_COLOR|PORT|HOST|DISPLAY|XDG_.*|LD_LIBRARY_PATH|JAVA_HOME|GOPATH|GOROOT|CARGO_HOME|RUSTUP_HOME|GEM_HOME|BUNDLE_.*|COMPOSER_.*|(https?|all|no)_proxy)$/i;

// ---------- detectors (each returns a plan or null) ----------
const notes = new Set(); // warnings collected while scanning

// compares only the major version; good enough for a friendly warning
function satisfiesMajor(range, major) {
  let r = String(range).replace(/(\d[\w.]*)\s+-\s+(\d[\w.]*)/g, ">=$1 <=$2").replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
  return r.split("||").some((alt) =>
    alt
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((c) => {
        const m = c.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+)/);
        if (!m) return true;
        const v = Number(m[2]);
        if (m[1] === ">=" || m[1] === ">") return major >= v;
        if (m[1] === "<=") return major <= v;
        if (m[1] === "<") return major < v;
        return major === v;
      })
  );
}

// the folder itself, then its parents up to the scanned root
function ancestors(d) {
  const out = [d];
  for (;;) {
    const last = out[out.length - 1];
    const up = path.dirname(last);
    if (last === root || up === last || !up.startsWith(root)) break;
    out.push(up);
  }
  return out;
}
function hasWorkspaces(x) {
  try {
    const w = JSON.parse(readText(x, "package.json")).workspaces;
    return Array.isArray(w) || !!(w && w.packages);
  } catch {
    return false;
  }
}

function pickPackageManager(pkg, chain) {
  const field = String(pkg.packageManager || "").match(/^(npm|pnpm|yarn|bun)@/);
  const found = new Set();
  for (const x of chain) {
    for (const [f, name] of LOCKS) if (exists(x, f)) found.add(name);
    if (found.size) break;
  }
  const pm = field ? field[1] : ["pnpm", "yarn", "bun", "npm"].find((n) => found.has(n)) || "npm";
  const warns = [];
  if (found.size > 1) warns.push(`more than one lockfile found (${[...found].join(", ")}); using ${pm}`);
  return { pm, warns };
}

function checkNodeVersion(d, pkg) {
  const warns = [];
  const major = Number(process.versions.node.split(".")[0]);
  const eng = pkg.engines && pkg.engines.node;
  if (eng && !satisfiesMajor(eng, major)) warns.push(`this project asks for Node ${eng} but you have ${process.versions.node}. Install that version if the app fails`);
  const nv = readText(d, ".nvmrc").trim().match(/^v?(\d+)/);
  if (nv && Number(nv[1]) > major && !warns.some((w) => w.includes("asks for Node")))
    warns.push(`this project (.nvmrc) wants Node ${nv[1]} but you have ${process.versions.node}. Install that version if the app fails`);
  return warns;
}

function scanRegistries(d) {
  const defaultReg = /^(registry\.npmjs\.org|registry\.yarnpkg\.com|npm\.pkg\.github\.com|registry\.npmmirror\.com)$/i;
  const regs = new Set();
  for (const f of [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmrc"])
    for (const m of readText(d, f).matchAll(/(?:registry|npmRegistryServer)["']?\s*[=:]?\s*["']?(https?:\/\/[^\s"']+)/gi)) {
      try {
        const h = new URL(m[1]).hostname;
        if (!defaultReg.test(h)) regs.add(h);
      } catch {}
    }
  return regs;
}

function detectNode(d) {
  if (!exists(d, "package.json")) return null;
  try {
    if (!fs.statSync(path.join(d, "package.json")).isFile()) {
      notes.add(`${path.relative(root, path.join(d, "package.json")) || "package.json"} is not a regular file, so it was skipped`);
      return null;
    }
  } catch {}
  let pkg = null;
  try {
    pkg = JSON.parse(readText(d, "package.json"));
  } catch {}
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    notes.add(`${path.relative(root, path.join(d, "package.json")) || "package.json"} is not valid JSON, so it was skipped`);
    return null;
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = ["dev", "develop", "start", "serve"].find((s) => scripts[s]);
  const isSelf = (f) => path.resolve(d, f).toLowerCase() === __filename.toLowerCase(); // never run runit itself
  const looksLikeServer = (f) => /\.listen\s*\(|createServer\s*\(/.test(readText(d, f));
  const isLibrary = !!(pkg.main || pkg.module || pkg.exports || pkg.types || pkg.typings || pkg.bin || pkg.files);
  const mainFile = [pkg.main, "server.js", "index.js", "app.js", "main.js"].find(
    (f) => typeof f === "string" && exists(d, f) && !isSelf(f) &&
      (looksLikeServer(f) || (!isLibrary && ["server.js", "index.js", "app.js", "main.js"].includes(f)))
  );
  if (!script && !mainFile) return null;

  // package manager: "packageManager" field > nearest lockfile (also in workspace root) > npm
  const chain = ancestors(d);
  const { pm, warns: pmWarns } = pickPackageManager(pkg, chain);
  const warns = [...pmWarns, ...checkNodeVersion(d, pkg)];

  // custom registries and non-registry dependencies are how "dependency confusion" attacks work
  const regs = scanRegistries(d);
  const risky = regs.size ? "custom npm package registry" : null;
  if (regs.size) warns.push(`this project sets its own package registry (${[...regs].map(cleanText).join(", ")}) in .npmrc/.yarnrc. Packages will be downloaded from there. Only continue if you trust it`);
  const odd = Object.entries(allDeps).filter(([, v]) => typeof v === "string" && /^(git(\+|:)|github:|https?:|file:|link:|[\w.-]+\/[\w.-]+$)/i.test(v)).map(([k]) => k);
  if (odd.length) warns.push(`depends on ${odd.length} package(s) from git/URL/local sources instead of the registry (${odd.slice(0, 3).map(cleanText).join(", ")}${odd.length > 3 ? ", ..." : ""})`);
  const hooks = ["preinstall", "install", "postinstall", "prepare"].filter((h) => scripts[h]).map((h) => `${h}: ${cleanText(scripts[h])}`);
  const fw = FRAMEWORKS.find((f) => allDeps[f[0]]);
  let label = fw ? fw[1] : "Node.js";
  if (fw && !["Next.js", "Create React App", "Remix", "React Router", "Gatsby"].includes(fw[1])) {
    if (allDeps.react) label += " + React";
    else if (allDeps.vue) label += " + Vue";
    else if (allDeps.svelte) label += " + Svelte";
  }
  // a package whose "dev" only rebuilds a library (tsup --watch ...) is not an app
  const cmdText = script ? String(scripts[script]) : "";
  const libraryLike =
    !fw && /(^|&&|;|\s)(tsup|tsc|rollup|unbuild|esbuild|swc|babel|bunchee|microbundle)\b/.test(cmdText) && !/\b(node|nodemon|ts-node|tsx|bun)\b/.test(cmdText);

  // workspace member: install once in the workspace root
  const wsRoot = chain.slice(1).find((x) => exists(x, "pnpm-workspace.yaml") || hasWorkspaces(x));
  const installCwd = wsRoot || d;
  const stampDirs = installCwd === d ? [d] : [d, installCwd];
  let steps0 = null;
  const noScripts = SAFE ? ["--ignore-scripts"] : [];
  const installStep = {
    npm: sh("npm", ["install", "--no-save", ...noScripts]), // --no-save: never rewrite the user's package.json / lockfile
    pnpm: sh("pnpm", ["install", ...noScripts]),
    yarn: sh("yarn", ["install", ...noScripts]),
    bun: sh("bun", ["install", ...noScripts]),
  }[pm];
  if (installCwd !== d) installStep.cwd = installCwd;
  // a lockfile means "install exactly this": npm ci is strict and fast; if the lockfile is out of date, fall back
  if (pm === "npm" && exists(installCwd, "package-lock.json") && !chain.some((x) => exists(x, "node_modules"))) {
    const strict = sh("npm", ["ci", ...noScripts]);
    if (installCwd !== d) strict.cwd = installCwd;
    strict.fallback = installStep;
    steps0 = strict;
  }
  const steps = Object.keys(allDeps).length > 0 ? [steps0 || installStep] : [];
  const run = script ? sh(pm, pm === "npm" || pm === "bun" ? ["run", script] : [script]) : sh("node", [mainFile]);

  const hasPnp = () => chain.some((x) => exists(x, ".pnp.cjs"));
  return {
    cwd: d, label, kind: fw ? fw[3] : "backend", port: fw ? fw[2] : null, pm, scriptText: cleanText(cmdText), hooks, risky,
    needs: pm === "bun" ? ["bun"] : ["node", pm], steps, run, known: !!fw, warns, libraryLike,
    stamp: { files: ["package.json", ...LOCK_FILES], dirs: stampDirs },
    hasModules: () => chain.some((x) => exists(x, "node_modules")) || hasPnp(),
    // every direct dependency must really be on disk (catches a half-deleted node_modules)
    depsPresent: () =>
      hasPnp() ||
      Object.keys(allDeps).every((n) => chain.some((x) => exists(x, path.join("node_modules", n)))),
    // only used when runit has never seen this project: is node_modules newer than the package files?
    installed: () => {
      try {
        let marker = 0;
        for (const x of chain)
          for (const mk of MODULE_MARKERS) {
            try {
              marker = Math.max(marker, fs.statSync(path.join(x, "node_modules", mk)).mtimeMs);
            } catch {}
          }
        if (!marker) return false;
        for (const x of stampDirs)
          for (const f of ["package.json", ...LOCK_FILES]) if (exists(x, f) && fs.statSync(path.join(x, f)).mtimeMs > marker) return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------- Python helpers ----------
const stripPyComments = (t) =>
  String(t).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, "")).join("\n");
// one requirement like "flask>=2,<4" or "pkg[extra]==1.0 ; python_version<'3.9'" - never an option like --index-url
const SAFE_REQ = /^[A-Za-z0-9][A-Za-z0-9._\-]*(\[[A-Za-z0-9._,\- ]*\])?\s*(((===|==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_\-]+)\s*,?\s*)*(;.*)?$/;
const DIRECT_REQ = /^[A-Za-z0-9][A-Za-z0-9._\-]*\s*@\s*git\+https?:\/\/[^\s'"]+$/;
function cleanReq(x) {
  const s = String(x == null ? "" : x).trim();
  if (!s || s.startsWith("-")) return null;
  return SAFE_REQ.test(s) || DIRECT_REQ.test(s) ? s : null;
}
function tomlStrings(src, from) {
  const out = [];
  let q = null, cur = "";
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === "\\") cur += src[++i] || "";
      else if (c === q) { out.push(cur); cur = ""; q = null; }
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "]") break;
  }
  return out;
}
function tomlSections(text) {
  const map = {};
  let cur = "";
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (h) { cur = h[1].trim(); map[cur] = map[cur] || ""; }
    else map[cur] = (map[cur] || "") + line + "\n";
  }
  return map;
}
const gitReq = (name, url, ref) => cleanReq(`${name} @ git+${String(url).replace(/^git\+/, "")}${ref ? "@" + ref : ""}`);
// dependency list from Pipfile / pyproject.toml (PEP 621 or Poetry) when there is no requirements.txt
function parsePyDeps(d) {
  const out = [];
  const add = (x) => {
    const s = cleanReq(x);
    if (s) out.push(s);
    else if (x) notes.add(`ignored an unusual dependency entry: ${String(x).slice(0, 60)}`);
  };
  const sec = tomlSections(stripPyComments(readText(d, "pyproject.toml")));
  if (sec.project) {
    const m = sec.project.match(/^\s*dependencies\s*=\s*\[/m);
    if (m) tomlStrings(sec.project, m.index + m[0].length - 1).forEach(add);
  }
  const pd = sec["tool.poetry.dependencies"];
  if (pd)
    for (const l of pd.split("\n")) {
      const k = l.match(/^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/);
      if (!k || k[1].toLowerCase() === "python") continue;
      const g = k[2].match(/git\s*=\s*["']([^"']+)["']/);
      const r = k[2].match(/(?:rev|tag|branch)\s*=\s*["']([^"']+)["']/);
      if (g) add(gitReq(k[1], g[1], r && r[1]));
      else if (/path\s*=|url\s*=/.test(k[2])) notes.add(`ignored local/url dependency "${k[1]}" in pyproject.toml`);
      else add(k[1]);
    }
  const pf = tomlSections(readText(d, "Pipfile")).packages;
  if (pf)
    for (const l of pf.split("\n")) {
      const k = l.match(/^\s*["']?([A-Za-z0-9_.\-]+)["']?\s*=\s*(.*)$/);
      if (!k) continue;
      const v = k[2].trim();
      const ver = (v.match(/^["']([^"']*)["']/) || v.match(/version\s*=\s*["']([^"']*)["']/) || [])[1];
      const ex = (v.match(/extras\s*=\s*\[([^\]]*)\]/) || [])[1];
      const g = v.match(/git\s*=\s*["']([^"']+)["']/);
      const r = v.match(/ref\s*=\s*["']([^"']+)["']/);
      if (g) add(gitReq(k[1], g[1], r && r[1]));
      else if (/path\s*=|file\s*=|editable\s*=/.test(v)) notes.add(`ignored local dependency "${k[1]}" in Pipfile`);
      else add(k[1] + (ex ? `[${ex.replace(/["'\s]/g, "")}]` : "") + (ver && ver !== "*" ? (/^[=<>~!]/.test(ver) ? ver : "==" + ver) : ""));
    }
  return [...new Set(out)];
}
function parseCondaPip(d) {
  const f = ["environment.yml", "environment.yaml"].find((x) => exists(d, x));
  if (!f) return [];
  const out = [];
  let inPip = false, indent = -1;
  for (const raw of readText(d, f).split(/\r?\n/)) {
    const m = raw.match(/^(\s*)-\s*pip\s*:\s*$/);
    if (m) { inPip = true; indent = m[1].length; continue; }
    if (!inPip) continue;
    const it = raw.match(/^(\s*)-\s*(.+?)\s*$/);
    if (!it || it[1].length <= indent) { if (raw.trim()) inPip = false; continue; }
    const c = cleanReq(it[2]);
    if (c) out.push(c);
  }
  return out;
}
// files pulled in by "-r other.txt" / "-c constraints.txt" (so editing them triggers a reinstall)
function pyIncludes(file, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(file)) return [];
  seen.add(file);
  const out = [];
  const txt = stripPyComments(readText(path.dirname(file), path.basename(file)));
  for (const m of txt.matchAll(/^\s*(?:-r|--requirement|-c|--constraint)\s*=?\s*(\S+)/gm)) {
    const f = path.resolve(path.dirname(file), m[1]);
    if (/^https?:/.test(m[1])) continue;
    out.push(f, ...pyIncludes(f, depth + 1, seen));
  }
  return out;
}

const venvPython = (e) => path.join(e, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
// a real virtual environment has pyvenv.cfg and a binary (not a script that a repository planted)
function trustedVenv(e) {
  try {
    if (!fs.existsSync(path.join(e, "pyvenv.cfg"))) return false;
    if (isWin) return true;
    const b = Buffer.alloc(2);
    const fd = fs.openSync(venvPython(e), "r");
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b.toString() !== "#!";
  } catch {
    return false;
  }
}

function findPythonFramework(hasManage, srcText, depText, imports) {
  if (hasManage) return "django";
  if (imports("streamlit")) return "streamlit";
  if (imports("gradio") || /\bgr\.(Interface|Blocks|ChatInterface)\b|\bgradio\.(Interface|Blocks|ChatInterface)\b/.test(srcText)) return "gradio";
  if (/\bFastAPI\s*\(/.test(srcText)) return "fastapi";
  if (/\bLitestar\s*\(/.test(srcText) || imports("litestar")) return "litestar";
  if (/\bFlask\s*\(/.test(srcText) || (/def\s+create_app\s*\(/.test(srcText) && depText.includes("flask"))) return "flask";
  if (depText.includes("streamlit")) return "streamlit";
  if (depText.includes("gradio")) return "gradio";
  if (depText.includes("fastapi")) return "fastapi";
  if (depText.includes("litestar")) return "litestar";
  if (depText.includes("flask")) return "flask";
  return null;
}

function resolvePyEnv(d, root) {
  const dirs = [d];
  if (d !== root && path.dirname(d).startsWith(root)) dirs.push(path.dirname(d));
  const candidates = dirs.flatMap((x) => [".venv", "venv", "env"].map((v) => path.join(x, v)));
  const active = process.env.VIRTUAL_ENV;
  if (active && (active === root || active.startsWith(root + path.sep))) candidates.push(active);
  const envDir = candidates.find((e) => fs.existsSync(venvPython(e)) && trustedVenv(e));
  const badEnv = candidates.find((e) => fs.existsSync(venvPython(e)) && !trustedVenv(e) && e !== active) || null;
  const foreignEnv = active && !candidates.includes(active) && fs.existsSync(venvPython(active)) ? active : null;
  return { envDir, badEnv, foreignEnv };
}

function detectPython(d) {
  const files = ["app.py", "main.py", "server.py", "run.py", "api.py", "app/main.py", "src/main.py", "app/app.py"];
  const hasManage = exists(d, "manage.py");
  const entry = files.find((f) => exists(d, f));
  if (!hasManage && !entry) return null; // a random .py file is not a project

  // dependency files: this folder, or a parent inside the scanned root (manage.py in src/, requirements at the repo root)
  const DEPFILES = [
    "requirements.txt", "requirements/base.txt", "requirements/requirements.txt", "requirements/prod.txt", "requirements/production.txt",
    "pyproject.toml", "Pipfile", "poetry.lock", "uv.lock", "pdm.lock"
  ];
  const depDir = ancestors(d).find((x) => DEPFILES.some((f) => exists(x, f))) || null;
  const warns = [];
  const depText = depDir ? stripPyComments(DEPFILES.map((f) => readText(depDir, f)).join("\n") + "\n" + readText(d, "setup.py")).toLowerCase() : "";
  const reqRel = depDir
    ? ["requirements.txt", "requirements/base.txt", "requirements/requirements.txt", "requirements/prod.txt", "requirements/production.txt"].find((f) => exists(depDir, f))
    : null;
  const reqFile = reqRel ? path.join(depDir, reqRel) : null;
  if (!depDir && (exists(d, "environment.yml") || exists(d, "environment.yaml")))
    warns.push("this project uses conda (environment.yml). runit cannot create conda environments. Run: conda env create -f environment.yml");
  const sourceRe = /(^|\s)(--index-url|--extra-index-url|--find-links|--trusted-host)\b|^\s*-[if]\s/im;
  const pjText = depDir ? readText(depDir, "pyproject.toml") + readText(depDir, "Pipfile") : "";
  let riskySrc = false;
  if (/\[\[tool\.(poetry|uv)\.(source|index)\]\]|^\s*(index-url|extra-index-url|find-links)\s*=|\[\[source\]\][\s\S]*?url\s*=\s*["'](?!https:\/\/pypi\.org)/im.test(pjText)) {
    riskySrc = true;
    warns.push("this project sets its own Python package source (pyproject.toml / Pipfile). Packages will be downloaded from there. Only continue if you trust it");
  }
  if (reqFile && sourceRe.test(readText(path.dirname(reqFile), path.basename(reqFile)))) {
    riskySrc = true;
    warns.push("requirements.txt uses a custom package index or link source. Only continue if you trust this project");
  }

  const srcFiles = [entry, ...files].filter((f, i, a) => f && exists(d, f) && a.indexOf(f) === i);
  const src = (f) => stripPyComments(readText(d, f));
  const srcText = srcFiles.map(src).join("\n");
  const imports = (m) => new RegExp(`^\\s*(from|import)\\s+${m}\\b`, "m").test(srcText);
  const modOf = (f) => f.replace(/\.py$/, "").replace(/\//g, ".");
  const pickVar = (text, ctor) => {
    const names = [...text.matchAll(new RegExp(`^(\\w+)\\s*(?::[^=\\n]+)?=\\s*${ctor}\\s*\\(`, "gm"))].map((m) => m[1]);
    return ["app", "application", "api"].find((n) => names.includes(n)) || names[0] || null;
  };

  // which framework? what the source code does first, the dependency list second
  const fw = findPythonFramework(hasManage, srcText, depText, imports);

  // existing environment: this folder or its parent (inside the scanned root). An active venv of ANOTHER project is only read, never modified.
  const { envDir, badEnv, foreignEnv } = resolvePyEnv(d, root);

  const PY = "@py"; // real interpreter is chosen in preparePython()
  const extra = [];
  let label = "Python", kind = "backend", port = null, run;
  if (fw === "django") {
    label = "Django"; port = 8000;
    run = exe(PY, ["manage.py", "runserver"]);
  } else if (fw === "streamlit") {
    const f = ["streamlit_app.py", "app.py", "main.py"].find((x) => exists(d, x)) || entry;
    label = "Streamlit"; kind = "frontend"; port = 8501;
    run = exe(PY, ["-m", "streamlit", "run", f, "--server.headless", "true"]);
  } else if (fw === "gradio") {
    const f = ["app.py", "main.py", "gradio_app.py", "demo.py"].find((x) => exists(d, x)) || entry;
    label = "Gradio"; kind = "frontend"; port = 7860;
    run = exe(PY, [f]);
  } else if (fw === "fastapi") {
    const f = srcFiles.find((x) => /\bFastAPI\s*\(/.test(src(x))) || entry;
    if (!depText.includes("uvicorn")) extra.push("uvicorn");
    label = "FastAPI"; port = 8000;
    run = exe(PY, ["-m", "uvicorn", `${modOf(f)}:${pickVar(src(f), "FastAPI") || "app"}`]); // no --reload: it watches .venv and burns CPU
  } else if (fw === "litestar") {
    const f = srcFiles.find((x) => /\bLitestar\s*\(/.test(src(x))) || entry;
    const text = src(f);
    const v = pickVar(text, "Litestar");
    label = "Litestar"; port = 8000;
    if (v && new RegExp(`\\b${v}\\.run\\s*\\(`).test(text)) run = exe(PY, [f]);
    else {
      if (!depText.includes("uvicorn") && !depText.includes("litestar")) extra.push("uvicorn");
      run = exe(PY, ["-m", "uvicorn", `${modOf(f)}:${v || "app"}`]);
    }
  } else if (fw === "flask") {
    const f = srcFiles.find((x) => /\bFlask\s*\(/.test(src(x)) || /def\s+create_app\s*\(/.test(src(x))) || entry;
    const text = src(f);
    const v = pickVar(text, "Flask");
    label = "Flask"; port = 5000;
    if (v && new RegExp(`\\b${v}\\.run\\s*\\(`).test(text)) run = exe(PY, [f]);
    else run = { ...exe(PY, ["-m", "flask", "run"]), env: { FLASK_APP: `${modOf(f)}:${v || (/def\s+create_app\s*\(/.test(text) ? "create_app" : "app")}` } }; // works on old and new Flask
  } else {
    run = exe(PY, [entry]);
  }

  const pipfile = !reqFile && depDir && exists(depDir, "Pipfile");
  const pyprojDir = !reqFile && !pipfile ? (depDir && exists(depDir, "pyproject.toml") ? depDir : exists(d, "setup.py") ? d : null) : null;
  const condaPip = !depDir ? parseCondaPip(d) : [];
  const pyDeps = pyprojDir ? parsePyDeps(pyprojDir) : [];
  const reqArgs = reqFile ? ["-r", reqFile] : pipfile ? parsePyDeps(depDir) : pyDeps.length ? pyDeps : pyprojDir ? ["-e", pyprojDir] : condaPip;
  const editableOnly = !reqFile && !pipfile && !pyDeps.length && !!pyprojDir;
  const requiresPython = ((readText(pyprojDir || depDir || d, "pyproject.toml").match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)) || [])[1] || null;
  const sdir = depDir || d;
  return {
    cwd: d, label, kind, port, needs: ["python"], steps: [], run, warns, risky: riskySrc ? "custom Python package source" : null,
    stamp: {
      files: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "poetry.lock", "uv.lock", "pdm.lock"],
      dirs: [sdir],
      abs: reqFile ? pyIncludes(reqFile) : [],
    },
    py: { envDir, foreignEnv, badEnv, reqArgs, extra, requiresPython, checkable: !editableOnly, fallback: null },
    strong: !!depDir || hasManage || condaPip.length > 0,
    weak: !depDir && !hasManage && !condaPip.length,
  };
}

function detectGo(d) {
  const hasMod = exists(d, "go.mod");
  let target = null;
  if (exists(d, "main.go")) {
    target = hasMod ? "." : "main.go";
  }
  if (!target && hasMod) {
    if (exists(d, "cmd/main.go")) {
      target = "./cmd";
    } else {
      const subs = safeReaddir(path.join(d, "cmd")).filter((n) => exists(d, `cmd/${n}/main.go`));
      const score = (n) =>
        (/ListenAndServe|http\.Serve|\.Listen\(|gin\.|echo\.New|fiber\.New/.test(readText(d, `cmd/${n}/main.go`)) ? 10 : 0) +
        (/^(web|server|api|app|http|serve|main)$/i.test(n) ? 5 : 0);
      subs.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
      if (subs.length) target = `./cmd/${subs[0]}`;
    }
  }
  if (!target && hasMod) {
    const altDirs = ["server", "api", "backend", "app", "src"];
    for (const alt of altDirs) {
      if (exists(d, `${alt}/main.go`)) {
        target = `./${alt}`;
        break;
      }
    }
  }
  if (!target) return null;
  return {
    cwd: d, label: "Go", kind: "backend", port: 8080, needs: ["go"],
    steps: hasMod ? [sh("go", ["mod", "download"])] : [],
    run: sh("go", ["run", target]),
  };
}

function detectJava(d) {
  if (exists(d, "pom.xml")) {
    if (!readText(d, "pom.xml").includes("spring-boot")) return null;
    const w = isWin ? "mvnw.cmd" : "./mvnw";
    const wrapper = exists(d, isWin ? "mvnw.cmd" : "mvnw");
    const noExec = wrapper && !isWin && !canExec(d, "mvnw");
    return {
      cwd: d, label: "Spring Boot (Maven)", kind: "backend", port: 8080,
      needs: wrapper ? ["java"] : ["java", "mvn"], steps: [],
      run: noExec ? sh("sh", ["./mvnw", "spring-boot:run"]) : sh(wrapper ? w : "mvn", ["spring-boot:run"]),
    };
  }
  const gradleFile = ["build.gradle", "build.gradle.kts"].find((f) => exists(d, f));
  if (gradleFile) {
    const spring = readText(d, gradleFile).includes("spring-boot");
    const w = isWin ? "gradlew.bat" : "./gradlew";
    const wrapper = exists(d, isWin ? "gradlew.bat" : "gradlew");
    const noExec = wrapper && !isWin && !canExec(d, "gradlew");
    return {
      cwd: d, label: spring ? "Spring Boot (Gradle)" : "Gradle app", kind: "backend", port: spring ? 8080 : null,
      needs: wrapper ? ["java"] : ["java", "gradle"], steps: [],
      run: noExec ? sh("sh", ["./gradlew", spring ? "bootRun" : "run"]) : sh(wrapper ? w : "gradle", [spring ? "bootRun" : "run"]),
    };
  }
  return null;
}

function detectPhp(d) {
  const composer = exists(d, "composer.json");
  const artisan = exists(d, "artisan");
  const index = exists(d, "index.php") || exists(d, "public/index.php");
  if (!artisan && !index) return null;
  const steps = [];
  if (composer && !exists(d, "vendor")) steps.push(sh("composer", ["install"]));
  const needs = composer ? ["php", "composer"] : ["php"];
  if (artisan) {
    const emptyKey = exists(d, ".env") && /^APP_KEY=\s*$/m.test(readText(d, ".env"));
    if ((!exists(d, ".env") && exists(d, ".env.example")) || emptyKey) steps.push(sh("php", ["artisan", "key:generate"]));
    return { cwd: d, label: "Laravel", kind: "backend", port: 8000, needs, steps, run: sh("php", ["artisan", "serve"]) };
  }
  const docroot = exists(d, "public/index.php") ? "public" : ".";
  return {
    cwd: d, label: "PHP", kind: "backend", port: 8000, needs, steps,
    run: sh("php", ["-S", "localhost:8000", "-t", docroot]),
  };
}

function detectRust(d) {
  if (!exists(d, "Cargo.toml")) return null;
  const toml = readText(d, "Cargo.toml");
  let args = ["run"];
  if (/^\s*\[workspace\]/m.test(toml) && !/^\s*\[package\]/m.test(toml)) {
    const mem = (toml.match(/members\s*=\s*\[([\s\S]*?)\]/) || [])[1] || "";
    const dirs = [...mem.matchAll(/["']([^"']+)["']/g)]
      .map((m) => m[1])
      .flatMap((g) => (g.endsWith("/*") ? safeReaddir(path.join(d, g.slice(0, -2))).map((n) => g.slice(0, -1) + n) : [g]));
    const bins = dirs
      .filter((x) => exists(d, path.join(x, "src", "main.rs")))
      .map((x) => ({ x, name: (readText(d, path.join(x, "Cargo.toml")).match(/^\s*name\s*=\s*["']([^"']+)["']/m) || [])[1], web: /axum|actix-web|rocket|warp|hyper|tide|poem|salvo/.test(readText(d, path.join(x, "Cargo.toml"))) }))
      .filter((b) => b.name);
    if (!bins.length) return null;
    bins.sort((a, b) => Number(b.web) - Number(a.web));
    args = ["run", "-p", bins[0].name];
  } else if (!exists(d, "src/main.rs") && exists(d, "src/bin")) {
    const bins = safeReaddir(path.join(d, "src", "bin")).filter((f) => f.endsWith(".rs"));
    if (bins.length) {
      const score = (n) => (/server|main|app|web|api/i.test(n) ? 5 : 0);
      bins.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
      args = ["run", "--bin", bins[0].replace(/\.rs$/, "")];
    }
  }
  return { cwd: d, label: "Rust", kind: "backend", port: null, needs: ["cargo"], steps: [], run: sh("cargo", args) };
}

function detectRuby(d) {
  if (!exists(d, "Gemfile")) return null;
  const rails = exists(d, "bin/rails");
  if (!rails && !exists(d, "config.ru")) return null;
  return {
    cwd: d, label: rails ? "Rails" : "Rack app", kind: "backend", port: rails ? 3000 : 9292,
    needs: ["ruby", "bundle"], steps: [sh("bundle", ["install"])],
    run: rails ? sh("ruby", ["bin/rails", "server"]) : sh("bundle", ["exec", "rackup"]),
  };
}

function detectStatic(d) {
  if (!exists(d, "index.html") || exists(d, "package.json")) return null;
  return { cwd: d, label: "Static site", kind: "frontend", port: 3000, needs: [], steps: [], static: true };
}

function findComposePort(text) {
  const matches = [...text.matchAll(/(?:ports:\s*(?:\r?\n\s*-\s*["']?|\s*-\s*)|["'])(\d{2,5}):(\d{2,5})["']?/gi)];
  if (!matches.length) return null;
  const webPorts = [3000, 8080, 8000, 5000, 5173, 4200, 80, 443];
  const hostPorts = matches.map((m) => Number(m[1])).filter((p) => p > 0 && p <= 65535);
  return webPorts.find((wp) => hostPorts.includes(wp)) || hostPorts[0] || null;
}

function detectCompose(d) {
  const f = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((x) => exists(d, x));
  if (!f) return null;
  const content = readText(d, f);
  const port = findComposePort(content);
  return {
    cwd: d, label: "Docker Compose", kind: "backend", port, needs: ["docker"], steps: [],
    run: sh("docker", ["compose", "up", "--build"]),
    compose: true,
  };
}

function detectDockerfile(d) {
  const f = ["Dockerfile", "Dockerfile.dev", "docker/Dockerfile"].find((x) => exists(d, x));
  if (!f) return null;
  const content = readText(d, f);
  const exp = content.match(/^EXPOSE\s+(\d+)/im);
  const port = exp ? Number(exp[1]) : 8080;
  const rawName = path.basename(path.resolve(d)).toLowerCase().replace(/[^a-z0-9_.-]/g, "") || "app";
  const tag = `runit-${rawName}`;
  const containerName = `runit-${rawName}-${RUN_ID}`;
  return {
    cwd: d, label: "Dockerfile", kind: "backend", port, needs: ["docker"],
    steps: [
      { cmd: "docker", args: ["build", "-t", tag, "-f", f, "."], cwd: d, shell: isWin, action: "build", label: "building Docker image" },
    ],
    run: sh("docker", ["run", "--rm", "--name", containerName, "-p", `${port}:${port}`, tag]),
    dockerfile: true,
    containerName,
  };
}

function detect(d) {
  debug("scan", "checking folder:", d);
  const compose = !NO_DOCKER ? detectCompose(d) : null;
  const dockerfile = !NO_DOCKER ? detectDockerfile(d) : null;

  if (DOCKER) {
    if (compose) return [compose];
    if (dockerfile) return [dockerfile];
    throw new Err(`No Docker configuration found in ${d} (looked for docker-compose.yml or Dockerfile).`);
  }

  // When Docker Compose exists and Docker is available, prioritize the containerized environment
  // over downloading and compiling host dependencies (avoiding dependency conflicts and missing services)
  if (compose && !NO_DOCKER && hasCmd("docker")) {
    debug("scan", "Docker Compose found in", d, "; prioritizing containerized environment over host dependencies");
    return [compose];
  }

  const node = detectNode(d);
  const py = detectPython(d);
  const out = [];
  if (node && py) {
    // known frontend framework + a real Python project = two services.
    // plain Node + real Python project = Python. Node + a stray .py file = Node.
    if (node.known) out.push(node, ...(py.strong ? [py] : []));
    else if (py.strong) out.push(py);
    else out.push(node);
  } else if (node || py) out.push(node || py);
  const other = [detectGo, detectJava, detectPhp, detectRust, detectRuby, detectStatic]
    .map((f) => f(d))
    .find(Boolean);
  if (out.length) {
    if (other && !other.static && out.some((p) => p.known)) out.push(other); // e.g. Laravel + Vite
    const rel = path.relative(root, d) || ".";
    [node, py, other]
      .filter((p) => p && !out.includes(p))
      .forEach((p) => notes.add(`also found ${p.label} in ${rel}, but it is ignored (not started). runit starts one main stack per folder; run it in a subfolder or start it yourself`));
    debug("scan", "found services in", d, ":", out.map((p) => p.label).join(", "));
    return out;
  }
  if (other) {
    debug("scan", "found service in", d, ":", other.label);
    return [other];
  }

  // If no host stack matched, but Docker Compose or Dockerfile exists:
  if (compose) return [compose];
  if (dockerfile && !NO_DOCKER) return [dockerfile];

  return [];
}

const SKIP = new Set(["node_modules", "venv", "env", "dist", "build", "target", "vendor", "docs", "test", "tests", "examples", "__pycache__"]);
const HARD_SKIP = new Set(["node_modules", "venv", "env", "__pycache__", "dist", "build", "target", "vendor"]);
const LIB_DIRS = new Set(["packages", "libs", "lib", "libraries", "shared", "common"]);

function stackHint(dir) {
  const pom = readText(dir, "pom.xml");
  const names = safeReaddir(dir);
  if (/quarkus/i.test(pom)) return "This looks like a Quarkus project, which runit does not run yet. Try: ./mvnw quarkus:dev";
  if (/micronaut/i.test(pom)) return "This looks like a Micronaut project, which runit does not run yet. Try: ./mvnw mn:run";
  if (names.some((n) => /\.(csproj|sln|fsproj)$/i.test(n))) return "This looks like a .NET project, which runit does not run yet. Try: dotnet run";
  if (exists(dir, "mix.exs")) return "This looks like an Elixir project, which runit does not run yet. Try: mix deps.get && mix phx.server";
  if (exists(dir, "deno.json") || exists(dir, "deno.jsonc")) return "This looks like a Deno project, which runit does not run yet. Try: deno task dev";
  if (exists(dir, "pubspec.yaml")) return "This looks like a Dart/Flutter project, which runit does not run yet. Try: flutter run";
  return "";
}

function getWorkspaceGlobs(dir) {
  const globs = [];
  try {
    const pkg = JSON.parse(readText(dir, "package.json"));
    if (Array.isArray(pkg.workspaces)) {
      globs.push(...pkg.workspaces);
    } else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
      globs.push(...pkg.workspaces.packages);
    }
  } catch {}
  if (exists(dir, "pnpm-workspace.yaml")) {
    const text = readText(dir, "pnpm-workspace.yaml");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*['"]?([^'"#\r\n]+)['"]?/);
      if (m) globs.push(m[1].trim());
    }
  }
  if (exists(dir, "lerna.json")) {
    try {
      const l = JSON.parse(readText(dir, "lerna.json"));
      if (Array.isArray(l.packages)) globs.push(...l.packages);
    } catch {}
  }
  if (!globs.length && exists(dir, "packages")) {
    try {
      if (fs.statSync(path.join(dir, "packages")).isDirectory()) globs.push("packages/*");
    } catch {}
  }
  return [...new Set(globs.filter((g) => g && !g.startsWith("!")))];
}

function resolveWorkspaceDirs(rootDir, globs) {
  const dirs = new Set();
  for (const pattern of globs) {
    const cleanPattern = pattern.replace(/[\\/]+$/, "");
    if (!cleanPattern.includes("*")) {
      const full = path.resolve(rootDir, cleanPattern);
      if (exists(full, "package.json")) dirs.add(full);
      continue;
    }
    const parts = cleanPattern.split(/[\\/]+/);
    const starIdx = parts.findIndex((p) => p.includes("*"));
    if (starIdx === -1) continue;
    const baseDir = path.resolve(rootDir, parts.slice(0, starIdx).join(path.sep));
    if (!fs.existsSync(baseDir)) continue;
    try {
      if (!fs.statSync(baseDir).isDirectory()) continue;
    } catch { continue; }

    const expand = (currentDir, idx) => {
      if (idx >= parts.length) {
        if (exists(currentDir, "package.json")) dirs.add(currentDir);
        return;
      }
      const part = parts[idx];
      const entries = safeReaddir(currentDir);
      for (const entry of entries) {
        if (entry.startsWith(".") || SKIP.has(entry)) continue;
        const sub = path.join(currentDir, entry);
        let st;
        try { st = fs.statSync(sub); } catch { continue; }
        if (!st.isDirectory()) continue;

        if (part === "*" || part === "**") {
          expand(sub, idx + 1);
        } else if (part.includes("*")) {
          const re = new RegExp("^" + part.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
          if (re.test(entry)) expand(sub, idx + 1);
        } else if (entry === part) {
          expand(sub, idx + 1);
        }
      }
    };
    expand(baseDir, starIdx);
  }
  return [...dirs];
}

function discover(rootDir) {
  const own = detect(rootDir);
  const wsGlobs = getWorkspaceGlobs(rootDir);
  if (wsGlobs.length) {
    const wsDirs = resolveWorkspaceDirs(rootDir, wsGlobs);
    const wsPlans = [];
    const unbuiltFrontendBuildSteps = [];

    for (const wsDir of wsDirs) {
      if (wsDir === rootDir) continue;
      const detected = detect(wsDir) || [];
      for (const p of detected) {
        if (!p.libraryLike && !p.weak) wsPlans.push(p);
      }

      const pkgText = readText(wsDir, "package.json");
      let wsPkg = null;
      try { wsPkg = JSON.parse(pkgText); } catch {}
      if (wsPkg && wsPkg.scripts && wsPkg.scripts.build) {
        const wsDeps = { ...wsPkg.dependencies, ...wsPkg.devDependencies };
        const isFrontend = FRAMEWORKS.some((f) => f[3] === "frontend" && wsDeps[f[0]]) ||
                           wsDeps.react || wsDeps.vue || wsDeps.svelte ||
                           /web|client|frontend|ui/i.test(path.basename(wsDir)) ||
                           /web|client|frontend|ui/i.test(wsPkg.name || "");
        const buildOutputs = ["dist", "build", "out", ".next", "public/dist", "public/build"];
        const hasBuildOutput = buildOutputs.some((o) => exists(wsDir, o));
        if (isFrontend && !hasBuildOutput) {
          const { pm } = pickPackageManager(wsPkg, ancestors(wsDir));
          unbuiltFrontendBuildSteps.push({
            cmd: pm,
            args: pm === "npm" || pm === "bun" ? ["run", "build"] : ["build"],
            cwd: wsDir,
            shell: isWin,
            action: "build",
            label: `building UI (${wsPkg.name || path.relative(rootDir, wsDir)})`,
          });
        }
      }
    }

    const rootOrchestrates = own.some((p) =>
      /\b(turbo|nx|lerna)\b|--workspaces\b|\bworkspaces\s+run\b|\bconcurrently\b/i.test(p.scriptText || "")
    );

    if (rootOrchestrates && own.length) {
      if (unbuiltFrontendBuildSteps.length && own[0].steps) {
        own[0].steps.push(...unbuiltFrontendBuildSteps);
      }
      return own;
    }

    if (own.length) {
      const frontends = wsPlans.filter((p) => p.kind === "frontend" && p.cwd !== rootDir);
      const combined = [...own];
      for (const fe of frontends) {
        if (!combined.some((p) => p.cwd === fe.cwd)) combined.push(fe);
      }
      if (unbuiltFrontendBuildSteps.length) {
        const target = combined[0];
        if (target && target.steps) target.steps.push(...unbuiltFrontendBuildSteps);
      }
      return combined;
    }

    if (wsPlans.length) {
      if (unbuiltFrontendBuildSteps.length) {
        const target = wsPlans.find((p) => p.kind === "backend") || wsPlans[0];
        if (target && target.steps) target.steps.push(...unbuiltFrontendBuildSteps);
      }
      return wsPlans;
    }
  }

  if (own.length) return own;
  const scan = (skip, skipLibs) => {
    const found = [];
    let visited = 0;
    const walk = (dir, depth) => {
      if (skipLibs && dir !== rootDir && LIB_DIRS.has(path.basename(dir))) return; // shared libraries, not apps
      for (const name of safeReaddir(dir)) {
        if (name.startsWith(".") || skip.has(name) || visited > 3000) continue;
        const sub = path.join(dir, name);
        let st;
        try {
          st = fs.statSync(sub);
        } catch {
          continue; // broken symlink etc.
        }
        if (!st.isDirectory()) continue;
        visited++;
        const plans = detect(sub).filter((p) => !(skipLibs && p.libraryLike) && !p.weak);
        if (plans.length) found.push(...plans);
        else if (depth < 3) walk(sub, depth + 1);
      }
    };
    walk(rootDir, 1);
    return found;
  };
  let found = scan(SKIP, true);
  if (!found.length) found = scan(HARD_SKIP, true);
  if (!found.length) found = scan(HARD_SKIP, false);
  return found;
}

// ---------- processes: tracking, shutdown, guardian ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tracked = new Set();
let guardian = null;
let shuttingDown = false;
const alive = (c) => c.exitCode === null && c.signalCode === null;

// A tiny helper process. If runit is killed hard (kill -9, terminal closed, crash) its pipe closes and
// the helper stops every server runit started, so nothing is left running on a port.
function guardMain() {
  const win = process.platform === "win32";
  const cp = require("child_process");
  const fs = require("fs");
  const ppid = Number(process.argv[2]);
  const logFile = process.argv[3];
  const log = (m) => {
    if (!logFile) return;
    try { fs.appendFileSync(logFile, new Date().toISOString() + " " + m + "\n"); } catch {}
  };
  log("guardian started, watching runit pid " + ppid);
  const pids = new Set();
  let done = false;
  const killAll = (why) => {
    if (done) return;
    done = true;
    log("runit is gone (" + why + "), stopping pids: " + [...pids].join(",") );
    for (const p of pids) {
      try {
        if (win) {
          const r = cp.spawnSync("taskkill", ["/pid", String(p), "/T", "/F"], { encoding: "utf8" });
          log("taskkill " + p + " status=" + r.status + " out=" + String(r.stdout || "").trim().replace(/\s+/g, " ") + " err=" + String(r.stderr || "").trim().replace(/\s+/g, " "));
          if (r.status !== 0) {
            try {
              const ps = cp.spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + ' ' + $_.ParentProcessId }"], { encoding: "utf8" });
              if (!ps.error && ps.stdout) {
                const pairs = ps.stdout.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 2 && a[0]);
                const toKill = new Set();
                const findKids = (parent) => {
                  for (const [childId, parentId] of pairs) {
                    if (parentId === parent && !toKill.has(childId)) {
                      toKill.add(childId);
                      findKids(childId);
                    }
                  }
                };
                findKids(p);
                for (const kid of toKill) {
                  const kr = cp.spawnSync("taskkill", ["/pid", String(kid), "/T", "/F"], { encoding: "utf8" });
                  log("taskkill orphaned descendant " + kid + " status=" + kr.status);
                }
              }
            } catch {}
          }
        } else {
          try { process.kill(-p, "SIGKILL"); } catch {}
          try { process.kill(p, "SIGKILL"); } catch {}
        }
      } catch (e) {
        log("error stopping " + p + ": " + e.message);
      }
    }
    process.exit(0);
  };
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) {
      if (l === "done") {
        log("runit finished normally");
        process.exit(0);
      }
      const n = Number(l);
      if (n > 0) { pids.add(n); log("watching pid " + n); }
      else if (n < 0) pids.delete(-n);
    }
  });
  process.stdin.on("end", () => killAll("pipe ended"));
  process.stdin.on("close", () => killAll("pipe closed"));
  process.stdin.on("error", () => killAll("pipe error"));
  // second trigger, in case the pipe never reports the end
  setInterval(() => {
    try {
      process.kill(ppid, 0);
    } catch (e) {
      if (e.code === "ESRCH") killAll("runit pid not found");
    }
  }, 1000);
}
function startGuardian() {
  try {
    const code = `(${guardMain.toString()})();\n`;
    // run the helper from a file: passing code on the command line breaks on Windows quoting
    const dbg = process.env.RUNIT_DEBUG ? path.join(STAMP_DIR, "guardian.log") : "";
    let args = ["-e", code, "x", String(process.pid), dbg];
    try {
      const file = path.join(STAMP_DIR, `guardian-${crypto.createHash("sha1").update(code).digest("hex").slice(0, 10)}.js`);
      try { fs.mkdirSync(STAMP_DIR); } catch (e) { if (e.code !== "EEXIST") throw e; }
      if (!fs.existsSync(file)) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, code);
        try { fs.renameSync(tmp, file); } catch { try { fs.unlinkSync(tmp); } catch {} }
      }
      if (fs.existsSync(file)) args = [file, String(process.pid), dbg];
    } catch {}
    guardian = spawn(process.execPath, args, {
      stdio: ["pipe", "ignore", "ignore"], detached: true, windowsHide: true,
    });
    guardian.on("error", () => { guardian = null; });
    guardian.stdin.on("error", () => {});
    guardian.unref();
    guardian.stdin.unref && guardian.stdin.unref();
  } catch {
    guardian = null;
  }
}
const guardSend = (line) => {
  try { guardian && guardian.stdin.write(line + "\n"); } catch {}
};
const serviceUrls = new Map();
const activeDockerServices = [];
const created = []; // files and folders runit added to the project
const RUN_FILE = () => path.join(STAMP_DIR, `run-${process.pid}.json`);
function procStart(pid) {
  try {
    if (process.platform !== "linux") return null;
    const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[19]) || null;
  } catch {
    return null;
  }
}
function pidAlive(pid, start) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false;
  }
  return start == null || procStart(pid) === start;
}
function writeRun() {
  try {
    try { fs.mkdirSync(STAMP_DIR); } catch (e) { if (e.code !== "EEXIST") return; }
    const kids = [...tracked].filter((c) => c.pid).map((c) => ({ pid: c.pid, start: procStart(c.pid) }));
    const data = JSON.stringify({ pid: process.pid, start: procStart(process.pid), id: RUN_ID, cwd: root, children: kids, urls: Object.fromEntries(serviceUrls) });
    const tmp = RUN_FILE() + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, data);
    try { fs.renameSync(tmp, RUN_FILE()); } catch { try { fs.unlinkSync(tmp); } catch {} }
  } catch {}
}
function removeRun() {
  try { fs.unlinkSync(RUN_FILE()); } catch {}
}
// programs that moved to their own session or re-parented (daemons) still carry the tag
function pidsWithTag(id) {
  const out = [];
  try {
    if (process.platform === "linux") {
      for (const n of safeReaddir("/proc")) {
        if (!/^\d+$/.test(n)) continue;
        try {
          if (fs.readFileSync(`/proc/${n}/environ`, "latin1").includes(`RUNIT_RUN_ID=${id}\0`)) out.push(Number(n));
        } catch {}
      }
    } else if (!isWin) {
      const r = spawnSync("ps", ["eww", "-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      for (const l of (r.stdout || "").split("\n")) if (l.includes(`RUNIT_RUN_ID=${id}`)) out.push(Number(l.trim().split(/\s+/)[0]));
    }
  } catch {}
  return out.filter((p) => p > 0 && p !== process.pid && !(guardian && p === guardian.pid));
}
function track(child) {
  tracked.add(child);
  if (child.pid) guardSend(String(child.pid));
  writeRun();
  child.once("exit", () => {
    tracked.delete(child);
    if (child.pid) guardSend("-" + child.pid);
    writeRun();
  });
}
const groupAlive = (c) => {
  if (isWin) return alive(c);
  try {
    process.kill(-c.pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
function killGroup(c, sig) {
  try {
    if (isWin) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try { process.kill(-c.pid, sig); } catch { process.kill(c.pid, sig); }
    }
  } catch {}
}
function quit(code = 0) {
  removeRun();
  guardSend("done");
  process.exit(code);
}
const seenPids = new Map(); // pid -> start time (guards against pid reuse)
function noteDescendants() {
  if (process.platform !== "linux") return;
  for (const c of tracked)
    if (c.pid)
      for (const p of treePids(c.pid))
        if (!seenPids.has(p)) {
          const t = procStart(p);
          if (t) seenPids.set(p, t);
        }
}
function treePids(rootPid) {
  try {
    const pairs = [];
    if (process.platform === "linux") {
      for (const n of safeReaddir("/proc")) {
        if (!/^\d+$/.test(n)) continue;
        try {
          const st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
          pairs.push([Number(n), Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1])]);
        } catch {}
      }
    } else if (!isWin) {
      const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
      ps.stdout.split("\n").forEach((l) => {
        const a = l.trim().split(/\s+/).map(Number);
        if (a.length === 2 && a[0]) pairs.push(a);
      });
    } else return [];
    return [...treeOf(rootPid, pairs)].filter((p) => p !== process.pid);
  } catch {
    return [];
  }
}
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const list = [...tracked];
  const trees = list.flatMap((c) => (c.pid ? treePids(c.pid) : []));
  if (list.length) console.log(`\n${paint(36, "[runit]")} Stopping...`);
  list.forEach((c) => killGroup(c, "SIGTERM"));
  for (const dp of activeDockerServices) {
    if (dp.compose) {
      try { spawnSync("docker", ["compose", "down"], { cwd: dp.cwd, stdio: "ignore" }); } catch {}
    } else if (dp.containerName) {
      try { spawnSync("docker", ["stop", dp.containerName], { stdio: "ignore" }); } catch {}
    }
  }
  const end = Date.now() + (code === 129 ? 700 : 2000); // terminal closed: hurry; otherwise let servers finish cleanly
  while (Date.now() < end && list.some(groupAlive)) await sleep(50);
  list.filter(groupAlive).forEach((c) => killGroup(c, "SIGKILL")); // a server that ignores SIGTERM (even if npm/sh already exited)
  trees.forEach((pid) => { try { process.kill(pid, "SIGKILL"); } catch {} }); // children that started their own session
  pidsWithTag(RUN_ID).forEach((pid) => { try { process.kill(pid, "SIGKILL"); } catch {} }); // daemons that left the process tree
  for (const [pid, t] of seenPids) if (procStart(pid) === t) { try { process.kill(pid, "SIGKILL"); } catch {} } // daemons that left the tree
  quit(code);
}
function installSignalHandlers() {
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));
  process.on("SIGHUP", () => shutdown(129));
  process.on("uncaughtException", (e) => {
    console.error(`\n${paint(31, "[runit] ✖")} ${e && e.stack ? e.stack : e}`);
    shutdown(1);
  });
  process.on("exit", () => tracked.forEach((c) => groupAlive(c) && killGroup(c, "SIGKILL")));
  process.stdout.on("error", (e) => { if (e.code === "EPIPE") shutdown(0); });
  process.stderr.on("error", () => {});
}

// ---------- ports ----------
const portOpen = (port) =>
  Promise.all(
    ["127.0.0.1", "::1"].map(
      (host) =>
        new Promise((res) => {
          const s = net.connect({ port, host });
          s.setTimeout(800, () => { s.destroy(); res(false); });
          s.once("connect", () => { s.destroy(); res(true); });
          s.once("error", () => res(false));
        })
    )
  ).then((r) => r.some(Boolean));

async function waitForPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await sleep(700);
  }
  return false;
}
const httpAnswers = (port) =>
  new Promise((res) => {
    const req = http.get({ host: "localhost", port, path: "/", timeout: 1500 }, (r) => { r.resume(); res(true); });
    req.on("timeout", () => { req.destroy(); res(false); });
    req.on("error", () => res(false));
  });

function listeningPorts() {
  if (process.platform === "linux") {
    const ports = new Set();
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        fs.readFileSync(f, "utf8").split("\n").slice(1).forEach((l) => {
          const c = l.trim().split(/\s+/);
          if (c[3] === "0A") ports.add(parseInt(c[1].split(":")[1], 16));
        });
      } catch {}
    }
    if (ports.size) return ports;
  }
  const cmds = isWin
    ? [["netstat", ["-ano", "-p", "TCP"]]]
    : process.platform === "darwin"
    ? [["netstat", ["-an", "-p", "tcp"]]]
    : [["ss", ["-ltn"]], ["netstat", ["-ltn"]]];
  for (const [c, a] of cmds) {
    const r = spawnSync(c, a, { encoding: "utf8" });
    if (r.error || r.status !== 0 || !r.stdout) continue;
    const ports = new Set();
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!/LISTEN/i.test(line)) continue;
      const tok = line.trim().split(/\s+/).find((t) => /[:.]\d+$/.test(t));
      if (tok) ports.add(Number(tok.match(/(\d+)$/)[1]));
    }
    return ports;
  }
  return new Set();
}
const startPorts = new Set();

// ports opened by this child and its descendants only (null = cannot tell on this system)
function treeOf(rootPid, pairs) {
  const kids = new Map();
  for (const [p, pp] of pairs) (kids.get(pp) || kids.set(pp, []).get(pp)).push(p);
  const list = [rootPid];
  for (let i = 0; i < list.length; i++) (kids.get(list[i]) || []).forEach((k) => list.push(k));
  return new Set(list);
}
function ownedPorts(rootPid) {
  try {
    if (process.platform === "linux") {
      const pairs = [];
      for (const n of safeReaddir("/proc")) {
        if (!/^\d+$/.test(n)) continue;
        try {
          const st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
          pairs.push([Number(n), Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1])]);
        } catch {}
      }
      const inodes = new Set();
      for (const pid of treeOf(rootPid, pairs)) {
        for (const fd of safeReaddir(`/proc/${pid}/fd`)) {
          try {
            const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]/);
            if (m) inodes.add(m[1]);
          } catch {}
        }
      }
      const ports = new Set();
      for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
          fs.readFileSync(f, "utf8").split("\n").slice(1).forEach((l) => {
            const c = l.trim().split(/\s+/);
            if (c[3] === "0A" && inodes.has(c[9])) ports.add(parseInt(c[1].split(":")[1], 16));
          });
        } catch {}
      }
      return ports;
    }
    if (isWin) {
      const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: "utf8" });
      if (ps.error || ps.status !== 0) return null;
      const tree = treeOf(rootPid, ps.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 2 && a[0]));
      for (const p of tree) if (p !== rootPid) guardSend(String(p));
      const ns = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
      if (ns.error || ns.status !== 0) return null;
      const ports = new Set();
      for (const l of ns.stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(l)) continue;
        const c = l.trim().split(/\s+/);
        const m = (c[1] || "").match(/(\d+)$/);
        if (m && tree.has(Number(c[c.length - 1]))) ports.add(Number(m[1]));
      }
      return ports;
    }
    const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    if (ps.error || ps.status !== 0) return null;
    const tree = treeOf(rootPid, ps.stdout.split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 2 && a[0]));
    const ls = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8" });
    if (ls.error || !ls.stdout) return null;
    const ports = new Set();
    let cur = 0;
    for (const l of ls.stdout.split("\n")) {
      if (l[0] === "p") cur = Number(l.slice(1));
      else if (l[0] === "n" && tree.has(cur)) {
        const m = l.match(/:(\d+)$/);
        if (m) ports.add(Number(m[1]));
      }
    }
    return ports;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  try {
    const p = isWin
      ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

// ---------- built-in static server (loopback only, no dotfiles, no escaping the folder) ----------
function serveStatic(dir, port, tries = 0) {
  const MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
    ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
    ".wasm": "application/wasm", ".xml": "application/xml", ".pdf": "application/pdf", ".csv": "text/csv",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".ttf": "font/ttf", ".otf": "font/otf",
    ".avif": "image/avif", ".bmp": "image/bmp", ".webmanifest": "application/manifest+json",
  };
  const base = fs.realpathSync(dir);
  const send = (res, code, msg) => { res.writeHead(code, { "Content-Type": "text/plain" }); res.end(msg); };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let p;
        try {
          p = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
        } catch {
          return send(res, 400, "Bad request");
        }
        if (p.includes("\0")) return send(res, 400, "Bad request");
        const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
        if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return send(res, 421, "Misdirected request");
        if (p.endsWith("/")) p += "index.html";
        if (p.split(/[\\/]+/).some((s) => s.startsWith("."))) return send(res, 404, "Not found"); // .env, .git, ..
        fs.realpath(path.join(base, path.normalize(p)), (err, real) => {
          if (err || !(real === base || real.startsWith(base + path.sep))) return send(res, 404, "Not found");
          if (path.relative(base, real).split(path.sep).some((seg) => seg.startsWith("."))) return send(res, 404, "Not found"); // symlink to .env / .git
          fs.stat(real, (e2, stt) => {
            if (!e2 && stt.isDirectory() && !p.endsWith("/")) {
              res.writeHead(301, { Location: encodeURI(p) + "/" });
              return res.end();
            }
            if (e2 || !stt.isFile()) return send(res, 404, "Not found");
            const type = MIME[path.extname(real).toLowerCase()] || "application/octet-stream";
            const rg = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
            if (rg && (rg[1] || rg[2])) {
              let start = rg[1] ? Number(rg[1]) : Math.max(0, stt.size - Number(rg[2]));
              let end = rg[1] && rg[2] ? Math.min(Number(rg[2]), stt.size - 1) : stt.size - 1;
              if (start > end || start >= stt.size) {
                res.writeHead(416, { "Content-Range": `bytes */${stt.size}` });
                return res.end();
              }
              res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${stt.size}`, "Content-Length": end - start + 1 });
              return fs.createReadStream(real, { start, end }).on("error", () => res.destroy()).pipe(res);
            }
            res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": stt.size });
            fs.createReadStream(real).on("error", () => res.destroy()).pipe(res); // streamed: big files do not fill memory
          });
        });
      } catch {
        send(res, 500, "Server error");
      }
    });
    server.on("error", () => (tries < 20 ? resolve(serveStatic(dir, port + 1, tries + 1)) : reject(new Err("No free port for the static server"))));
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://localhost:${port}` })); // loopback only
  });
}

function copyEnv(plan) {
  if (plan.static || exists(plan.cwd, ".env")) return;
  const src = [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.local.example", ".env.development", "example.env", "env.example"].find((n) => exists(plan.cwd, n));
  if (!src) return;
  try {
    const st = fs.lstatSync(path.join(plan.cwd, src)); // a symlink or a huge file is not a real example file
    if (!st.isFile() || st.size > 1024 * 1024) return;
    fs.copyFileSync(path.join(plan.cwd, src), path.join(plan.cwd, ".env"), fs.constants.COPYFILE_EXCL);
    created.push(path.join(path.relative(root, plan.cwd), ".env"));
    say(`${plan.name}: created .env from ${src} - add real keys/values if the app needs them`);
  } catch {}
}

// ---------- install bookkeeping ----------
const stampPath = (plan) => path.join(STAMP_DIR, crypto.createHash("sha1").update(plan.cwd + plan.label).digest("hex").slice(0, 16) + ".json");
function hashOf(plan) {
  const h = crypto.createHash("sha1");
  for (const dir of plan.stamp.dirs || [plan.cwd]) plan.stamp.files.forEach((f) => h.update(dir + "|" + f + "|" + readText(dir, f)));
  (plan.stamp.abs || []).forEach((f) => h.update(f + "|" + readText(path.dirname(f), path.basename(f))));
  return h.digest("hex");
}
function readStamp(plan) {
  try {
    const j = JSON.parse(fs.readFileSync(stampPath(plan), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}
// when pip installs or removes anything, the site-packages folder's date changes; used to notice a damaged environment
function sitePackagesMtime(py) {
  try {
    if (!path.isAbsolute(py)) return null;
    const env = path.dirname(path.dirname(py));
    if (!fs.existsSync(path.join(env, "pyvenv.cfg"))) return null;
    const libs = isWin
      ? [path.join(env, "Lib", "site-packages")]
      : safeReaddir(path.join(env, "lib")).filter((n) => n.startsWith("python")).map((n) => path.join(env, "lib", n, "site-packages"));
    let m = 0;
    for (const l of libs) {
      try { m = Math.max(m, fs.statSync(l).mtimeMs); } catch {}
    }
    return m || null;
  } catch {
    return null;
  }
}
// "requires-python" ranges, compared on major.minor only
function satisfiesPy(range, maj, min) {
  return String(range).split("||").some((alt) =>
    alt.split(",").map((c) => c.trim()).filter(Boolean).every((c) => {
      const m = c.match(/^(>=|<=|==|!=|~=|>|<)?\s*(\d+)(?:\.(\d+|\*))?/);
      if (!m) return true;
      const X = Number(m[2]);
      const wild = m[3] === undefined || m[3] === "*";
      const Y = wild ? 0 : Number(m[3]);
      const cmp = maj !== X ? maj - X : wild ? 0 : min - Y;
      switch (m[1]) {
        case ">=": return cmp >= 0;
        case ">": return cmp > 0;
        case "<=": return maj !== X ? maj < X : wild || min <= Y;
        case "<": return maj !== X ? maj < X : !wild && min < Y;
        case "!=": return cmp !== 0;
        case "~=": return maj === X && min >= Y;
        default: return maj === X && (wild || min === Y);
      }
    })
  );
}
async function findPythonFor(range) {
  for (let m = 13; m >= 8; m--) {
    if (!satisfiesPy(range, 3, m)) continue;
    if (isWin) {
      const r = await capture("py", [`-3.${m}`, "-c", "print(1)"], process.cwd());
      if (r.status === 0) return { cmd: "py", pre: [`-3.${m}`], label: `3.${m}` };
    } else if (hasCmd(`python3.${m}`)) return { cmd: `python3.${m}`, pre: [], label: `3.${m}` };
  }
  return null;
}
function saveStamp(plan, extra = {}) {
  try {
    try { fs.mkdirSync(STAMP_DIR); } catch (e) { if (e.code !== "EEXIST") return; }
    const tmp = stampPath(plan) + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ hash: hashOf(plan), cwd: plan.cwd, ...extra }));
    fs.renameSync(tmp, stampPath(plan)); // atomic: two runit instances cannot corrupt it
  } catch {}
}
function pruneStamps() {
  try {
    for (const f of fs.readdirSync(STAMP_DIR)) {
      const full = path.join(STAMP_DIR, f);
      try {
        if (f.endsWith(".tmp")) {
          if (Date.now() - fs.statSync(full).mtimeMs > 3600e3) fs.unlinkSync(full);
          continue;
        }
        const s = JSON.parse(fs.readFileSync(full, "utf8"));
        if (typeof s.cwd !== "string" ? Date.now() - fs.statSync(full).mtimeMs > 30 * 86400e3 : !fs.existsSync(s.cwd)) fs.unlinkSync(full);
      } catch {
        try { fs.unlinkSync(full); } catch {} // corrupt stamp
      }
    }
  } catch {}
}

/** Install-step failure: includes last N bytes of stderr and an install hint */
class StepErr extends Err {
  /** @param {string} msg @param {string} tail - last ~20KB of stderr */
  constructor(msg, tail) {
    super(msg);
    this.tail = tail;
    this.hint = installHint(tail);
  }
}
function installHint(t) {
  t = String(t || "");
  if (/gyp ERR|node-gyp|not found: (make|gcc|g\+\+|python)|MSB8|Visual Studio|cl\.exe|Failed building wheel|error: command '(gcc|cc)'|Microsoft Visual C\+\+/i.test(t))
    return isWin
      ? "A package must be compiled and the C++ build tools are missing. Install 'Visual Studio Build Tools' (Desktop development with C++), or use a Python/Node version that has prebuilt packages."
      : process.platform === "darwin"
      ? "A package must be compiled. Run: xcode-select --install"
      : "A package must be compiled. Install build tools, for example: sudo apt install build-essential python3-dev";
  if (/ensurepip is not available|python3-venv|python3\.\d+-venv/i.test(t))
    return "Your Python is missing the venv module. On Ubuntu/Debian, install it with: sudo apt install python3-venv";
  if (/externally-managed-environment/i.test(t))
    return "This Python environment is externally managed (PEP 668). runit isolates dependencies in a virtual environment.";
  if (/E401|E403|ENEEDAUTH|Unable to authenticate|401 Unauthorized|403 Forbidden/i.test(t))
    return "A package registry asked for a login. Check the project's .npmrc / pip settings (and any token it needs), or log in with: npm login";
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|Temporary failure in name resolution|Network is unreachable|Connection (timed out|refused)|Max retries exceeded/i.test(t))
    return "Cannot reach the package registry. Check your internet connection, VPN or proxy and try again.";
  if (/Failed to replace env in config|environment variable .* (is )?(not set|undefined|missing)/i.test(t))
    return "The project's .npmrc needs an environment variable (often a registry token) that is not set on this computer. Set it, then run runit again.";
  if (/EBADENGINE|Unsupported engine/i.test(t)) return "This project needs a different Node.js version than the one installed.";
  if (/No matching distribution|Could not find a version that satisfies/i.test(t))
    return "pip cannot find a matching package version. It may not support your Python version, or the name/version is wrong.";
  return null;
}
const doneSteps = new Set();
// installs run other people's scripts: they never receive cloud/CI secrets from your shell
function installEnv() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (KEEP_ENV.test(k) || !DENY_ENV.test(k)) e[k] = v;
  e.RUNIT_RUN_ID = RUN_ID;
  return e;
}
function runEnv() {
  if (!CLEAN_ENV) return { ...process.env };
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (ALLOW_ENV.test(k) || EXTRA_ENV.has(k)) e[k] = v;
  return e;
}
function runStep(plan, step) {
  const lbl = step.label ? `${step.label} -> ` : "";
  say(`${plan.name}: ${lbl}${cleanText([step.cmd, ...step.args].join(" "))}`);
  return new Promise((resolve, reject) => {
    let tail = "";
    const child = spawnX(spawn, step, { cwd: step.cwd || plan.cwd, env: installEnv(), stdio: ["ignore", "inherit", "pipe"], detached: !isWin });
    track(child);
    child.stderr.on("data", (b) => {
      process.stderr.write(b);
      const chunk = b.toString();
      tail += chunk;
      if (tail.length > 40000) tail = tail.slice(-20000);
    });
    child.on("error", (e) => reject(new StepErr(`Could not run ${step.cmd}: ${e.message}`, "")));
    child.on("close", (code, sig) =>
      code === 0 ? resolve() : reject(new StepErr(`Step failed: ${step.cmd} ${step.args.join(" ")}${sig ? ` (stopped by ${sig})` : ""}`, tail))
    );
  });
}
function capture(cmd, args, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let stdout = "";
    let done = false;
    const finish = (status) => { if (!done) { done = true; clearTimeout(timer); resolve({ status, stdout }); } };
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"], detached: !isWin });
    track(child);
    const timer = setTimeout(() => { try { killGroup(child, "SIGKILL"); } catch {} finish(-1); }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b));
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code));
  });
}

async function createVenvAndInstall(plan, sysP, envPy, brokenDir, pip, reqArgs, extra) {
  let py = envPy;
  if (!py) {
    const own = path.join(plan.cwd, ".venv");
    let leftover = null; // a .venv folder that exists but has no usable python (dangling symlink, half-made)
    try { fs.lstatSync(own); leftover = own; } catch {}
    const bad = brokenDir || plan.py.badEnv || leftover;
    if (plan.py.badEnv && !brokenDir) say(`${plan.name}: ${plan.py.badEnv} is not a normal Python environment (it was shipped with the project), replacing it with a fresh one`);
    const venv = bad || path.join(plan.cwd, ".venv");
    created.push(path.relative(root, venv) || ".venv");
    await runStep(plan, exe(sysP.cmd, [...sysP.pre, "-m", "venv", ...(bad ? ["--clear"] : []), "--system-site-packages", venv])); // reuse numpy/pandas/etc already on this PC
    py = venvPython(venv);
  }
  if (reqArgs.length)
    try {
      await runStep(plan, exe(py, [...pip, ...reqArgs]));
    } catch (e) {
      const fb = plan.py.fallback;
      if (!fb || !fb.length || shuttingDown) throw e;
      say(`${plan.name}: installing it as a package failed, installing its dependency list directly instead`);
      await runStep(plan, exe(py, [...pip, ...fb]));
    }
  if (extra.length) await runStep(plan, exe(py, [...pip, ...extra]));
  return py;
}

async function preparePython(plan) {
  const { envDir, reqArgs, checkable, extra } = plan.py;
  const finish = (py, pre = []) => {
    plan.run = { ...plan.run, cmd: py, args: [...pre, ...plan.run.args] };
    saveStamp(plan, { py, pre, spm: sitePackagesMtime(py) });
  };
  const st = readStamp(plan);
  if (
    st && st.hash === hashOf(plan) && typeof st.py === "string" && st.py &&
    (!path.isAbsolute(st.py) || fs.existsSync(st.py)) &&
    (st.spm == null || (typeof st.spm === "number" && Math.abs(st.spm - (sitePackagesMtime(st.py) || 0)) < 1))
  ) {
    const pre = Array.isArray(st.pre) ? st.pre.filter((x) => typeof x === "string") : [];
    plan.run = { ...plan.run, cmd: st.py, args: [...pre, ...plan.run.args] };
    return say(`${plan.name}: dependencies up to date, skipping install`);
  }
  const sys = findPython();
  let sysP = { cmd: sys, pre: [] };
  if (plan.py.requiresPython) {
    const v = await capture(sys, ["-c", "import sys;print(sys.version_info[0],sys.version_info[1])"], plan.cwd);
    const [maj, min] = v.stdout.trim().split(" ").map(Number);
    if (maj && !satisfiesPy(plan.py.requiresPython, maj, min)) {
      const alt = await findPythonFor(plan.py.requiresPython);
      if (alt) {
        say(`${plan.name}: this project needs Python ${plan.py.requiresPython}; using Python ${alt.label} instead of ${maj}.${min}`);
        sysP = alt;
      } else say(`${paint(33, "WARNING")} ${plan.name}: this project needs Python ${plan.py.requiresPython} but only ${maj}.${min} was found. It may not work.`);
    }
  }
  if (!reqArgs.length && !extra.length) return finish(sysP.cmd, sysP.pre);

  const pip = ["-m", "pip", "install", "--disable-pip-version-check", ...(SAFE ? ["--only-binary=:all:"] : [])];
  let envPy = envDir ? venvPython(envDir) : null;
  let brokenDir = null;
  if (envPy) {
    const t = await capture(envPy, ["-c", "import sys, pip"], plan.cwd);
    if (t.status !== 0) {
      say(`${plan.name}: the existing environment (${envDir}) is broken or was made on another computer, creating a fresh one`);
      brokenDir = envDir;
      envPy = null;
    }
  }
  if (checkable) {
    say(`${plan.name}: checking which packages are already installed...`);
    const py = envPy || sysP.cmd;
    const pre = envPy ? [] : sysP.pre;
    const dry = async (a) => {
      if (!a.length) return true;
      const r = await capture(py, [...pre, ...pip, "--dry-run", ...(envPy ? [] : ["--break-system-packages"]), ...a], plan.cwd);
      return r.status === 0 && !/would install/i.test(r.stdout || "");
    };
    if ((await dry(reqArgs)) && (await dry(extra))) {
      say(`${plan.name}: everything already installed${envPy ? ` (${envDir})` : " on this PC"}, nothing to do`);
      return finish(py, pre);
    }
  }
  const py = await createVenvAndInstall(plan, sysP, envPy, brokenDir, pip, reqArgs, extra);
  finish(py);
}

async function prepare(plan) {
  if (plan.risky && !approved)
    throw new Err(`This project uses a ${plan.risky}, so packages would come from a server the project chose. runit will not download from it without your OK.\nIf you trust this project, run it again with --yes.`);
  plan.needs.forEach(need);
  (plan.warns || []).forEach((w) => say(`${paint(33, "WARNING")} ${plan.name}: ${w}`));
  copyEnv(plan);
  if (plan.py) return preparePython(plan);
  if (plan.stamp) {
    const st = readStamp(plan);
    const sameFiles = st && st.hash === hashOf(plan);
    const modulesOk = plan.hasModules() && plan.depsPresent();
    const hasUnbuilt = (plan.steps || []).some((s) => s.action === "build");
    // a saved stamp that no longer matches = dependencies changed -> reinstall.
    // no stamp at all (new project for runit) -> trust node_modules only if it is clearly newer than the package files.
    if (!hasUnbuilt && modulesOk && (sameFiles || (!st && plan.installed()))) {
      if (!st) saveStamp(plan);
      return say(`${plan.name}: dependencies up to date, skipping install`);
    }
    if (hasUnbuilt && modulesOk && (sameFiles || (!st && plan.installed()))) {
      say(`${plan.name}: dependencies up to date, skipping install`);
      plan.steps = plan.steps.filter((s) => s.action === "build");
    }
  }
  const hadModules = plan.hasModules ? plan.hasModules() : true;
  for (const s of plan.steps) {
    const key = (s.cwd || plan.cwd) + "|" + s.cmd + " " + s.args.join(" ");
    if (doneSteps.has(key)) continue; // workspace: install once for all members
    const attempts = [s, ...(s.fallback ? [s.fallback] : [])];
    let ok = false, lastErr = null;
    for (let i = 0; i < attempts.length && !ok && !shuttingDown; i++) {
      const st = attempts[i];
      try {
        await runStep(plan, st);
        ok = true;
      } catch (e) {
        lastErr = e;
        // only a peer-dependency conflict is worth one retry
        if (st.cmd === "npm" && st.args[0] === "install" && /ERESOLVE/.test(e.tail || "") && !shuttingDown) {
          say(`${plan.name}: peer-dependency conflict, retrying once with --legacy-peer-deps`);
          try {
            await runStep(plan, { ...st, args: [...st.args, "--legacy-peer-deps"] });
            ok = true;
          } catch (e2) {
            lastErr = e2;
          }
        }
        if (!ok && i + 1 < attempts.length) say(`${plan.name}: the lockfile does not match package.json, falling back to a normal install`);
      }
    }
    if (!ok) {
      if (s.action === "build") {
        say(`${paint(33, "WARNING")} ${plan.name}: build step failed (${lastErr ? lastErr.message : "error"}). Continuing anyway.`);
      } else {
        throw lastErr;
      }
    }
    doneSteps.add(key);
  }
  if (!hadModules && plan.steps.length) created.push(path.join(path.relative(root, plan.cwd), "node_modules"));
  if (plan.stamp) saveStamp(plan);
}

// ---------- running ----------
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+[^\s'"()<>\]]*/i;
const PORT_RE = /(?:listening|running|started|serving|available|live)[^\n]*?(?:port\(?s?\)?[:\s]+|:)(\d{4,5})\b/i;
const NOISE = /debugger|inspector|devtools|ws:\/\/|wss:\/\/|live ?reload|hot ?reload|\bhmr\b|websocket|source ?map/i;
const IGNORE_PORTS = new Set([9229, 9222, 5858, 35729, 24678]); // debugger / live-reload ports
const claimed = new Map(); // port -> plan that owns it
let alive_services = 0;
let pendingRetries = 0;

function portOf(url) {
  const m = url.match(/:(\d+)/);
  return m ? Number(m[1]) : 0;
}

function announceService(plan, url) {
  debug("port", "announcing", plan.name, "->", url);
  serviceUrls.set(plan.name, url);
  writeRun();
  const port = portOf(url);
  if (port) {
    const owner = claimed.get(port);
    if (owner && owner !== plan) return; // that port belongs to another service
    claimed.set(port, plan);
    if (plan.seen.has(port)) return;
    plan.seen.add(port);
  }
  if (plan.announced) {
    if (plan.seen.size <= 5) console.log(`   ${paint(32, "✔")} ${plan.name} also running -> ${paint("4;36", url)}`);
    return;
  }
  plan.announced = true;
  console.log(`\n${paint(32, "✔")} ${paint(1, plan.name)} (${plan.label}) is ready -> ${paint("4;36", url)}   (Ctrl+click to open)`);
  if (plan.label === "FastAPI") {
    url = url.replace(/\/$/, "") + "/docs";
    console.log(`   API docs -> ${paint("4;36", url)}`);
  }
  console.log("");
  if (plan.primary && !NO_OPEN) openBrowser(url);
}

function handleServiceLine(plan, line, tag, out, candidate, skip = 0) {
  if (line.length > 2000) line = line.slice(0, 2000) + ` ... [${line.length - 2000} more characters hidden]`;
  out((skip ? "" : tag) + line.slice(skip) + "\n");
  const clean = line.replace(ANSI, "");
  plan.recent = (plan.recent + " " + clean).slice(-4000);
  if (/EADDRINUSE|address already in use|Errno 98|Errno 10048|port \d+ is already (in use|allocated)|port \d+ is in use(?!,? trying)/i.test(clean))
  {
    const pm2 = clean.match(/:(\d{2,5})\b/);
    const other = pm2 && claimed.get(Number(pm2[1]));
    plan.hint = other && other !== plan
      ? `This service wants port ${pm2[1]}, which ${other.name} is already using. Give one of them another port (for example PORT=${Number(pm2[1]) + 1} in its .env file).`
      : "A port this app needs is already used by another program (maybe a previous run is still open). Close it and run runit again.";
  }
  const acc = clean.match(/listen EACCES(?:: permission denied)? [^\s:]*:(\d+)/i) || clean.match(/permission denied.*bind.*:(\d+)/i);
  if (acc && !plan.hint) {
    const portNum = Number(acc[1]);
    plan.hint = portNum < 1024
      ? `Port ${portNum} is a privileged port (< 1024). Ports below 1024 require administrator/root privileges, or configure the app to use a port like 3000 or 8080.`
      : `Permission denied while binding to port ${portNum}. Check your firewall, antivirus, or permissions.`;
  }
  if (!plan.hint && /ERR_OSSL_EVP_UNSUPPORTED|digital envelope routines::unsupported/i.test(clean)) {
    plan.hint = "This project uses legacy OpenSSL crypto unsupported by newer Node.js versions. Try running with: NODE_OPTIONS=--openssl-legacy-provider runit";
  }
  if (!plan.hint && /Cannot connect to the Docker daemon|docker daemon is not running|Is the docker daemon running|error during connect.*docker/i.test(clean)) {
    plan.hint = "Docker daemon is not running. Please start Docker Desktop (or run 'sudo systemctl start docker' on Linux) and try again.";
  }
  const dbMatch = clean.match(/ECONNREFUSED\s+(?:127\.0\.0\.1|localhost|::1):(\d+)/i) ||
                  clean.match(/(?:connect|connection) (?:failed|refused|error).*(?:127\.0\.0\.1|localhost):(\d+)/i);
  if (dbMatch && !plan.hint) {
    const p = Number(dbMatch[1]);
    const dbs = { 5432: "PostgreSQL", 5433: "PostgreSQL", 3306: "MySQL / MariaDB", 27017: "MongoDB", 6379: "Redis" };
    if (dbs[p]) {
      plan.hint = `The app failed to connect to local ${dbs[p]} (port ${p}). Make sure your database server is running.`;
    }
  }
  const mm = clean.match(/ModuleNotFoundError: No module named '([\w.\-]+)'/);
  if (mm) {
    const mod = mm[1].split(".")[0];
    const local =
      exists(plan.cwd, mod) || exists(plan.cwd, mod + ".py") || exists(plan.cwd, path.join("src", mod)) ||
      ["src", "app", "lib", "utils", "config", "core", "common", "models", "helpers", "services", "api"].includes(mod);
    const pypi = PYPI_NAMES[mod] || mod;
    plan.hint = local
      ? `Python cannot import "${mod}", which looks like part of this project itself. The project may need to be started from a different folder, or its imports are wrong.`
      : `A Python package is missing: ${pypi}. It is probably not listed in the project's requirements. Try: ${q(plan.run.cmd)} -m pip install ${pypi}`;
  }
  const ke = clean.match(/(?:KeyError|ImproperlyConfigured)[^\n]*['"]([A-Z][A-Z0-9_]{3,})['"]/);
  if (ke) plan.hint = `The app needs a setting called ${ke[1]}. Put it in a .env file (copy .env.example if there is one) or set it as an environment variable, then run runit again.`;
  const mg = clean.match(/You have (\d+) unapplied migration/);
  if (mg && !plan.migNote) {
    plan.migNote = true;
    say(`${plan.name}: the database is missing ${mg[1]} update(s). If pages show database errors, run: ${q(plan.run.cmd)} manage.py migrate`);
  }
  const cm = clean.match(/Cannot find module '([^'./][^']*)'/);
  if (cm && /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(\/[\w.-]+)*$/i.test(cm[1])) {
    const pkgName = cm[1].startsWith("@") ? cm[1].split("/").slice(0, 2).join("/") : cm[1].split("/")[0];
    const installVerb = plan.pm === "npm" || !plan.pm ? "install" : "add";
    plan.hint = `A Node package is missing: ${pkgName}. Try: ${plan.pm || "npm"} ${installVerb} ${pkgName}`;
  }
  if (NOISE.test(clean)) return;
  const u = clean.match(URL_RE);
  if (u) {
    const m = u[0].match(/^(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(\/[\w\-./%~]*)?/i);
    if (m && Number(m[3]) >= 1 && Number(m[3]) <= 65535) {
      const host = /^(0\.0\.0\.0|\[::1?\])$/.test(m[2]) ? "localhost" : m[2].toLowerCase();
      return candidate(`${m[1].toLowerCase()}://${host}:${m[3]}${(m[4] || "").replace(/[.,;:!?]+$/, "")}`);
    }
    return;
  }
  const p = clean.match(PORT_RE);
  if (p && Number(p[1]) >= 1 && Number(p[1]) <= 65535) candidate(`http://localhost:${p[1]}`);
}

function feedStream(stream, onLine, onPartial) {
  const dec = new StringDecoder("utf8");
  let buf = "";
  let echoed = 0;
  let timer = null;
  stream.on("data", (chunk) => {
    clearTimeout(timer);
    buf += dec.write(chunk);
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const line of parts) {
      onLine(line.replace(/\r$/, ""), echoed);
      echoed = 0;
    }
    if (buf.length > 65536) {
      onLine(buf, echoed);
      buf = "";
      echoed = 0;
    }
    // text without a newline (a question like "Continue? (y/n)", a progress bar): show it after a short pause
    timer = setTimeout(() => {
      if (buf.length > echoed) {
        onPartial(buf.slice(echoed), echoed);
        echoed = buf.length;
      }
    }, 250);
  });
  stream.on("end", () => {
    clearTimeout(timer);
    const rest = buf + dec.end();
    if (rest) onLine(rest.replace(/\r$/, ""), echoed);
    buf = "";
  });
}

async function pollForPort(plan, child, announce) {
  debug("port", "polling ports for", plan.name, "pid:", child.pid);
  const t0 = Date.now();
  let told = false;
  await sleep(4000);
  while (!plan.announced && !plan.closed && Date.now() - t0 < 120000) {
    if (!told && Date.now() - t0 > 30000) {
      told = true;
      say(`${plan.name} is running, but runit has not found its web address yet. Check the logs above for a port number.`);
    }
    const mine = ownedPorts(child.pid);
    const base = mine ? [...mine] : [...listeningPorts()].filter((p) => !startPorts.has(p));
    const cands = base.filter((p) => !IGNORE_PORTS.has(p) && !(claimed.get(p) && claimed.get(p) !== plan)).sort((a, b) => a - b);
    for (const p of cands) if (await httpAnswers(p)) return announce(`http://localhost:${p}`);
    if (mine && cands.length && Date.now() - t0 > 20000) return announce(`http://localhost:${cands[0]}`);
    await sleep(2000);
  }
}

async function launch(plan, multi) {
  const tag = multi ? paint(plan.color, `[${plan.name}]`) + " " : "";
  plan.seen = plan.seen || new Set();
  plan.pending = new Set();
  plan.startedAt = Date.now();
  plan.recent = "";
  plan.closed = false;
  plan.exited = false;
  plan.hint = null;
  const announce = (url) => announceService(plan, url);

  if (plan.static) {
    debug("launch", "serving static site in", plan.cwd, "port:", plan.port);
    const { url } = await serveStatic(plan.cwd, plan.port);
    return announce(url);
  }

  alive_services++;
  debug("launch", "starting", plan.name, `(${plan.label})`, "->", plan.run.cmd, plan.run.args.join(" "));
  if (plan.compose || plan.dockerfile) activeDockerServices.push(plan);
  const child = spawnX(spawn, plan.run, {
    cwd: plan.cwd,
    env: { ...runEnv(), ...(plan.run.env || {}), RUNIT_ACTIVE: "1", RUNIT_RUN_ID: RUN_ID, FORCE_COLOR: "1", PYTHONUNBUFFERED: "1", BROWSER: "none" },
    stdio: ["inherit", "pipe", "pipe"],
    detached: !isWin,
  });
  track(child);

  const owns = async (port) => {
    if (plan.label === "Docker Compose" || plan.label === "Dockerfile") return true; // the ports belong to Docker, not to our process tree
    let mine = null;
    for (let i = 0; i < 6 && !plan.closed; i++) {
      mine = ownedPorts(child.pid);
      if (mine === null || mine.has(port)) return true;
      await sleep(1000);
    }
    return !!mine && mine.size === 0; // could not tell -> accept
  };

  // a URL / port seen in the logs only counts once something is really listening there
  const candidate = (url) => {
    const port = portOf(url);
    if (!port || port > 65535 || IGNORE_PORTS.has(port) || plan.pending.has(port) || plan.seen.has(port)) return;
    if (plan.pending.size >= 8 || (plan.cand = (plan.cand || 0) + 1) > 300) return; // an app that prints thousands of URLs must not cost memory
    const owner = claimed.get(port);
    if (owner && owner !== plan) return;
    plan.pending.add(port);
    waitForPort(port, 90000)
      .then(async (ok) => (ok && !plan.closed && (await owns(port)) ? announce(url) : null))
      .catch(() => {})
      .then(() => plan.pending.delete(port));
  };

  let paused = false;
  const out = (s) => {
    if (process.stdout.write(s) || paused) return;
    paused = true; // the terminal is slow: stop reading the app's output until it catches up
    child.stdout.pause();
    child.stderr.pause();
    process.stdout.once("drain", () => {
      paused = false;
      child.stdout.resume();
      child.stderr.resume();
    });
  };

  const handleLine = (line, skip = 0) => handleServiceLine(plan, line, tag, out, candidate, skip);
  feedStream(child.stdout, handleLine, (part, echoed) => out((echoed ? "" : tag) + part));
  feedStream(child.stderr, handleLine, (part, echoed) => out((echoed ? "" : tag) + part));

  child.on("error", (e) => say(`${plan.name}: could not start (${e.message})`));
  child.on("exit", () => {
    plan.exited = true;
    // npm/yarn left a background process holding the output open
    plan.linger = setTimeout(() => {
      if (!plan.closed) say(`${plan.name}: the command ended, but something it started is still running in the background. Press Ctrl+C to stop it.`);
    }, 3000);
  });
  child.on("close", (code, sig) => {
    plan.closed = true;
    clearTimeout(plan.linger);
    if (shuttingDown) return;
    // a service that failed to reach another one that is still starting gets one more try
    if (code && !sig && multi && !plan.retried && !plan.hint && Date.now() - plan.startedAt < 45000 &&
        /ECONNREFUSED|connection refused|ECONNRESET|ENOTFOUND|getaddrinfo|not (up|running|reachable|available)|unreachable|Connection error/i.test(plan.recent)) {
      plan.retried = true;
      alive_services--;
      pendingRetries++;
      say(`${plan.name}: it could not reach another service that is still starting. Trying again in 6 seconds...`);
      setTimeout(() => {
        pendingRetries--;
        if (!shuttingDown) launch(plan, multi);
        else if (alive_services === 0 && pendingRetries === 0) quit(1);
      }, 6000);
      return;
    }
    if (code === 0) {
      alive_services--;
      return (async () => {
        await sleep(800);
        const fresh = [...listeningPorts()].filter((p) => !startPorts.has(p) && !IGNORE_PORTS.has(p) && !claimed.has(p)).sort((a, b) => a - b);
        if (fresh.length && !plan.announced) {
          claimed.set(fresh[0], plan);
          console.log(`\n${paint(32, "✔")} ${plan.name}: the command ended, but it started a server in the background -> ${paint("4;36", `http://localhost:${fresh[0]}`)}`);
          console.log(`   It keeps running after runit exits, so stop it yourself when you are done.`);
        } else console.log(`\n${paint(32, "✔")} ${plan.name} finished (it ran and exited).`);
        if (alive_services === 0 && pendingRetries === 0) quit(0);
      })();
    }
    if (sig) console.log(`\n${paint(31, "✖")} ${plan.name} was stopped by signal ${sig} (killed from outside, or the computer ran out of memory).`);
    else console.log(`\n${paint(31, "✖")} ${plan.name} stopped (exit code ${code}). Scroll up for the error.`);
    if (plan.hint && code !== 0) console.log(`${paint(33, "Hint:")} ${plan.hint}`);
    if (--alive_services === 0 && pendingRetries === 0) quit(code === 0 ? 0 : code || 1);
  });

  // no URL in the logs: find the port that THIS app opened (not another program's)
  pollForPort(plan, child, announce);
}

function reportFailure(p, e) {
  console.error(`\n${paint(31, "[runit] ✖")} ${p.name}: ${e instanceof Err ? e.message : e.stack}`);
  if (e.tail) {
    const last = e.tail.split(/\r?\n/).filter((l) => l.trim()).slice(-6);
    if (last.length) console.error(paint(2, "Last lines of the error:") + "\n  " + last.join("\n  "));
  }
  if (e.hint) console.error(`${paint(33, "Hint:")} ${e.hint}`);
}

// ---------- runit status / runit stop ----------
function readRuns() {
  const out = [];
  for (const f of safeReaddir(STAMP_DIR)) {
    if (!/^run-\d+\.json$/.test(f)) continue;
    const file = path.join(STAMP_DIR, f);
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      r._file = file;
      r._live = pidAlive(r.pid, r.start);
      r._kids = (r.children || []).filter((c) => pidAlive(c.pid, c.start));
      if (!r._live && !r._kids.length && !pidsWithTag(r.id).length) {
        fs.unlinkSync(file); // finished long ago
        continue;
      }
      out.push(r);
    } catch (e) {
      // only delete on parse/read errors; permission errors should surface
      if (e instanceof SyntaxError || (e && e.code === "ENOENT")) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }
  return out;
}
async function runSub() {
  const runs = readRuns();
  if (SUB === "status") {
    if (!runs.length) return console.log("No runit sessions are running.");
    for (const r of runs) {
      console.log(`${r._live ? "running" : "LEFT BEHIND (runit is gone but its programs are still running)"}  pid ${r.pid}  ${cleanText(r.cwd)}`);
      for (const [n, u] of Object.entries(r.urls || {})) console.log(`    ${cleanText(n)} -> ${cleanText(u)}`);
    }
    return;
  }
  const want = folders[1] ? root : null;
  const sel = runs.filter((r) => !want || r.cwd === want);
  if (!sel.length) return console.log("Nothing to stop.");
  for (const r of sel) {
    if (r._live) {
      try { process.kill(r.pid, isWin ? undefined : "SIGTERM"); } catch {}
      for (let i = 0; i < 80 && pidAlive(r.pid, r.start); i++) await sleep(100);
    }
    for (const c of r._kids.filter((k) => pidAlive(k.pid, k.start))) {
      try {
        if (isWin) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(-c.pid, "SIGKILL");
      } catch {
        try { process.kill(c.pid, "SIGKILL"); } catch {}
      }
    }
    pidsWithTag(r.id).forEach((pid) => { try { process.kill(pid, "SIGKILL"); } catch {} });
    try { fs.unlinkSync(r._file); } catch {}
    console.log(`Stopped ${cleanText(r.cwd)}`);
  }
}

// ---------- first-run confirmation (trust on first use, ask again when the project's dependency files change) ----------
const TRUST_FILE = () => path.join(STAMP_DIR, "trusted.json");
function readTrust() {
  try {
    const j = JSON.parse(fs.readFileSync(TRUST_FILE(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
function trustKey(p) {
  return p.cwd + "|" + p.label;
}
function trustHash(p) {
  return p.stamp ? hashOf(p) : crypto.createHash("sha1").update(JSON.stringify(p.run || p.label)).digest("hex");
}
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
    rl.on("close", () => resolve(""));
  });
}
async function confirmPlans(plans) {
  if (flags.has("--yes") || flags.has("-y") || !process.stdin.isTTY || !process.stdout.isTTY) return;
  const trust = readTrust();
  const fresh = plans.filter((p) => trust[trustKey(p)] !== trustHash(p));
  if (!fresh.length) {
    approved = true;
    return;
  }
  console.log(`\n${paint(1, "This will run commands from this project on your computer:")}`);
  for (const p of fresh) {
    console.log(`\n  ${paint(1, p.name)} (${p.label})`);
    for (const st of p.steps || []) {
      const act = (st.action || "install").padEnd(7);
      console.log(`    ${act} : ${cleanText([st.cmd, ...st.args].join(" "))}${st.cwd ? `   (in ${cleanText(path.relative(root, st.cwd) || ".")})` : ""}`);
    }
    if (p.py && (p.py.reqArgs.length || p.py.extra.length)) console.log(`    install : pip install ${cleanText([...p.py.reqArgs, ...p.py.extra].join(" "))}`);
    if (p.scriptText) console.log(`    start   : ${cleanText([p.run.cmd, ...p.run.args].join(" "))}   -> runs: ${p.scriptText}`);
    else if (p.static) console.log("    start   : built-in static file server");
    else console.log(`    start   : ${cleanText([p.run.cmd === "@py" ? "python" : p.run.cmd, ...p.run.args].join(" "))}`);
    (p.hooks || []).forEach((h) => console.log(`    ${paint(33, "hook")}    : ${h}`));
    (p.warns || []).forEach((w) => console.log(`    ${paint(33, "note")}    : ${cleanText(w)}`));
  }
  console.log(`\n  Packages can also run their own install scripts${SAFE ? " (disabled by --safe)" : " (use --safe to skip them)"}.`);
  const a = await ask("\nContinue? [Y/n] ");
  if (/^\s*n/i.test(a)) {
    say("Cancelled. Nothing was installed or started.");
    process.exit(0);
  }
  approved = true;
  fresh.forEach((p) => (trust[trustKey(p)] = trustHash(p)));
  try {
    try { fs.mkdirSync(STAMP_DIR); } catch (e) { if (e.code !== "EEXIST") throw e; }
    fs.writeFileSync(TRUST_FILE(), JSON.stringify(trust));
  } catch {}
}

// ---------- main ----------
(async () => {
  if (SUB) return runSub();
  installSignalHandlers();
  if (process.env.RUNIT_ACTIVE) throw new Err("runit was started by runit (this project's start command calls runit again). Stopping to avoid a loop.");
  if (!fs.existsSync(root))
    throw new Err(
      folders[0] && folders[0].startsWith("~")
        ? `Folder not found: ${cleanText(folders[0])}\n(Your shell normally turns ~ into your home folder. If you put it in quotes, type the full path instead.)`
        : `Folder not found: ${cleanText(root)}`
    );
  if (!fs.statSync(root).isDirectory()) throw new Err(`Not a folder: ${root}`);
  say(`Scanning ${root.replace(/[\x00-\x1f\x7f-\x9f]/g, "?")}`);
  const plans = discover(root);
  notes.forEach((n) => say(`${paint(33, "WARNING")} ${n}`));
  if (!plans.length) {
    const why = stackHint(root)
      ? stackHint(root) + "\n"
      : notes.size
      ? ""
      : exists(root, "package.json")
      ? "Found package.json, but it has no dev/start/serve script (or it is a library), so there is nothing to run.\n"
      : exists(root, "Dockerfile")
      ? "Found a Dockerfile, but Docker is not installed or available on PATH. Install Docker to run containerized projects.\n"
      : "";
    throw new Err(
      why + "Couldn't recognise this project.\nSupported: Node/React/Next/Vite/Angular, Python (Django/FastAPI/Flask/Streamlit/Gradio/Litestar), Go, Java, PHP/Laravel, Rust, Ruby/Rails, static HTML, Docker Compose, Dockerfile."
    );
  }

  // names, order (frontends first), colours
  const palette = [35, 33, 34, 32, 36];
  plans.forEach((p) => {
    p.name = (path.relative(root, p.cwd) || path.basename(root)).replace(/\\/g, "/").replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  });
  plans.forEach((p) => {
    if (plans.filter((o) => o.name === p.name).length > 1) p.name += `-${p.kind}`;
  });
  plans.sort((a, b) => (a.kind === "frontend" ? 0 : 1) - (b.kind === "frontend" ? 0 : 1));
  plans.forEach((p, i) => (p.color = palette[i % palette.length]));
  plans[0].primary = true;

  if (plans.length > 5 && !flags.has("--all"))
    throw new Err(
      `Found ${plans.length} runnable folders (${plans.slice(0, 5).map((p) => p.name).join(", ")} ...).\nThat looks like a collection of separate examples, not one app. Run runit inside one of them, or use --all to start all ${plans.length}.`
    );
  if (!isWin && process.getuid && process.getuid() === 0)
    say(`${paint(33, "WARNING")} you are running as root/administrator. This project's install scripts would run with full rights. Only continue if you trust it.`);
  say("Found:");
  plans.forEach((p) => {
    const cmd = p.static ? "built-in static server" : [...Object.entries(p.run.env || {}).map(([k, v]) => `${k}=${v}`), p.run.cmd === "@py" ? "python" : p.run.cmd, ...p.run.args].join(" ");
    console.log(`   - ${p.name}: ${p.label}  ->  ${cleanText(cmd)}`);
    if (p.scriptText) console.log(`       that script runs: ${p.scriptText}`);
    (p.steps || []).filter((s) => s.action === "build").forEach((b) => console.log(`       ${paint(36, "build step")} ${cleanText([b.cmd, ...b.args].join(" "))}${b.cwd ? ` (in ${cleanText(path.relative(root, b.cwd) || ".")})` : ""}`));
    (p.hooks || []).forEach((h) => console.log(`       ${paint(33, "install hook")} ${h}`));
    (p.warns || []).forEach((w) => console.log(`       ${paint(33, "WARNING")}: ${w}`));
  });
  if (DRY) return;

  await confirmPlans(plans);
  pruneStamps();
  startGuardian();
  const ready = [];
  for (const p of plans) {
    try {
      await prepare(p);
      ready.push(p);
    } catch (e) {
      if (shuttingDown) return;
      reportFailure(p, e);
    }
  }
  if (!ready.length) quit(1);

  if (created.length) say(`runit added to the project folder: ${[...new Set(created.map((c) => cleanText(c.replace(/^\.\//, ""))))].join(", ")}  (delete them to undo)`);
  listeningPorts().forEach((p) => startPorts.add(p));
  say("Starting... (press Ctrl+C to stop everything)");
  for (const p of ready) await launch(p, ready.length > 1);
})().catch((e) => {
  console.error(`\n${paint(31, "[runit] ✖")} ${e instanceof Err ? e.message : e.stack}`);
  quit(1);
});
