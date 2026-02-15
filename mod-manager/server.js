const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { status: mcStatus } = require("minecraft-server-util");
const Docker = require("dockerode");

const app = express();
const PORT = 3000;
const MODS_DIR = process.env.MODS_DIR || path.resolve(__dirname, "../mods");
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MC_HOST = process.env.MC_HOST || "mc";
const MC_PORT = parseInt(process.env.MC_PORT || "25565");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Auto-discover the MC container by image name
async function findMcContainer() {
  try {
    const containers = await docker.listContainers({ all: true });
    const mc = containers.find((c) => c.Image.includes("itzg/minecraft-server"));
    if (mc) return docker.getContainer(mc.Id);
  } catch (err) {
    console.error("Docker discovery error:", err.message);
  }
  return null;
}

// Ensure mods directory exists
if (!fs.existsSync(MODS_DIR)) {
  fs.mkdirSync(MODS_DIR, { recursive: true });
}

// Multer for mod uploads (to mods dir)
const modStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MODS_DIR),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const modUpload = multer({
  storage: modStorage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === ".jar") {
      cb(null, true);
    } else {
      cb(new Error("Only .jar files are allowed"));
    }
  },
});

// Multer for general file uploads (to any dir under DATA_DIR)
const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DATA_DIR, req.query.path || "");
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(DATA_DIR))) {
      return cb(new Error("Invalid path"));
    }
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    cb(null, resolved);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const fileUpload = multer({ storage: fileStorage });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---- Server Status ----
app.get("/api/status", async (req, res) => {
  try {
    const result = await mcStatus(MC_HOST, MC_PORT, { timeout: 5000 });
    res.json({
      online: true,
      players: { online: result.players.online, max: result.players.max },
      version: result.version.name,
      motd: result.motd.clean,
      latency: result.roundTripLatency,
    });
  } catch (err) {
    res.json({ online: false, error: err.message });
  }
});

// ---- Restart MC Server ----
app.post("/api/restart", async (req, res) => {
  try {
    const container = await findMcContainer();
    if (!container) return res.status(404).json({ error: "Minecraft container not found" });
    await container.restart();
    res.json({ message: "Server restarting..." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Mods API ----
app.get("/api/mods", (req, res) => {
  const files = fs.readdirSync(MODS_DIR);
  const mods = files
    .filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled"))
    .map((f) => {
      const stats = fs.statSync(path.join(MODS_DIR, f));
      return { name: f, size: stats.size, enabled: f.endsWith(".jar"), modified: stats.mtime };
    });
  res.json(mods);
});

app.post("/api/mods", modUpload.array("mod", 20), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
  res.json({ message: `Uploaded ${req.files.length} mod(s)` });
});

app.delete("/api/mods/:name", (req, res) => {
  const filePath = path.join(MODS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  fs.unlinkSync(filePath);
  res.json({ message: `Deleted ${req.params.name}` });
});

app.patch("/api/mods/:name/toggle", (req, res) => {
  const name = req.params.name;
  const filePath = path.join(MODS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  let newName;
  if (name.endsWith(".jar.disabled")) newName = name.replace(".jar.disabled", ".jar");
  else if (name.endsWith(".jar")) newName = name + ".disabled";
  else return res.status(400).json({ error: "Not a mod file" });
  fs.renameSync(filePath, path.join(MODS_DIR, newName));
  res.json({ message: `Renamed to ${newName}` });
});

// ---- File Manager API ----
function safePath(base, rel) {
  const full = path.resolve(base, rel || "");
  if (!full.startsWith(path.resolve(base))) return null;
  return full;
}

// List directory
app.get("/api/files", (req, res) => {
  const dir = safePath(DATA_DIR, req.query.path);
  if (!dir) return res.status(400).json({ error: "Invalid path" });
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "Directory not found" });
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const items = entries.map((e) => {
      const stats = fs.statSync(path.join(dir, e.name));
      return {
        name: e.name,
        isDirectory: e.isDirectory(),
        size: stats.size,
        modified: stats.mtime,
      };
    });
    items.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read file content
app.get("/api/files/read", (req, res) => {
  const filePath = safePath(DATA_DIR, req.query.path);
  if (!filePath) return res.status(400).json({ error: "Invalid path" });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return res.status(400).json({ error: "Not a file" });
  }
  const stats = fs.statSync(filePath);
  if (stats.size > 1024 * 512) return res.status(400).json({ error: "File too large to edit (>512KB)" });
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ content, name: path.basename(filePath) });
  } catch {
    res.status(400).json({ error: "Cannot read file (binary?)" });
  }
});

// Save/write file content
app.put("/api/files/write", (req, res) => {
  const filePath = safePath(DATA_DIR, req.body.path);
  if (!filePath) return res.status(400).json({ error: "Invalid path" });
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, req.body.content || "", "utf-8");
    res.json({ message: `Saved ${path.basename(filePath)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new file
app.post("/api/files/create", (req, res) => {
  const filePath = safePath(DATA_DIR, req.body.path);
  if (!filePath) return res.status(400).json({ error: "Invalid path" });
  if (fs.existsSync(filePath)) return res.status(409).json({ error: "Already exists" });
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "", "utf-8");
    res.json({ message: `Created ${path.basename(filePath)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new folder
app.post("/api/files/mkdir", (req, res) => {
  const dirPath = safePath(DATA_DIR, req.body.path);
  if (!dirPath) return res.status(400).json({ error: "Invalid path" });
  if (fs.existsSync(dirPath)) return res.status(409).json({ error: "Already exists" });
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ message: `Created folder ${path.basename(dirPath)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename file or folder
app.post("/api/files/rename", (req, res) => {
  const oldPath = safePath(DATA_DIR, req.body.oldPath);
  const newPath = safePath(DATA_DIR, req.body.newPath);
  if (!oldPath || !newPath) return res.status(400).json({ error: "Invalid path" });
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: "Not found" });
  if (fs.existsSync(newPath)) return res.status(409).json({ error: "Target already exists" });
  try {
    fs.renameSync(oldPath, newPath);
    res.json({ message: `Renamed to ${path.basename(newPath)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file or folder
app.delete("/api/files", (req, res) => {
  const filePath = safePath(DATA_DIR, req.query.path);
  if (!filePath || filePath === path.resolve(DATA_DIR)) return res.status(400).json({ error: "Invalid path" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  const stats = fs.statSync(filePath);
  if (stats.isDirectory()) {
    fs.rmSync(filePath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(filePath);
  }
  res.json({ message: `Deleted ${path.basename(filePath)}` });
});

// Upload files
app.post("/api/files/upload", fileUpload.array("file", 20), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
  res.json({ message: `Uploaded ${req.files.length} file(s)` });
});

app.listen(PORT, () => {
  console.log(`Mod Manager running at http://localhost:${PORT}`);
});
