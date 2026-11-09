import { createHash, createHmac } from "node:crypto";
import https from "node:https";
import { resolvePublic } from "./network.js";

// Minimal SigV4 client for the Fork bucket (DigitalOcean Spaces). Only the two
// verbs image jobs need; the endpoint is resolved through the same checked-IP
// path as every other outbound connection.
export class S3 {
  constructor({ endpoint, bucket, accessKey, secretKey }) {
    if (!endpoint || !bucket || !accessKey || !secretKey)
      throw new Error("COMPUTER_S3_ENDPOINT, _BUCKET, _ACCESS_KEY and _SECRET_KEY are required");
    this.endpoint = endpoint;
    this.bucket = bucket;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.region = endpoint.split(".")[0];
    this.host = `${bucket}.${endpoint}`;
  }
  static fromEnv(env = process.env) {
    if (!env.COMPUTER_S3_ACCESS_KEY) return null;
    return new S3({
      endpoint: env.COMPUTER_S3_ENDPOINT || "ams3.digitaloceanspaces.com",
      bucket: env.COMPUTER_S3_BUCKET || "fork",
      accessKey: env.COMPUTER_S3_ACCESS_KEY,
      secretKey: env.COMPUTER_S3_SECRET_KEY,
    });
  }
  sign(method, key, headers, payloadHash) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const date = amzDate.slice(0, 8);
    const path = "/" + key.split("/").map(encodeURIComponent).join("/");
    const signed = {};
    for (const [k, v] of Object.entries({ ...headers, host: this.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash })) signed[k.toLowerCase()] = String(v).trim();
    const names = Object.keys(signed).sort();
    const canonicalHeaders = names.map((k) => `${k}:${signed[k]}\n`).join("");
    const canonical = [method, path, "", canonicalHeaders, names.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    let k = createHmac("sha256", "AWS4" + this.secretKey).update(date).digest();
    for (const part of [this.region, "s3", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
    const signature = createHmac("sha256", k).update(toSign).digest("hex");
    signed.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    return { path, headers: signed };
  }
  async request(method, key, body, extraHeaders = {}, { maxBytes = 64 << 20, timeout = 60_000 } = {}) {
    const payloadHash = sha256(body || "");
    const headers = { ...extraHeaders };
    if (body) headers["content-length"] = String(body.length);
    const { path, headers: signedHeaders } = this.sign(method, key, headers, payloadHash);
    const address = await resolvePublic(this.host);
    return new Promise((resolve, reject) => {
      const req = https.request(
        { host: address.address, family: address.family, servername: this.host, port: 443, method, path, headers: signedHeaders, agent: false },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (c) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy(new Error("S3 response exceeds limit"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.setTimeout(timeout, () => req.destroy(new Error("S3 request timed out")));
      req.on("error", reject);
      req.end(body);
    });
  }
  async get(key, options) {
    const res = await this.request("GET", key, null, {}, options);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`S3 GET ${key} failed (${res.status})`);
    return res.body;
  }
  // Matches the backend's static-asset headers: public, immutable, downloadable.
  async put(key, body, contentType) {
    const res = await this.request("PUT", key, body, {
      "content-type": contentType,
      "x-amz-acl": "public-read",
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": 'attachment; filename="image.jpg"',
    });
    if (res.status !== 200) throw new Error(`S3 PUT ${key} failed (${res.status}): ${res.body.toString().slice(0, 300)}`);
  }
}
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
