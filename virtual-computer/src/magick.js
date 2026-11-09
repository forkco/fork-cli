import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Failure, check } from "./errors.js";
import { publicIP, resolvePublic, webURL } from "./network.js";
import {workspaceImagePlan} from './workspace-magick.js';
import {browserDevice, browserIdentity} from './browser-device.js';

// One ImageMagick job: the agent's `convert …` / `identify …` line runs against
// the real CLI in a scratch directory. URL operands are downloaded first, bare
// filenames come from the caller's S3 prefix, and every produced file is
// uploaded back under that prefix. ImageMagick itself never touches the
// network or arbitrary paths: policy.xml (deploy/magick) disables the risky
// coders and the child gets a stripped environment.

export const MAX_INPUTS = 8;
export const MAX_INPUT_BYTES = 25 << 20;
export const MAX_OUTPUT_BYTES = 40 << 20;
export const MAX_OUTPUT_FILES = 64;

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|svg|ico)$/i;
const FORMAT_PREFIX = /^(?:png|jpe?g|webp|gif|bmp|tiff?|avif|ico):/i;
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const PSEUDO_INPUT = /^(xc|canvas|gradient|radial-gradient|plasma|label|caption|pattern|rose|logo|wizard|granite|netscape|null|tile):/i;
// Options that read/write outside the job or load code. -write/-script would
// bypass the output contract; -process loads modules; -display needs X.
const FORBIDDEN_OPTIONS = /^[-+](write|script|process|display|preview|debug|log|list|help|version|usage|module|authenticate|profile|set)$/i;

const CONTENT_TYPES = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml" };

// POSIX-ish word splitting: quotes group, backslash escapes.
export function splitArgs(s) {
  const args = [];
  let cur = "";
  let inWord = false;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) {
        args.push(cur);
        cur = "";
        inWord = false;
      }
    } else {
      cur += c;
      inWord = true;
    }
  }
  check(!quote, `Unterminated ${quote} quote`);
  if (inWord) args.push(cur);
  return args;
}

