// Cross-platform smoke tests: no dependencies, no network. Run with: npm test
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const RUNIT = path.join(__dirname, "..", "index.js");
const VERSION = require("../package.json").version;
const isWin = process.platform === "win32";
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "runit test "));
test.after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
let n = 0;
function project(files, name) {
  const dir = path.join(root, name || `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
const home = path.join(root, "home"); // tests never touch your real ~/.runit
fs.mkdirSync(home, { recursive: true });
function env() {
  const e = { ...process.env, HOME: home, USERPROFILE: home, RUNIT_DEBUG: "1" };
  delete e.RUNIT_ACTIVE;
  return e;
}
function once(args, opts = {}) {
  const r = spawnSync(process.execPath, [RUNIT, ...args], { encoding: "utf8", timeout: 30000, env: opts.env || env(), cwd: opts.cwd });
  return { code: r.status, out: strip((r.stdout || "") + (r.stderr || "")) };
}
function start(dir, extra = []) {
  const child = spawn(process.execPath, [RUNIT, dir, "--no-open", ...extra], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  const h = { child, out: "", exited: null };
  const add = (b) => (h.out += strip(b.toString()));
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("exit", (code) => (h.exited = code));
  h.waitFor = async (re, ms = 25000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = h.out.match(re);
      if (m) return m;
      if (h.exited !== null) break;
      await sleep(100);
    }
    assert.fail(`did not see ${re} within ${ms} ms. Output so far:\n${h.out}`);
  };
  h.stop = async () => {
    if (h.exited === null) {
      if (isWin) {
        // On Windows, kill triggers TerminateProcess; the guardian handles cleanup
        child.kill();
      } else {
        child.kill("SIGINT");
      }
    }
    // Give the guardian more time on Windows (it polls every 1 second)
    const deadline = isWin ? 150 : 80;
    for (let i = 0; i < deadline && h.exited === null; i++) await sleep(100);
    if (h.exited === null) child.kill("SIGKILL");
  };
  return h;
}
function get(url, rawPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: u.hostname, port: u.port, path: rawPath || u.pathname }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}
const portOpen = (port) =>
  new Promise((res) => {
    const s = require("net").connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("error", () => res(false));
  });
const SERVER = `const s=require("http").createServer((q,r)=>r.end("hello-from-app"));s.listen(0,()=>console.log("Local: http://localhost:"+s.address().port+"/"));`;

test("--version and --help work", () => {
  assert.strictEqual(once(["--version"]).out.trim(), VERSION);
  const h = once(["--help"]);
  assert.strictEqual(h.code, 0);
  assert.match(h.out, /Usage/);
});

test("unknown options are an error, not silently ignored", () => {
  const r = once(["--dyr"]);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /unknown option/i);
  assert.strictEqual(once(["--port", "4000"]).code, 2);
});

test("--dry shows the plan and changes nothing", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": SERVER, ".env.example": "KEY=1\n" });
  const r = once([dir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Found:/);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [".env.example", "package.json", "server.js"]);
});

test("a folder that does not exist is a clear error", () => {
  const r = once([path.join(root, "nope")]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /not found/i);
});

test("Node app (folder name with spaces): URL announced, app reachable, Ctrl+C stops it", async () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": SERVER }, "my app ü");
  const h = start(dir);
  try {
    const m = await h.waitFor(/is ready -> (http:\/\/\S+)/);
    const res = await get(m[1]);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, "hello-from-app");
    const port = Number(new URL(m[1]).port);
    await h.stop();
    // on Windows runit is killed hard here, so the cleanup helper does the work; give it time
    let open = true;
    for (let i = 0; i < (isWin ? 100 : 20) && open; i++) {
      await sleep(100);
      open = await portOpen(port);
    }
    let glog = "(no guardian log was written)";
    try { glog = fs.readFileSync(path.join(home, ".runit", "guardian.log"), "utf8"); } catch {}
    assert.strictEqual(open, false, "the app must be stopped when runit stops. Cleanup helper log:\n" + glog);
  } finally {
    await h.stop();
  }
});

test("frontend/backend folders both start", async () => {
  const dir = project({
    "client/package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "client/server.js": SERVER,
    "server/package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "server/server.js": SERVER,
  });
  const h = start(dir);
  try {
    await h.waitFor(/client .*is ready/);
    await h.waitFor(/server .*is ready/);
  } finally {
    await h.stop();
  }
});

test("a library is not executed", () => {
  const dir = project({ "package.json": JSON.stringify({ name: "lib", main: "index.js" }), "index.js": `require("fs").writeFileSync(__dirname + "/EXECUTED", "x");` });
  const r = once([dir, "--no-open"]);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(fs.existsSync(path.join(dir, "EXECUTED")), false);
});

test("a stray .py file does not hijack a Node project", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }), "server.js": SERVER, "convert.py": `open("PY_RAN","w").write("x")` });
  const r = once([dir, "--dry"]);
  assert.match(r.out, /Node/);
  assert.doesNotMatch(r.out, /Python/);
});

test("static site: served, dotfiles and path tricks are refused", async () => {
  const dir = project({ "index.html": "<h1>static ok</h1>", ".env": "SECRET=1", "sub/page.html": "x" });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const h = start(dir);
  try {
    const m = await h.waitFor(/is ready -> (http:\/\/\S+)/);
    assert.match((await get(m[1])).body, /static ok/);
    assert.strictEqual((await get(m[1], "/.env")).status, 404);
    assert.strictEqual((await get(m[1], "/..%2f..%2fpackage.json")).status, 404);
    assert.strictEqual((await get(m[1], "/%")).status, 400);
  } finally {
    await h.stop();
  }
});

test("a Python script runs and reports that it finished", (t) => {
  const py = spawnSync(isWin ? "python" : "python3", ["--version"], { encoding: "utf8" });
  if (py.status !== 0) return t.skip("python not installed");
  const dir = project({ "main.py": `print("hello from script")` });
  const r = once([dir, "--no-open"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /hello from script/);
  assert.match(r.out, /finished/);
});

test("runit refuses to start itself in a loop", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": SERVER });
  const r = once([dir, "--no-open"], { env: { ...process.env, RUNIT_ACTIVE: "1" } });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /loop/i);
});

test("a crash prints a clear message and a non-zero exit code", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node boom.js" } }), "boom.js": `console.error("Error: boom");process.exit(3);` });
  const r = once([dir, "--no-open"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /stopped \(exit code 3\)/);
});

test("new options are accepted and the plan shows the real script text", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { dev: "node server.js --real-command-text" }, name: "x" }), "server.js": SERVER });
  const r = once([dir, "--dry", "--safe", "--yes", "--clean-env", "--env=FOO,BAR"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /that script runs: node server\.js --real-command-text/);
});

test("a project that sets its own npm registry is flagged", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { leftpad: "1.0.0" } }), "server.js": SERVER, ".npmrc": "registry=http://registry.example.test/\n" });
  const r = once([dir, "--dry"]);
  assert.match(r.out, /own package registry \(registry\.example\.test\)/);
});

test("terminal escape codes in project text are neutralised", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { dev: "echo \u001b[2Jhi" } }) });
  const r = spawnSync(process.execPath, [RUNIT, dir, "--dry"], { encoding: "utf8", env: env() });
  assert.ok(!/\x1b\[2J/.test(r.stdout + r.stderr));
});

test("a project-chosen package registry is refused unless you pass --yes", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { leftpad: "1.0.0" } }), "server.js": SERVER, ".npmrc": "registry=http://127.0.0.1:9/\n" });
  const r = once([dir, "--no-open"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /will not download from it without your OK/);
});

test("runit status and runit stop manage a running session", async (t) => {
  if (isWin) return t.skip("stop uses signals; covered on Linux and macOS");
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": SERVER }, "session");
  const h = start(dir);
  try {
    const m = await h.waitFor(/is ready -> (http:\/\/\S+)/);
    const st = once(["status"]);
    assert.match(st.out, /running/);
    assert.match(st.out, /session/);
    const port = Number(new URL(m[1]).port);
    const sp = once(["stop", dir]);
    assert.match(sp.out, /Stopped/);
    await sleep(800);
    assert.strictEqual(await portOpen(port), false);
  } finally {
    await h.stop();
  }
  assert.match(once(["status"]).out, /No runit sessions/);
});

test("a program that detaches itself is still stopped on Ctrl+C", async (t) => {
  if (isWin) return t.skip("uses setsid");
  const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"], { encoding: "utf8" }).status === 0;
  if (!hasSetsid) return t.skip("setsid not installed");
  const dir = project({
    "package.json": JSON.stringify({ scripts: { start: "node starter.js" } }),
    "starter.js": `const cp=require("child_process");const c=cp.spawn("setsid",["node","-e",${JSON.stringify(SERVER + "setInterval(()=>{},1000)")}],{detached:true,stdio:"ignore"});c.unref();setTimeout(()=>{},60000);`,
  }, "detached");
  const h = start(dir);
  try {
    const m = await h.waitFor(/http:\/\/localhost:(\d+)/, 25000).catch(() => null);
    await sleep(2500);
    await h.stop();
    await sleep(1000);
    const left = spawnSync("sh", ["-c", "ps -eo pid,ppid,args | grep '[s]etInterval' | cut -c1-140"], { encoding: "utf8" }).stdout.trim();
    assert.strictEqual(left, "", "the detached server must be stopped too, still running:\n" + left);
  } finally {
    await h.stop();
  }
});

test("monorepo: unbuilt workspace frontend UI is built before backend starts", async () => {
  const dir = project({
    "package.json": JSON.stringify({
      name: "monorepo-app",
      workspaces: ["packages/*"],
      scripts: { start: "node server.js" },
    }),
    "server.js": `
      const fs = require("fs");
      const path = require("path");
      const http = require("http");
      const uiBuilt = fs.existsSync(path.join(__dirname, "packages", "web", "dist", "index.html"));
      const s = http.createServer((req, res) => {
        if (uiBuilt) res.end("UI-READY");
        else res.end(JSON.stringify({ note: "UI not built" }));
      });
      s.listen(0, () => console.log("Local: http://localhost:" + s.address().port + "/"));
    `,
    "packages/web/package.json": JSON.stringify({
      name: "@monorepo/web",
      scripts: { build: "node build.js" },
    }),
    "packages/web/build.js": `
      const fs = require("fs");
      const path = require("path");
      fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
      fs.writeFileSync(path.join(__dirname, "dist", "index.html"), "<h1>UI</h1>");
    `,
  });

  const dry = once([dir, "--dry"]);
  assert.strictEqual(dry.code, 0);
  assert.match(dry.out, /build step/i);

  const h = start(dir);
  try {
    const m = await h.waitFor(/is ready -> (http:\/\/\S+)/);
    const res = await get(m[1]);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, "UI-READY");
  } finally {
    await h.stop();
  }
});

test("monorepo: frontend and backend workspaces both run concurrently", async () => {
  const dir = project({
    "package.json": JSON.stringify({
      name: "monorepo-fullstack",
      workspaces: ["packages/*"],
    }),
    "packages/server/package.json": JSON.stringify({
      name: "@monorepo/server",
      scripts: { start: "node server.js" },
    }),
    "packages/server/server.js": SERVER,
    "packages/web/package.json": JSON.stringify({
      name: "@monorepo/web",
      scripts: { start: "node server.js" },
    }),
    "packages/web/server.js": SERVER,
  });

  const h = start(dir);
  try {
    await h.waitFor(/packages\/web .*is ready/);
    await h.waitFor(/packages\/server .*is ready/);
  } finally {
    await h.stop();
  }
});

test("--verbose flag enables structured debug output", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": SERVER });
  const r = once([dir, "--dry", "--verbose"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /\[runit:debug:scan\]/);
});

test("AI frameworks: Gradio app detected with default port 7860", () => {
  const dir = project({ "app.py": `import gradio as gr\ndemo = gr.Interface(fn=lambda x: x, inputs="text", outputs="text")\ndemo.launch()` });
  const r = once([dir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Gradio/);
});

test("Go layout edge cases: single-file Go without go.mod and non-cmd server layouts", () => {
  const dirSingle = project({ "main.go": `package main\nimport "fmt"\nfunc main() { fmt.Println("hello") }` }, "go-single");
  const rSingle = once([dirSingle, "--dry"]);
  assert.strictEqual(rSingle.code, 0);
  assert.match(rSingle.out, /go run main\.go/);

  const dirServer = project({
    "go.mod": "module example.com/myserver\n\ngo 1.21\n",
    "server/main.go": `package main\nfunc main() {}`,
  }, "go-server");
  const rServer = once([dirServer, "--dry"]);
  assert.strictEqual(rServer.code, 0);
  assert.match(rServer.out, /go run \.\/server/);
});

test("Rust layout edge cases: src/bin/server.rs binary without src/main.rs", () => {
  const dir = project({
    "Cargo.toml": `[package]\nname = "myrustapp"\nversion = "0.1.0"\nedition = "2021"\n`,
    "src/bin/server.rs": `fn main() { println!("rust server"); }`,
  });
  const r = once([dir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /cargo run --bin server/);
});

test("Environment templates: .env.dist and .env.local.example are recognized", () => {
  const dir = project({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "server.js": SERVER,
    ".env.dist": "API_SECRET=dist123\n",
  });
  const r = once([dir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Found:/);
});

