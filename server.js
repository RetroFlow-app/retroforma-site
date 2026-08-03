const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);
const adminCode = process.env.RETROFORMA_ADMIN_CODE || "";
const persistentDir = process.env.RETROFORMA_DATA_DIR || (fs.existsSync("/var/data") ? "/var/data/retroforma" : path.join(rootDir, "data"));
const dataFile = process.env.RETROFORMA_DATA_FILE || path.join(persistentDir, "projects.json");
const seedFile = path.join(rootDir, "data", "projects.json");
let pgPool = null;
let pgReady = false;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function ensureDataFile() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.copyFileSync(seedFile, dataFile);
  }
}

function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

function readSeedData() {
  const raw = fs.readFileSync(seedFile, "utf8");
  const parsed = JSON.parse(raw);
  return {
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    updatedAt: parsed.updatedAt || null
  };
}

function getPgPool() {
  if (!pgPool) {
    const { Pool } = require("pg");
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false }
    });
  }
  return pgPool;
}

async function ensureDatabase() {
  if (!hasDatabase() || pgReady) return;
  const pool = getPgPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS retroforma_store (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const existing = await pool.query("SELECT key FROM retroforma_store WHERE key = $1", ["projects"]);
  if (!existing.rowCount) {
    await pool.query(
      "INSERT INTO retroforma_store (key, value, updated_at) VALUES ($1, $2::jsonb, now())",
      ["projects", JSON.stringify(readSeedData())]
    );
  }
  pgReady = true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function readData() {
  if (hasDatabase()) {
    await ensureDatabase();
    const result = await getPgPool().query("SELECT value, updated_at FROM retroforma_store WHERE key = $1", ["projects"]);
    const row = result.rows[0];
    const value = row?.value || {};
    return {
      projects: Array.isArray(value.projects) ? value.projects : [],
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : value.updatedAt || null
    };
  }
  ensureDataFile();
  const raw = fs.readFileSync(dataFile, "utf8");
  const parsed = JSON.parse(raw);
  return {
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    updatedAt: parsed.updatedAt || null
  };
}

async function writeData(data) {
  const next = {
    projects: Array.isArray(data.projects) ? data.projects : [],
    updatedAt: new Date().toISOString()
  };
  if (hasDatabase()) {
    await ensureDatabase();
    await getPgPool().query(
      `INSERT INTO retroforma_store (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      ["projects", JSON.stringify(next)]
    );
    return next;
  }
  ensureDataFile();
  const tmpFile = dataFile + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmpFile, dataFile);
  return next;
}

function normalizeProject(input, current = {}) {
  const title = String(input.title ?? current.title ?? "").trim();
  const description = String(input.description ?? current.description ?? "").trim();
  if (!title || !description) {
    const error = new Error("Title and description are required");
    error.statusCode = 400;
    throw error;
  }
  const images = Array.isArray(input.images)
    ? input.images.map((item) => String(item || "").trim()).filter(Boolean)
    : Array.isArray(current.images) ? current.images : [];
  return {
    id: String(input.id ?? current.id ?? ("project-" + Date.now())).trim(),
    title,
    description,
    tag: String(input.tag ?? current.tag ?? "").trim(),
    price: String(input.price ?? current.price ?? "").trim(),
    shipping: String(input.shipping ?? current.shipping ?? "").trim(),
    leadTime: String(input.leadTime ?? current.leadTime ?? "").trim(),
    payment: String(input.payment ?? current.payment ?? "").trim(),
    availableForOrder: input.availableForOrder === true || input.availableForOrder === "true" || input.availableForOrder === "on",
    images: images.length ? images : ["./Projekty/stojak.jpg"]
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": process.env.RETROFORMA_ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-code,authorization"
  });
  res.end(body);
}

function isAuthorized(req) {
  if (!adminCode) return false;
  const header = req.headers["x-admin-code"] || "";
  const auth = req.headers.authorization || "";
  return header === adminCode || auth === `Bearer ${adminCode}`;
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  let filePath = path.normalize(path.join(rootDir, pathname));
  if (!hasDatabase() && pathname === "/data/projects.json") {
    ensureDataFile();
    filePath = dataFile;
  }
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300"
    });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, storage: hasDatabase() ? "postgres" : "file" });
    return;
  }
  if (url.pathname === "/api/projects" && req.method === "GET") {
    sendJson(res, 200, await readData());
    return;
  }
  if (url.pathname === "/api/admin/check" && req.method === "GET") {
    if (isAuthorized(req)) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 401, { error: "Unauthorized" });
    }
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (url.pathname === "/api/projects" && req.method === "PUT") {
    const body = await readJsonBody(req);
    const projects = Array.isArray(body.projects) ? body.projects.map((project) => normalizeProject(project)) : null;
    if (!projects) {
      sendJson(res, 400, { error: "projects array is required" });
      return;
    }
    sendJson(res, 200, await writeData({ projects }));
    return;
  }
  if (url.pathname === "/api/projects" && req.method === "POST") {
    const body = await readJsonBody(req);
    const data = await readData();
    const project = normalizeProject({ ...body, id: body.id || ("project-" + Date.now()) });
    data.projects.unshift(project);
    sendJson(res, 201, await writeData(data));
    return;
  }
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match && req.method === "PUT") {
    const id = decodeURIComponent(match[1]);
    const body = await readJsonBody(req);
    const data = await readData();
    const index = data.projects.findIndex((project) => project.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: "Project not found" });
      return;
    }
    data.projects[index] = normalizeProject({ ...body, id }, data.projects[index]);
    sendJson(res, 200, await writeData(data));
    return;
  }
  if (match && req.method === "DELETE") {
    const id = decodeURIComponent(match[1]);
    const data = await readData();
    data.projects = data.projects.filter((project) => project.id !== id);
    sendJson(res, 200, await writeData(data));
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": process.env.RETROFORMA_ALLOWED_ORIGIN || "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,x-admin-code,authorization"
    });
    res.end();
    return;
  }
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => {
      sendJson(res, error.statusCode || 500, { error: error.message || "Server error" });
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(port, () => {
  if (!hasDatabase()) ensureDataFile();
  console.log(`RetroForma server listening on ${port}`);
  console.log(hasDatabase() ? "Storage: postgres" : `Data file: ${dataFile}`);
});