// validate turns the command line into a plan: which tokens are inputs (URL or
// S3 name), which one is the output, and the argv ImageMagick will receive
// with placeholders for the files. Everything else passes through untouched
// so the whole convert/identify vocabulary stays available.
export function validate(body) {
  check(body && typeof body.command === "string" && body.command.length <= 8192, "command (string, ≤8 KiB) is required");
  const prefix = body.output?.prefix;
  check(typeof prefix === "string" && /^static\/[0-9a-f-]{36}\/[0-9a-z-]{1,36}\/$/i.test(prefix), "output.prefix must be static/<user>/<app>/");
  let tokens = splitArgs(body.command);
  check(tokens.length > 0, "empty command");
  let tool = "convert";
  const first = tokens[0].toLowerCase();
  if (first === "magick") {
    tokens = tokens.slice(1);
    if (tokens[0]?.toLowerCase() === "identify") {
      tool = "identify";
      tokens = tokens.slice(1);
    } else if (tokens[0]?.toLowerCase() === "convert") tokens = tokens.slice(1);
  } else if (first === "convert") tokens = tokens.slice(1);
  else if (first === "identify") {
    tool = "identify";
    tokens = tokens.slice(1);
  } else if (["mogrify", "montage", "composite", "compare", "display", "import", "animate", "conjure", "stream"].includes(first))
    throw new Failure(400, "invalid_request", `${first} is not available; express it as convert … or identify …`);
  check(tokens.length > 0, "no arguments");

  const inputs = [];
  const argv = [];
  let output = null;
  const last = tokens.length - 1;
  tokens.forEach((tok, i) => {
    check(!FORBIDDEN_OPTIONS.test(tok), `${tok} is not available`);
    // "@file" reads (argument lists, label:@file, -fx @file …) are the one
    // way ImageMagick opens a caller-named local path; URLs are checked below.
    check(/^https?:\/\//i.test(tok.replace(FORMAT_PREFIX, "")) || !tok.includes("@"), "@file references are not available");
    check(!/^(fd|file|ftp|msl|text|txt|ephemeral|show|win|print|x|pango|ps|eps|pdf|xps):/i.test(tok), `${tok.split(":")[0]}: pseudo-format is not available`);
    if (tool === "convert" && i === last) {
      check(!/^[-+][A-Za-z]/.test(tok), "the output filename must be the last argument");
      const bare = tok.replace(FORMAT_PREFIX, "");
      check(OUTPUT_NAME.test(bare.replace(/%0?\d*d/, "0")) && !bare.includes(".."), "output name may only contain letters, digits, '.', '_', '-' and '/' segments");
      check(IMAGE_EXT.test(bare) || FORMAT_PREFIX.test(tok), "output needs an image extension (png, jpg, webp, gif, bmp, tiff, ico, avif)");
      output = { index: argv.length, name: bare, prefix: FORMAT_PREFIX.test(tok) ? tok.slice(0, tok.indexOf(":") + 1) : "" };
      argv.push(null); // filled with the scratch path
      return;
    }
    const bare = tok.replace(FORMAT_PREFIX, "");
    if (/^https?:\/\//i.test(bare)) {
      const u = webURL(bare);
      const host = u.hostname.replace(/^\[|\]$/g, "");
      check(!net.isIP(host) || publicIP(host), "Private or reserved network destination denied");
      inputs.push({ index: argv.length, url: u.href, name: path.posix.basename(u.pathname) || "input" });
      argv.push(null);
      return;
    }
    if (PSEUDO_INPUT.test(tok)) {
      check(!/[/\\]/.test(tok), `${tok}: paths are not available inside pseudo-images`);
      argv.push(tok);
      return;
    }
    if (/^[-+][A-Za-z]/.test(tok)) {
      argv.push(tok);
      return;
    }
    if (IMAGE_EXT.test(bare)) {
      check(OUTPUT_NAME.test(bare) && !bare.includes(".."), `${tok}: inputs must be URLs or filenames written by an earlier magick call`);
      inputs.push({ index: argv.length, key: prefix + bare, name: bare });
      argv.push(null);
      return;
    }
    check(!tok.includes("/") && !tok.includes("\\"), `${tok}: paths are not available; use URLs or filenames from earlier calls`);
    argv.push(tok);
  });
  check(inputs.length <= MAX_INPUTS, `at most ${MAX_INPUTS} input images per command`);
  check(tool === "identify" || output, "convert needs an output filename");
  check(inputs.length > 0 || argv.some((t) => typeof t === "string" && PSEUDO_INPUT.test(t)), `${tool} needs an input image (URL or a filename from an earlier call)`);
  return { tool, argv, inputs, output, prefix };
}

async function download(url, maxBytes) {
  const u = new URL(url);
  const address = await resolvePublic(u.hostname);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { host: address.address, family: address.family, servername: u.hostname, port: u.protocol === "https:" ? 443 : 80, path: u.pathname + u.search, method: "GET", headers: { host: u.host, "user-agent": browserIdentity(browserDevice()).userAgent, accept: "image/*,*/*;q=0.5" }, agent: false },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).href, maxBytes));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Failure(422, "input_unavailable", `${url} returned HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) req.destroy(new Failure(413, "input_too_large", `${url} exceeds ${maxBytes >> 20} MiB`));
          else chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Failure(504, "input_timeout", `${url} timed out`)));
    req.on("error", reject);
    req.end();
  });
}

function run(bin, args, { cwd, timeout, maxOutput = 64 * 1024, signal }) {
  return new Promise((resolve, reject) => {
    if(signal?.aborted){reject(new Failure(499,'cancelled','Image request cancelled'));return}
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: cwd,
      TMPDIR: cwd,
      MAGICK_TMPDIR: cwd,
      LANG: "C.UTF-8",
      MAGICK_CONFIGURE_PATH: fileURLToPath(new URL("../deploy/magick", import.meta.url)),
      MAGICK_MEMORY_LIMIT: "1GiB",
      MAGICK_MAP_LIMIT: "2GiB",
      MAGICK_DISK_LIMIT: "4GiB",
      MAGICK_AREA_LIMIT: "256MP",
      MAGICK_WIDTH_LIMIT: "32KP",
      MAGICK_HEIGHT_LIMIT: "32KP",
      MAGICK_THREAD_LIMIT: "4",
      MAGICK_TIME_LIMIT: String(Math.ceil(timeout / 1000)),
    };
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout = (stdout + b.toString()).slice(0, maxOutput);
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b.toString()).slice(-maxOutput);
    });
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      kill();
      reject(new Failure(504, "magick_timeout", `ImageMagick exceeded ${Math.round(timeout / 1000)}s`));
    }, timeout);
    const abort=()=>{kill();};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    child.once("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      reject(new Failure(503, "magick_unavailable", `ImageMagick is not installed: ${e.message}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.once('close',()=>signal?.removeEventListener('abort',abort));
  });
}

