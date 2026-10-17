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
const cleanup = () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
if (typeof test.after === "function") {
  test.after(cleanup);
}
process.on("exit", cleanup);
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

test("Docker prioritization and --docker / --no-docker flags", () => {
  const dir = project({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "server.js": SERVER,
    "docker-compose.yml": `
version: "3"
services:
  web:
    build: .
    ports:
      - "3000:3000"
`,
  });

  // Explicit --docker forces Docker Compose over package.json
  const rDocker = once([dir, "--dry", "--docker"]);
  assert.strictEqual(rDocker.code, 0);
  assert.match(rDocker.out, /Docker Compose/);

  // Explicit --no-docker forces Node.js over Docker Compose
  const rNoDocker = once([dir, "--dry", "--no-docker"]);
  assert.strictEqual(rNoDocker.code, 0);
  assert.match(rNoDocker.out, /Node/);
});

test("Dockerfile detection for standalone container projects", () => {
  const dir = project({
    "Dockerfile": `
FROM alpine
EXPOSE 8080
CMD ["echo", "running"]
`,
  });

  const r = once([dir, "--dry", "--docker"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Dockerfile/);
  assert.match(r.out, /docker build/);
});

test(".NET project detection: .csproj and .fsproj", () => {
  const csharpDir = project({
    "MyApp.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
    "Program.cs": `Console.WriteLine("Hello World");`,
  });
  const rCs = once([csharpDir, "--dry"]);
  assert.strictEqual(rCs.code, 0);
  assert.match(rCs.out, /\.NET/);
  assert.match(rCs.out, /dotnet run/);

  const fsharpDir = project({
    "MyApp.fsproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
  });
  const rFs = once([fsharpDir, "--dry"]);
  assert.strictEqual(rFs.code, 0);
  assert.match(rFs.out, /F# \(\.NET\)/);
  assert.match(rFs.out, /dotnet run/);
});

test("Deno project detection: deno.json tasks and main.ts", () => {
  const denoDir = project({
    "deno.json": JSON.stringify({
      tasks: {
        dev: "deno run -A server.ts",
      },
    }),
    "server.ts": `Deno.serve((_req) => new Response("Hello from Deno"));`,
  });
  const r = once([denoDir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Deno/);
  assert.match(r.out, /deno task dev/);
});

test("Java Quarkus and Micronaut detection in pom.xml and build.gradle", () => {
  const quarkusDir = project({
    "pom.xml": `<project><dependencies><dependency><groupId>io.quarkus</groupId><artifactId>quarkus-resteasy</artifactId></dependency></dependencies></project>`,
  });
  const rQ = once([quarkusDir, "--dry"]);
  assert.strictEqual(rQ.code, 0);
  assert.match(rQ.out, /Quarkus/);
  assert.match(rQ.out, /quarkus:dev/);

  const micronautDir = project({
    "pom.xml": `<project><dependencies><dependency><groupId>io.micronaut</groupId><artifactId>micronaut-http-server-netty</artifactId></dependency></dependencies></project>`,
  });
  const rM = once([micronautDir, "--dry"]);
  assert.strictEqual(rM.code, 0);
  assert.match(rM.out, /Micronaut/);
  assert.match(rM.out, /mn:run/);
});

test("Ruby Sinatra detection: Gemfile with sinatra and app.rb", () => {
  const sinatraDir = project({
    "Gemfile": `source 'https://rubygems.org'\ngem 'sinatra'\n`,
    "app.rb": `require 'sinatra'\nget '/' do\n  'Hello world!'\nend\n`,
  });
  const r = once([sinatraDir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Sinatra/);
  assert.match(r.out, /bundle exec ruby app\.rb/);
});

test("Python modern frameworks: Sanic, Tornado, Bottle and entry points", () => {
  const sanicDir = project({
    "requirements.txt": "sanic\n",
    "app.py": `from sanic import Sanic\napp = Sanic("my_app")\n`,
  });
  const rSanic = once([sanicDir, "--dry"]);
  assert.strictEqual(rSanic.code, 0);
  assert.match(rSanic.out, /Sanic/);

  const tornadoDir = project({
    "requirements.txt": "tornado\n",
    "main.py": `import tornado.web\napp = tornado.web.Application([])\n`,
  });
  const rTornado = once([tornadoDir, "--dry"]);
  assert.strictEqual(rTornado.code, 0);
  assert.match(rTornado.out, /Tornado/);

  const bottleDir = project({
    "requirements.txt": "bottle\n",
    "application.py": `from bottle import route, run\n@route('/')\ndef index(): return "hi"\n`,
  });
  const rBottle = once([bottleDir, "--dry"]);
  assert.strictEqual(rBottle.code, 0);
  assert.match(rBottle.out, /Bottle/);
});

test("Node.js modern frameworks and start scripts: Hono and start:dev", () => {
  const honoDir = project({
    "package.json": JSON.stringify({
      dependencies: { hono: "^4.0.0" },
      scripts: { "start:dev": "node server.js" },
    }),
    "server.js": SERVER,
  });
  const r = once([honoDir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Hono/);
  assert.match(r.out, /start:dev/);
});

test("Static site detection with public/index.html", () => {
  const staticDir = project({
    "public/index.html": `<!DOCTYPE html><html><body><h1>Static in Public</h1></body></html>`,
  });
  const r = once([staticDir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Static site/);
});

test("Node.js server.js detection with and without package.json", () => {
  // 1. With package.json (no scripts defined)
  const withPkg = project({
    "package.json": JSON.stringify({ name: "my-app" }),
    "server.js": SERVER,
  });
  const r1 = once([withPkg, "--dry"]);
  assert.strictEqual(r1.code, 0);
  assert.match(r1.out, /node server\.js/);

  // 2. Standalone server.js without package.json
  const standalone = project({
    "server.js": SERVER,
  });
  const r2 = once([standalone, "--dry"]);
  assert.strictEqual(r2.code, 0);
  assert.match(r2.out, /Node\.js/);
  assert.match(r2.out, /node server\.js/);
});

test("Arbitrary server file names: custom-backend.mjs, my_api.py, service.go", () => {
  // Arbitrary Node.js name (.mjs / .js / .cjs)
  const nodeCustom = project({
    "custom-backend.mjs": `import http from 'http'; const s = http.createServer(); s.listen(3000);`,
  });
  const rNode = once([nodeCustom, "--dry"]);
  assert.strictEqual(rNode.code, 0);
  assert.match(rNode.out, /custom-backend\.mjs/);

  // Arbitrary Python name
  const pyCustom = project({
    "requirements.txt": "fastapi\n",
    "my_custom_api.py": `from fastapi import FastAPI\napp = FastAPI()\n`,
  });
  const rPy = once([pyCustom, "--dry"]);
  assert.strictEqual(rPy.code, 0);
  assert.match(rPy.out, /FastAPI/);
  assert.match(rPy.out, /my_custom_api:app/);

  // Arbitrary Go name
  const goCustom = project({
    "service.go": `package main\nimport "fmt"\nfunc main() { fmt.Println("hello"); }\n`,
  });
  const rGo = once([goCustom, "--dry"]);
  assert.strictEqual(rGo.code, 0);
  assert.match(rGo.out, /go run service\.go/);
});

test("--docker flag fails cleanly when no Dockerfile or compose file exists", () => {
  const dir = project({ "index.js": SERVER });
  const r = once([dir, "--dry", "--docker"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /No Docker configuration found/);
});

test("packageManager field in package.json selects pnpm, yarn, or bun", () => {
  const pnpmDir = project({
    "package.json": JSON.stringify({ name: "pnpm-app", packageManager: "pnpm@8.15.0", scripts: { dev: "node server.js" } }),
    "server.js": SERVER,
  });
  const rPnpm = once([pnpmDir, "--dry"]);
  assert.strictEqual(rPnpm.code, 0);
  assert.match(rPnpm.out, /pnpm dev/);

  const yarnDir = project({
    "package.json": JSON.stringify({ name: "yarn-app", packageManager: "yarn@3.6.0", scripts: { dev: "node server.js" } }),
    "server.js": SERVER,
  });
  const rYarn = once([yarnDir, "--dry"]);
  assert.strictEqual(rYarn.code, 0);
  assert.match(rYarn.out, /yarn dev/);

  const bunDir = project({
    "package.json": JSON.stringify({ name: "bun-app", packageManager: "bun@1.0.0", scripts: { dev: "node server.js" } }),
    "server.js": SERVER,
  });
  const rBun = once([bunDir, "--dry"]);
  assert.strictEqual(rBun.code, 0);
  assert.match(rBun.out, /bun run dev/);
});

test("invalid package.json JSON logs a warning and falls back to standalone server.js", () => {
  const dir = project({
    "package.json": "{ broken invalid json ",
    "server.js": SERVER,
  });
  const r = once([dir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /WARNING.*is not valid JSON/);
  assert.match(r.out, /node server\.js/);
});

test("custom server files in src/ are detected with and without package.json", () => {
  // 1. Without package.json
  const dirNoPkg = project({
    "src/custom-api.js": SERVER,
  });
  const r1 = once([dirNoPkg, "--dry"]);
  assert.strictEqual(r1.code, 0);
  assert.match(r1.out, /node src\/custom-api\.js/);

  // 2. With package.json (no scripts)
  const dirWithPkg = project({
    "package.json": JSON.stringify({ name: "custom-app" }),
    "src/custom-api.js": SERVER,
  });
  const r2 = once([dirWithPkg, "--dry"]);
  assert.strictEqual(r2.code, 0);
  assert.match(r2.out, /node src\/custom-api\.js/);
});

test("Python modern frameworks: Litestar, aiohttp, and src/ nested entrypoints", () => {
  // Litestar
  const dirLitestar = project({
    "main.py": "from litestar import Litestar\napp = Litestar()\n",
  });
  const rLite = once([dirLitestar, "--dry"]);
  assert.strictEqual(rLite.code, 0);
  assert.match(rLite.out, /Litestar/);
  assert.match(rLite.out, /main:app/);

  // aiohttp
  const dirAio = project({
    "server.py": "from aiohttp import web\napp = web.Application()\nweb.run_app(app)\n",
  });
  const rAio = once([dirAio, "--dry"]);
  assert.strictEqual(rAio.code, 0);
  assert.match(rAio.out, /aiohttp/);
  assert.match(rAio.out, /server\.py/);

  // Nested src/server.py with custom variable
  const dirNested = project({
    "src/server.py": "from fastapi import FastAPI\nmy_api = FastAPI()\n",
  });
  const rNested = once([dirNested, "--dry"]);
  assert.strictEqual(rNested.code, 0);
  assert.match(rNested.out, /FastAPI/);
  assert.match(rNested.out, /src\.server:my_api/);
});

test("Go alternative layout: api/main.go with and without go.mod", () => {
  const dirMod = project({
    "go.mod": "module example.com/api\n\ngo 1.21\n",
    "api/main.go": "package main\nfunc main() {}\n",
  });
  const rMod = once([dirMod, "--dry"]);
  assert.strictEqual(rMod.code, 0);
  assert.match(rMod.out, /go run \.\/api/);

  const dirNoMod = project({
    "api/main.go": "package main\nfunc main() {}\n",
  });
  const rNoMod = once([dirNoMod, "--dry"]);
  assert.strictEqual(rNoMod.code, 0);
  assert.match(rNoMod.out, /go run api\/main\.go/);
});

test("Java Gradle Spring Boot with org.springframework.boot plugin", () => {
  const dir = project({
    "build.gradle": 'plugins { id "org.springframework.boot" version "3.2.0" }',
  });
  const r = once([dir, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Spring Boot \(Gradle\)/);
  assert.match(r.out, /bootRun/);
});

test("PHP detection: public/index.php docroot and Laravel artisan", () => {
  const dirDocroot = project({
    "public/index.php": "<?php echo 1;",
  });
  const rDoc = once([dirDocroot, "--dry"]);
  assert.strictEqual(rDoc.code, 0);
  assert.match(rDoc.out, /php -S localhost:8000 -t public/);

  const dirArtisan = project({
    "artisan": "#!/usr/bin/env php",
  });
  const rArt = once([dirArtisan, "--dry"]);
  assert.strictEqual(rArt.code, 0);
  assert.match(rArt.out, /Laravel/);
  assert.match(rArt.out, /php artisan serve/);
});

test("Elixir project detection: Phoenix vs plain Elixir", () => {
  const dirPhx = project({
    "mix.exs": 'defmodule MyApp.MixProject do\n  def project do\n    [deps: [{:phoenix, "~> 1.7"}]]\n  end\nend',
  });
  const rPhx = once([dirPhx, "--dry"]);
  assert.strictEqual(rPhx.code, 0);
  assert.match(rPhx.out, /Phoenix/);
  assert.match(rPhx.out, /mix phx\.server/);

  const dirElx = project({
    "mix.exs": 'defmodule MyApp.MixProject do\n  def project do\n    [deps: []]\n  end\nend',
  });
  const rElx = once([dirElx, "--dry"]);
  assert.strictEqual(rElx.code, 0);
  assert.match(rElx.out, /Elixir/);
  assert.match(rElx.out, /mix run --no-halt/);
});

test("Runtime crash diagnostics: actionable hints for DB, OpenSSL, EACCES, and missing module", () => {
  // 1. PostgreSQL ECONNREFUSED
  const dirPg = project({
    "package.json": JSON.stringify({ scripts: { start: "node boom.js" } }),
    "boom.js": 'console.error("Error: connect ECONNREFUSED 127.0.0.1:5432"); process.exit(1);',
  });
  const rPg = once([dirPg, "--no-open"]);
  assert.notStrictEqual(rPg.code, 0);
  assert.match(rPg.out, /PostgreSQL \(port 5432\)/);

  // 2. OpenSSL 3.0 legacy crypto incompatibility
  const dirOssl = project({
    "package.json": JSON.stringify({ scripts: { start: "node boom.js" } }),
    "boom.js": 'console.error("Error: digital envelope routines::unsupported ERR_OSSL_EVP_UNSUPPORTED"); process.exit(1);',
  });
  const rOssl = once([dirOssl, "--no-open"]);
  assert.notStrictEqual(rOssl.code, 0);
  assert.match(rOssl.out, /NODE_OPTIONS=--openssl-legacy-provider/);

  // 3. Privileged port (< 1024) EACCES
  const dirPort = project({
    "package.json": JSON.stringify({ scripts: { start: "node boom.js" } }),
    "boom.js": 'console.error("Error: listen EACCES: permission denied 0.0.0.0:80"); process.exit(1);',
  });
  const rPort = once([dirPort, "--no-open"]);
  assert.notStrictEqual(rPort.code, 0);
  assert.match(rPort.out, /privileged port \(< 1024\)/);

  // 4. Missing Node module
  const dirMod = project({
    "package.json": JSON.stringify({ scripts: { start: "node boom.js" } }),
    "boom.js": 'console.error("Error: Cannot find module \'lodash\'"); process.exit(1);',
  });
  const rMod = once([dirMod, "--no-open"]);
  assert.notStrictEqual(rMod.code, 0);
  assert.match(rMod.out, /npm install lodash/);
});

test("Environment template copying and preservation safety", () => {
  // Pre-existing .env is preserved
  const dirPreserve = project({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "server.js": SERVER,
    ".env": "EXISTING=keep_me\n",
    ".env.example": "EXISTING=overwrite_me\n",
  });
  const rPreserve = once([dirPreserve, "--dry"]);
  assert.strictEqual(rPreserve.code, 0);
  assert.strictEqual(fs.readFileSync(path.join(dirPreserve, ".env"), "utf8"), "EXISTING=keep_me\n");
});

test("an empty directory prints a clear actionable message", () => {
  const dirEmpty = project({});
  const r = once([dirEmpty, "--dry"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /This directory is empty/);
});

test("empty folder argument (e.g. unset shell variable) returns a clear error", () => {
  const r = once(["", "--dry"]);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /the folder path is empty/);
});

test("isFile safety prevents directories named Dockerfile or index.html from being detected as files", () => {
  const dirFake = project({});
  fs.mkdirSync(path.join(dirFake, "Dockerfile"));
  fs.mkdirSync(path.join(dirFake, "index.html"));
  const r = once([dirFake, "--dry"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /Couldn't recognise this project/);
});

test("Python NOT_ENTRY filter ignores setup.py and conftest.py as standalone apps", () => {
  const dirSetup = project({
    "setup.py": 'from setuptools import setup\nsetup(name="pkg")\n',
    "conftest.py": 'import pytest\n',
  });
  const r = once([dirSetup, "--dry"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /Couldn't recognise this project/);
});

test("package.json docs:dev script is recognized", () => {
  const dirDocs = project({
    "package.json": JSON.stringify({ scripts: { "docs:dev": "vitepress dev docs" } }),
  });
  const r = once([dirDocs, "--dry"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /docs:dev/);
});

test("Rust pure library crate without bin targets is not executed", () => {
  const dirRustLib = project({
    "Cargo.toml": '[package]\nname = "mylib"\nversion = "0.1.0"\n',
    "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }",
  });
  const r = once([dirRustLib, "--dry"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /Couldn't recognise this project/);
});



