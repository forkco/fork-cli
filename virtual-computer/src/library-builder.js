import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Failure, check } from "./errors.js";

export function validateBuild(body) {
  check(body && body.protocol === 1, "Library protocol 1 is required");
  const r = body.request;
  check(r && typeof r === "object", "request is required");
  if (r.source) {
    const u = new URL(r.source);
    check(
      u.protocol === "https:" && !u.username && !u.password,
      "HTTPS source required",
    );
  } else {
    check(
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(r.package || ""),
      "Invalid npm package",
    );
    check(
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(r.version || ""),
      "An exact npm version is required",
    );
    check(
      !r.subpath ||
        (typeof r.subpath === "string" &&
          !r.subpath.startsWith("/") &&
          !r.subpath.split("/").some((x) => x === ".." || x === "." || !x) &&
          !/[\\\0]/.test(r.subpath)),
      "Invalid npm subpath",
    );
  }
  check(
    !r.global || /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(r.global),
    "Invalid global",
  );
  check(
    !body.shared ||
      (typeof body.shared === "object" &&
        Object.keys(body.shared).length <= 128),
    "Invalid shared imports",
  );
  for (const [name, value] of Object.entries(body.shared || {})) {
    check(
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._/-]*$/.test(name),
      "Invalid shared name",
    );
    const u = new URL(value);
    check(
      u.protocol === "https:" && !u.username && !u.password,
      "Invalid shared URL",
    );
  }
  check(
    !r.global || !Object.keys(body.shared || {}).length,
    "Global builds with shared ESM peers require ESM instead",
  );
  return { protocol: 1, request: r, shared: body.shared || {} };
}
export class LibraryBuilder {
  constructor(proxyURL, { limit = 2, timeout = 170000 } = {}) {
    this.proxyURL = proxyURL;
    this.limit = limit;
    this.timeout = timeout;
    this.jobs = new Set();
    this.closing = false;
  }
  async run(input, signal) {
    const request = validateBuild(input);
    if (this.closing || this.jobs.size >= this.limit)
      throw new Failure(
        429,
        "library_capacity",
        "Library workers busy; retry later",
      );
    let completed;
    const job = {
      done: new Promise((resolve) => {
        completed = resolve;
      }),
    };
    this.jobs.add(job);
    const terminate = () => {
      if (job.child?.pid) {
        try {
          process.kill(-job.child.pid, "SIGKILL");
        } catch {
          job.child.kill("SIGKILL");
        }
      }
    };
    job.terminate = terminate;
    try {
      if (signal?.aborted)
        throw new Failure(499, "cancelled", "Library request cancelled");
      job.dir = await mkdtemp(path.join(tmpdir(), "fork-library-"));
      await writeFile(
        path.join(job.dir, "request.json"),
        JSON.stringify(request),
      );
      await new Promise((resolve, reject) => {
        // Never inherit service/API/S3 secrets or caller environment into npm/esbuild.
        const env = {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: job.dir,
          TMPDIR: job.dir,
          LANG: "C.UTF-8",
          NODE_OPTIONS: "--max-old-space-size=768",
          FORK_BUILD_PROXY: this.proxyURL,
        };
        job.child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./library-worker.js", import.meta.url)),
            job.dir,
          ],
          { env, detached: true, stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        job.child.stderr.on("data", (b) => {
          stderr = (stderr + b.toString()).slice(-4000);
        });
        const finish = (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          err ? reject(err) : resolve();
        };
        const abort = () => {
          terminate();
          finish(new Failure(499, "cancelled", "Library request cancelled"));
        };
        const timer = setTimeout(() => {
          terminate();
          finish(
            new Failure(
              504,
              "library_timeout",
              "Library preparation timed out",
            ),
          );
        }, this.timeout);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        job.child.once("error", finish);
        job.child.once("exit", (code) => {
          terminate();
          finish(
            code === 0
              ? null
              : new Failure(
                  422,
                  "library_build_failed",
                  stderr || "Library worker failed",
                ),
          );
        });
      });
      const raw = await readFile(path.join(job.dir, "result.json"));
      if (raw.length > 92 * 1024 * 1024)
        throw new Failure(
          413,
          "library_too_large",
          "Library response exceeds limit",
        );
      return JSON.parse(raw);
    } finally {
      terminate();
      if (job.dir) await rm(job.dir, { recursive: true, force: true });
      this.jobs.delete(job);
      completed();
    }
  }
  async close() {
    this.closing = true;
    const jobs = [...this.jobs];
    for (const job of jobs) job.terminate();
    await Promise.all(jobs.map((job) => job.done));
  }
}
