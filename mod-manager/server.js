const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { status: mcStatus } = require("minecraft-server-util");

const app = express();
const PORT = 3000;
const MODS_DIR = process.env.MODS_DIR || path.resolve(__dirname, "../mods");
const MC_HOST = process.env.MC_HOST || "mc";
const MC_PORT = parseInt(process.env.MC_PORT || "25565");

// Ensure mods directory exists
if (!fs.existsSync(MODS_DIR)) {
  fs.mkdirSync(MODS_DIR, { recursive: true });
}

// Multer config for uploading .jar files
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MODS_DIR),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === ".jar") {
      cb(null, true);
    } else {
      cb(new Error("Only .jar files are allowed"));
    }
  },
});

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Server status
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

// List all mods
app.get("/api/mods", (req, res) => {
  const files = fs.readdirSync(MODS_DIR);
  const mods = files
    .filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled"))
    .map((f) => {
      const stats = fs.statSync(path.join(MODS_DIR, f));
      return {
        name: f,
        size: stats.size,
        enabled: f.endsWith(".jar"),
        modified: stats.mtime,
      };
    });
  res.json(mods);
});

// Upload a mod
app.post("/api/mods", upload.single("mod"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ message: `Uploaded ${req.file.originalname}` });
});

// Delete a mod
app.delete("/api/mods/:name", (req, res) => {
  const filePath = path.join(MODS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  fs.unlinkSync(filePath);
  res.json({ message: `Deleted ${req.params.name}` });
});

// Toggle enable/disable a mod
app.patch("/api/mods/:name/toggle", (req, res) => {
  const name = req.params.name;
  const filePath = path.join(MODS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });

  let newName;
  if (name.endsWith(".jar.disabled")) {
    newName = name.replace(".jar.disabled", ".jar");
  } else if (name.endsWith(".jar")) {
    newName = name + ".disabled";
  } else {
    return res.status(400).json({ error: "Not a mod file" });
  }

  fs.renameSync(filePath, path.join(MODS_DIR, newName));
  res.json({ message: `Renamed to ${newName}` });
});

app.listen(PORT, () => {
  console.log(`Mod Manager running at http://localhost:${PORT}`);
});