export class Magick {
  constructor(s3, { limit = 3, timeout = 60_000 } = {}) {
    this.s3 = s3;
    this.limit = limit;
    this.timeout = timeout;
    this.jobs = new Set();
    this.closing = false;
  }
  async run(body, signal) {
    const plan = validate(body);
    if (!this.s3) throw new Failure(503, "magick_unavailable", "Image storage is not configured");
    return this.execute(plan,signal,this.s3);
  }
  async runWorkspace(body,signal){
    if(this.closing||this.jobs.size>=this.limit)throw new Failure(429,'magick_capacity','Image workers busy');
    const {data,plan}=workspaceImagePlan(body);
    let saved;
    const result=await this.execute(plan,signal,{
      get:async key=>key==='private-input'?data:null,
      put:async(key,bytes,contentType)=>{saved={data:bytes,content_type:contentType}}
    });
    if(plan.tool==='identify')return {tool:'identify',stdout:result.stdout};
    check(saved&&result.outputs.length===1,'Expected one private image');
    return {tool:'convert',data:saved.data.toString('base64'),content_type:saved.content_type,width:result.outputs[0].width,height:result.outputs[0].height};
  }
  async execute(plan, signal, storage) {
    if (this.closing || this.jobs.size >= this.limit) throw new Failure(429, "magick_capacity", "Image workers busy; retry later");
    const job = { dir: null };
    this.jobs.add(job);
    try {
      job.dir = await mkdtemp(path.join(tmpdir(), "fork-magick-"));
      await mkdir(path.join(job.dir, "in"));
      await mkdir(path.join(job.dir, "out"));
      const argv = [...plan.argv];
      let n = 0;
      for (const input of plan.inputs) {
        if (signal?.aborted) throw new Failure(499, "cancelled", "Image request cancelled");
        let data;
        if (input.url) data = await download(input.url, MAX_INPUT_BYTES);
        else {
          data = await storage.get(input.key, { maxBytes: MAX_INPUT_BYTES });
          if (!data) throw new Failure(422, "input_unavailable", `${input.name}: no such file; inputs must be URLs or filenames written by an earlier magick call`);
        }
        check(data.length > 0, `${input.name}: empty file`);
        const ext = path.extname(input.name).slice(0, 8) || "";
        const file = path.join("in", `${n++}${ext}`);
        await writeFile(path.join(job.dir, file), data);
        // Keep an explicit format prefix the agent wrote ("png:file").
        argv[input.index] = (input.format ? input.format+':' : (plan.argv[input.index] ?? "")) + file + (input.firstFrame?'[0]':'');
      }
      if (plan.output) argv[plan.output.index] = plan.output.prefix + path.join("out", plan.output.name);
      const bin = plan.tool === "identify" ? "identify" : "convert";
      const result = await run(bin, argv, { cwd: job.dir, timeout: plan.timeout||this.timeout, signal });
      if(signal?.aborted)throw new Failure(499,'cancelled','Image request cancelled');
      if (result.code !== 0) {
        const message = (result.stderr || result.stdout || `${bin} exited with ${result.signal || result.code}`).replace(new RegExp(job.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "").trim();
        throw new Failure(422, "magick_failed", message.slice(0, 2000));
      }
      if (plan.tool === "identify") return { tool: "identify", stdout: result.stdout.replaceAll(job.dir + "/", ""), stderr: result.stderr.slice(0, 2000) };
      const outputs = await this.collect(job.dir, plan, storage, signal);
      return { tool: "convert", outputs, stderr: result.stderr.slice(0, 2000) };
    } finally {
      if (job.dir) await rm(job.dir, { recursive: true, force: true });
      this.jobs.delete(job);
    }
  }
  // Every file ImageMagick left in out/ is uploaded; multi-frame writes produce
  // name-0.ext, name-1.ext… exactly as the CLI does.
  async collect(dir, plan, storage=this.s3, signal) {
    const outDir = path.join(dir, "out");
    const files = [];
    const walk = async (rel) => {
      for (const entry of await readdir(path.join(outDir, rel), { withFileTypes: true })) {
        const p = path.posix.join(rel, entry.name);
        if (entry.isDirectory()) await walk(p);
        else files.push(p);
      }
    };
    await walk("");
    check(files.length > 0, "ImageMagick produced no output file");
    check(files.length <= MAX_OUTPUT_FILES, `ImageMagick produced ${files.length} files; at most ${MAX_OUTPUT_FILES} are kept`);
    check(!plan.singleOutput||files.length===1,'Private image commands must produce one file; use explicit crop dimensions');
    files.sort();
    let total = 0;
    const outputs = [];
    for (const name of files) {
      if(signal?.aborted)throw new Failure(499,'cancelled','Image request cancelled');
      const full = path.join(outDir, name);
      const size = (await stat(full)).size;
      total += size;
      check(total <= (plan.maxOutputBytes||MAX_OUTPUT_BYTES), 'Image outputs exceed size limit');
      const probe = await run("identify", ["-format", "%m %w %h", full + "[0]"], { cwd: dir, timeout: plan.singleOutput?3000:15_000,signal });
      check(!plan.singleOutput||probe.code===0,'Cannot validate output image');
      const [format = "", w = "0", h = "0"] = probe.stdout.trim().split(/\s+/);
      const ext = path.extname(name).slice(1).toLowerCase();
      const contentType = CONTENT_TYPES[ext] || CONTENT_TYPES[format.toLowerCase()] || "application/octet-stream";
      const key = plan.prefix + name;
      if(signal?.aborted)throw new Failure(499,'cancelled','Image request cancelled');
      await storage.put(key, await readFile(full), contentType);
      outputs.push({ name, key, format: format || ext.toUpperCase(), content_type: contentType, width: Number(w) || 0, height: Number(h) || 0, bytes: size });
    }
    return outputs;
  }
  async close() {
    this.closing = true;
  }
}
