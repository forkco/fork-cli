import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { parse } from "acorn";
import * as walk from "acorn-walk";
import { resolvePublic, webURL } from "./network.js";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const limit = 64 * 1024 * 1024;
const loaders = {
  ".wasm": "file",
  ".woff": "file",
  ".woff2": "file",
  ".ttf": "file",
  ".eot": "file",
  ".svg": "file",
  ".png": "file",
  ".jpg": "file",
  ".jpeg": "file",
  ".webp": "file",
  ".gif": "file",
  ".mp3": "file",
  ".mp4": "file",
  ".bin": "file",
  ".glb": "file",
  ".gltf": "file",
  ".hdr": "file",
};
function loader(file) {
  return (
    loaders[path.extname(file)] ||
    {
      ".json": "json",
      ".css": "css",
      ".ts": "ts",
      ".tsx": "tsx",
      ".jsx": "jsx",
    }[path.extname(file)] ||
    "js"
  );
}
export async function inspectTree(root, max = 512 * 1024 * 1024) {
  let size = 0,
    count = 0;
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      let stat;
      try {
        stat = await lstat(p);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (stat.isSymbolicLink()) throw Error("Package contains a symlink");
      if (stat.isDirectory()) await visit(p);
      else {
        size += stat.size;
        if (++count > 40000 || size > max)
          throw Error("Package installation exceeds disk/file budget");
      }
    }
  }
  await visit(root);
  return size;
}
async function get(raw, redirects = 0) {
  const u = webURL(raw);
  if (u.protocol !== "https:" || redirects > 5)
    throw Error("Invalid source URL/redirect");
  return new Promise((resolve, reject) => {
    const req = https.get(
      u,
      {
        agent: false,
        lookup: (host, opts, cb) =>
          resolvePublic(host).then(
            (a) => (opts.all ? cb(null, [a]) : cb(null, a.address, a.family)),
            cb,
          ),
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          resolve(get(new URL(res.headers.location, u).href, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(Error(`HTTP ${res.statusCode}: ${u.href}`));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", (b) => {
          size += b.length;
          if (size > 16 * 1024 * 1024) {
            req.destroy(Error("Remote module exceeds size budget"));
            return;
          }
          chunks.push(b);
        });
        res.on("end", () =>
          resolve({ body: Buffer.concat(chunks), url: u.href }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(30000, () => req.destroy(Error("Source request timeout")));
    req.on("error", reject);
  });
}
async function install(dir, r) {
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [r.package]: r.version } }),
  );
  await writeFile(path.join(dir, ".npmrc-user"), "");
  await writeFile(path.join(dir, ".npmrc-global"), "");
  const env = {
    ...process.env,
    npm_config_cache: path.join(dir, ".npm-cache"),
    npm_config_userconfig: path.join(dir, ".npmrc-user"),
    npm_config_globalconfig: path.join(dir, ".npmrc-global"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_proxy: process.env.FORK_BUILD_PROXY,
    npm_config_https_proxy: process.env.FORK_BUILD_PROXY,
    npm_config_noproxy: "",
    npm_config_git: "/bin/false",
  };
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--bin-links=false",
        "--install-links=false",
        "--fetch-retries=2",
        "--fetch-timeout=30000",
      ],
      { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let scanning = false;
    const timer = setInterval(async () => {
      if (scanning) return;
      scanning = true;
      try {
        await inspectTree(dir);
      } catch (e) {
        child.kill("SIGKILL");
        reject(e);
      } finally {
        scanning = false;
      }
    }, 1000);
    timer.unref();
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-3000);
    });
    child.on("error", (e) => {
      clearInterval(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearInterval(timer);
      code === 0
        ? resolve()
        : reject(Error(stderr || "npm installation failed"));
    });
  });
  await inspectTree(dir);
  const lock = JSON.parse(
    await readFile(path.join(dir, "package-lock.json"), "utf8"),
  );
  const dependencies = {};
  for (const [name, pkg] of Object.entries(lock.packages || {})) {
    if (!name) continue;
    if (pkg.link || !pkg.resolved?.startsWith("https://registry.npmjs.org/"))
      throw Error("Only registry dependencies are supported");
    dependencies[
      (pkg.name || name.split("node_modules/").at(-1)) + "@" + pkg.version
    ] = pkg.integrity || "";
  }
  if (Object.keys(dependencies).length > 128)
    throw Error("Dependency graph exceeds 128 packages");
  return dependencies;
}
export async function compileLibrary(dir, input, { installed = false } = {}) {
  dir = await realpath(dir);
  const r = input.request,
    shared = input.shared || {};
  const dependencies = r.source || installed ? {} : await install(dir, r);
  const outputs = new Map(),
    remote = new Map(),
    resourceRefs = new Map();
  let totalRemote = 0;
  const resourceRef = (key) => {
    const marker = "__FORK_RESOURCE_" + hash(key).slice(0, 24) + "__";
    resourceRefs.set(marker, key);
    return marker;
  };
  const outdir = path.join(dir, "output");
  const fetchModule = async (u) => {
    if (!remote.has(u)) {
      remote.set(
        u,
        get(u).then((result) => {
          totalRemote += result.body.length;
          if (remote.size > 256 || totalRemote > limit)
            throw Error("HTTP graph too large");
          return result;
        }),
      );
    }
    return remote.get(u);
  };
  const packageDir = path.join(dir, "node_modules", r.package || "");
  // Older Fontsource Variable packages publish axis stylesheets, not subset
  // entry points. Derive the requested subset from the published @font-face
  // rules, retaining its unicode-range and exact font file.
  async function fontSubset(specifier) {
    if (!r.package?.startsWith("@fontsource-variable/") ||
        !specifier.startsWith(r.package + "/")) return;
    const subpath = specifier.slice(r.package.length + 1);
    const match = /^([a-z]+(?:-[a-z]+)*?)(-italic)?\.css$/.exec(subpath);
    if (!match) return;
    try {
      await lstat(path.join(packageDir, subpath));
      return;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const axis = match[2] ? "wght-italic.css" : "wght.css";
    const css = await readFile(path.join(packageDir, axis), "utf8");
    const suffix = `-${match[1]}-wght-${match[2] ? "italic" : "normal"}.woff2`;
    const rules = [...css.matchAll(/@font-face\s*\{[^{}]*\}/g)]
      .map(([rule]) => rule)
      .filter(rule => rule.includes(suffix));
    if (!rules.length) throw Error(`Variable font has no subset ${subpath}`);
    return { path: subpath, namespace: "font-subset", pluginData: rules.join("\n") };
  }
  async function build(entry, folder, format = "esm", depth = 0) {
    if (depth > 8) throw Error("Worker recursion exceeds limit");
    const sharedHere = format === "iife" ? {} : shared;
    const asset = async (importer, value, workerType) => {
      let target,
        remoteAsset = importer.startsWith("https:");
      if (remoteAsset) target = new URL(value, importer).href;
      else if (value.startsWith("https:")) {
        target = value;
        remoteAsset = true;
      } else {
        target = path.resolve(path.dirname(importer), value);
        if (!target.startsWith(dir + path.sep))
          throw Error("Asset escapes package directory");
      }
      const suffix = path.extname(
        remoteAsset ? new URL(target).pathname : target,
      );
      if (workerType || [".js", ".mjs", ".ts"].includes(suffix)) {
        const childFolder =
          "workers/" +
          hash(
            (remoteAsset ? target : path.relative(dir, target)) +
              "\0" +
              (workerType || "module"),
          ).slice(0, 24);
        const childEntry = await build(
          target,
          childFolder,
          workerType === "classic" ? "iife" : "esm",
          depth + 1,
        );
        return resourceRef(childEntry);
      }
      const bytes = remoteAsset
        ? (await fetchModule(target)).body
        : await readFile(target);
      if (bytes.length > 32 * 1024 * 1024) throw Error("Asset too large");
      const key = "assets/" + hash(bytes) + suffix;
      outputs.set(key, bytes);
      return resourceRef(key);
    };
    async function relocate(bytes, importer, kind) {
      let text = bytes.toString();
      const pdfEntry = r.package === "pdfjs-dist" &&
        importer.startsWith(packageDir + path.sep) &&
        /^pdf(?:\.min)?\.mjs$/.test(path.basename(importer));
      if (!text.includes("import.meta") && !pdfEntry) return text;
      if (format === "iife" && depth === 0)
        throw Error("Asset-based global builds require ESM");
      if (["ts", "tsx", "jsx"].includes(kind))
        text = (
          await esbuild.transform(text, {
            loader: kind,
            target: "es2022",
            legalComments: "eof",
          })
        ).code;
      const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" }),
        changes = [],
        tasks = [];
      const isURL = (n) =>
        n?.type === "NewExpression" &&
        n.callee.name === "URL" &&
        n.arguments.length === 2 &&
        text.slice(n.arguments[1].start, n.arguments[1].end) ===
          "import.meta.url";
      walk.ancestor(ast, {
        NewExpression(n, parents) {
          if (
            ["Worker", "SharedWorker"].includes(n.callee.name) &&
            isURL(n.arguments[0])
          ) {
            const url = n.arguments[0],
              literal = url.arguments[0];
            if (typeof literal.value !== "string")
              throw Error("Worker path must be literal");
            let mode = "classic";
            const opts = n.arguments[1];
            if (opts) {
              if (opts.type !== "ObjectExpression")
                throw Error("Worker options must be literal");
              const type = opts.properties.find(
                (p) => (p.key.name || p.key.value) === "type",
              );
              if (type) {
                if (!["module", "classic"].includes(type.value.value))
                  throw Error("Worker type must be literal");
                mode = type.value.value;
              }
            }
            tasks.push(
              asset(importer, literal.value, mode).then((ref) => {
                const absolute = `new URL(${JSON.stringify(ref)},import.meta.url).href`;
                const code =
                  mode === "module"
                    ? `'import '+JSON.stringify(${absolute})+';'`
                    : `'globalThis.__forkWorkerSource='+JSON.stringify(${absolute})+';importScripts(globalThis.__forkWorkerSource);'`;
                changes.push({
                  start: url.start,
                  end: url.end,
                  text: `URL.createObjectURL(new Blob([${code}],{type:'text/javascript'}))`,
                });
              }),
            );
          } else if (isURL(n)) {
            const parent = parents.at(-2);
            if (
              parent?.type === "NewExpression" &&
              ["Worker", "SharedWorker"].includes(parent.callee.name)
            )
              return;
            if (typeof n.arguments[0].value !== "string")
              throw Error("Asset path must be literal");
            tasks.push(
              asset(importer, n.arguments[0].value).then((ref) =>
                changes.push({
                  start: n.arguments[0].start,
                  end: n.arguments[0].end,
                  text: JSON.stringify(ref),
                }),
              ),
            );
          }
        },
      });
      await Promise.all(tasks);
      for (const c of changes.sort((a, b) => b.start - a.start))
        text = text.slice(0, c.start) + c.text + text.slice(c.end);
      if (pdfEntry) {
        const options = ast.body.flatMap(n => n.type === "ExportNamedDeclaration" ? n.specifiers : [])
          .find(n => (n.exported.name || n.exported.value) === "GlobalWorkerOptions");
        if (!options) throw Error("PDF.js browser entry has no GlobalWorkerOptions export");
        const worker = path.basename(importer).replace(/^pdf/, "pdf.worker");
        const ref = await asset(importer, "./" + worker, "module");
        // PDF.js intentionally supports a caller-selected worker URL. Prepare a
        // matching default while preserving GlobalWorkerOptions overrides and
        // its dynamic fake-worker fallback.
        text += `\n${options.local.name}.workerSrc ||= new URL(${JSON.stringify(ref)},import.meta.url).href;\n`;
      }
      return text;
    }
    const plugin = {
      name: "fork-libraries",
      setup(b) {
        b.onResolve({ filter: /.*/ }, async (a) => {
          if (a.kind === "url-token" && a.path.startsWith("#"))
            return { path: a.path, external: true };
          if (a.kind === "entry-point") {
            const subset = await fontSubset(a.path);
            if (subset) return subset;
          }
          if (a.kind !== "entry-point" && sharedHere[a.path])
            return { path: a.path, namespace: "shared" };
          if (a.namespace === "shared") return { path: a.path, external: true };
          if (a.path.startsWith("https:") || a.namespace === "remote") {
            let target = a.path;
            if (a.namespace === "remote") {
              const origin = (await fetchModule(a.importer)).url;
              if (!/^(https:|\.|\/)/.test(target))
                throw Error("HTTP source has bare import; request npm package");
              target = new URL(target, origin).href;
            }
            webURL(target);
            if (!target.startsWith("https:")) throw Error("HTTPS required");
            return { path: target, namespace: "remote" };
          }
          if (a.path.startsWith("http:")) throw Error("HTTPS required");
        });
        b.onLoad({ filter: /.*/, namespace: "shared" }, (a) => ({
          contents: `import * as peer from ${JSON.stringify(sharedHere[a.path])};module.exports=peer.default??peer;`,
          loader: "js",
        }));
        b.onLoad({ filter: /.*/, namespace: "font-subset" }, (a) => ({
          contents: a.pluginData,
          loader: "css",
          resolveDir: packageDir,
        }));
        b.onLoad({ filter: /.*/, namespace: "remote" }, async (a) => {
          const v = await fetchModule(a.path),
            kind = loader(new URL(v.url).pathname);
          return {
            contents: ["js", "ts", "tsx", "jsx"].includes(kind)
              ? await relocate(v.body, v.url, kind)
              : v.body,
            loader: ["ts", "tsx", "jsx"].includes(kind) ? "js" : kind,
          };
        });
        b.onLoad(
          { filter: /\.[cm]?[jt]sx?$/, namespace: "file" },
          async (a) => {
            const data = await readFile(a.path);
            if (!data.includes("import.meta") && !(r.package === "pdfjs-dist" &&
                a.path.startsWith(packageDir + path.sep) &&
                /^pdf(?:\.min)?\.mjs$/.test(path.basename(a.path)))) return;
            return {
              contents: await relocate(data, a.path, loader(a.path)),
              loader: "js",
              resolveDir: path.dirname(a.path),
            };
          },
        );
      },
    };
    const result = await esbuild.build({
      absWorkingDir: dir,
      entryPoints: [entry],
      outdir: path.join(outdir, folder),
      entryNames: "index",
      bundle: true,
      write: false,
      format,
      platform: "browser",
      target: "es2022",
      splitting: format === "esm",
      metafile: true,
      logLevel: "silent",
      legalComments: "eof",
      conditions: ["browser", "production"],
      define: {
        "process.env.NODE_ENV": '"production"',
        ...(format === "iife" && depth
          ? { "import.meta.url": "globalThis.__forkWorkerSource" }
          : {}),
      },
      loader: loaders,
      chunkNames: "chunks/[name]-[hash]",
      assetNames: "assets/[name]-[hash]",
      plugins: [plugin],
      ...(format === "iife"
        ? {
            globalName: "__ForkCachedLibrary",
            footer: {
              js: `globalThis[${JSON.stringify(depth ? "__ForkWorkerModule" : r.global)}]=__ForkCachedLibrary?.default??__ForkCachedLibrary;`,
            },
          }
        : {}),
    });
    for (const warning of result.warnings) {
      if (/unsupported|not-bundled/.test(warning.id)) throw Error(warning.text);
    }
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imp of output.imports) {
        if (
          imp.external &&
          !Object.values(sharedHere).includes(imp.path) &&
          !imp.path.startsWith("data:") &&
          !(imp.kind === "url-token" && imp.path.startsWith("#"))
        )
          throw Error("Unresolved external import: " + imp.path);
      }
    }
    let entryFile;
    for (const f of result.outputFiles) {
      const key = path.relative(outdir, f.path).split(path.sep).join("/");
      if (key.startsWith("../")) throw Error("Output escaped directory");
      let contents = Buffer.from(f.contents);
      if (key.endsWith(".js")) {
        let text = contents.toString();
        for (const [marker, target] of resourceRefs)
          text = text.replaceAll(
            marker,
            "./" + path.posix.relative(path.posix.dirname(key), target),
          );
        contents = Buffer.from(text);
      }
      outputs.set(key, contents);
      if (
        key === path.posix.join(folder, "index.js") ||
        (!entryFile && key === path.posix.join(folder, "index.css"))
      )
        entryFile = key;
      if (key.endsWith(".js")) {
        const ast = parse(f.text, {
          ecmaVersion: "latest",
          sourceType: format === "esm" ? "module" : "script",
        });
        walk.simple(ast, {
          ImportExpression(n) {
            const workerSource = r.package === "pdfjs-dist" &&
              n.source.type === "MemberExpression" && !n.source.computed &&
              n.source.object.type === "ThisExpression" &&
              n.source.property.name === "workerSrc";
            // Recent PDF.js workers also load an optional decoder from the
            // caller's wasmUrl. Keep this specific runtime configuration path;
            // it is not an install-time dependency to guess or execute.
            const source = n.source;
            const decoderSource = r.package === "pdfjs-dist" &&
              source.type === "TemplateLiteral" && source.expressions.length === 2 &&
              source.quasis.every(q => q.value.raw === "") &&
              source.expressions[0].type === "MemberExpression" &&
              source.expressions[0].object.type === "Identifier" &&
              source.expressions[0].property.type === "PrivateIdentifier" &&
              source.expressions[1].type === "MemberExpression" &&
              !source.expressions[1].computed &&
              source.expressions[1].object.type === "ThisExpression" &&
              source.expressions[1].property.name === "_noWasmFilename";
            if (typeof n.source.value !== "string" && !workerSource && !decoderSource)
              throw Error("Nonliteral dynamic import requires explicit assets");
          },
        });
      }
    }
    if (!entryFile) throw Error("No browser entry");
    return entryFile;
  }
  const entry = await build(
    r.source || r.package + (r.subpath ? "/" + r.subpath : ""),
    "",
    r.global ? "iife" : "esm",
  );
  let size = 0;
  const files = [];
  for (const [name, data] of outputs) {
    size += data.length;
    if (size > limit || files.length >= 4096)
      throw Error("Compiled artifact exceeds limits");
    files.push({
      path: name,
      data: data.toString("base64"),
      sha256: hash(data),
    });
  }
  return { protocol: 1, entry, files, dependencies };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dir = process.argv[2];
  try {
    const request = JSON.parse(
      await readFile(path.join(dir, "request.json"), "utf8"),
    );
    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify(await compileLibrary(dir, request)),
    );
  } catch (e) {
    console.error(String(e.message).slice(0, 4000));
    process.exitCode = 1;
  }
}
