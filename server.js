import express from "express";
import path from "path";
import multer from "multer";
import https from "https";
import { fileURLToPath } from "url";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import archiver from "archiver";
import QRCode from "qrcode";
import "dotenv/config";
import { connectDB } from "./db.js";
import Event from "./models/Event.js";

// --------------------------
// Railway Bucket (S3-compatible) configuration
// --------------------------
const s3 = new S3Client({
  region: process.env.AWS_REGION || "auto",
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  requestHandler: new NodeHttpHandler({
    httpsAgent: new https.Agent({ maxSockets: 500, keepAlive: true }),
  }),
});

const BUCKET_NAME = process.env.BUCKET_NAME;

// --------------------------
// __dirname replacement in ESM
// --------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------
// Basic setup
// --------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-password, x-superadmin-password");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// --------------------------
// Admin auth middleware
// --------------------------
const checkAdmin = async (req, res, next) => {
  const password = req.headers["x-admin-password"];
  if (!password) return res.status(401).json({ error: "Unauthorized" });
  if (password === process.env.ADMIN_PASSWORD) return next();
  // Check per-event password
  const eventId = req.query.eventId?.trim() || req.body?.eventId?.trim();
  if (eventId) {
    const event = await Event.findOne({ event_id: eventId }).select("admin_password");
    if (event?.admin_password && password === event.admin_password) return next();
  }
  res.status(401).json({ error: "Unauthorized" });
};

const checkSuperadmin = (req, res, next) => {
  const password = req.headers["x-superadmin-password"];
  if (password && password === process.env.SUPERADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
};

// --------------------------
// /health endpoint (health check)
// --------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --------------------------
// /api/event endpoint
// --------------------------
app.get("/api/event", async (_req, res) => {
  try {
    const event = await Event.findOne({ is_active: true });
    if (!event) return res.status(404).json({ ok: false, error: "No active event" });
    res.json({ eventId: event.event_id });
  } catch (err) {
    console.error("Error in GET /api/event:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/event/config endpoint (no auth required)
// --------------------------
app.get("/api/event/config", async (_req, res) => {
  try {
    const event = await Event.findOne({ is_active: true });
    if (!event) return res.status(404).json({ ok: false, error: "No active event found" });
    res.json(event);
  } catch (err) {
    console.error("Error fetching event config:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/event/:eventId/config endpoint (no auth required, fetch any event by ID)
// --------------------------
app.get("/api/event/:eventId/config", async (req, res) => {
  try {
    const event = await Event.findOne({ event_id: req.params.eventId });
    if (!event || !event.is_active) return res.status(404).json({ ok: false, error: "Event not found" });
    res.json(event);
  } catch (err) {
    console.error("Error fetching event config by ID:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/events CRUD endpoints
// --------------------------
app.get("/api/superadmin/events", checkSuperadmin, async (_req, res) => {
  try {
    const events = await Event.find().sort({ created_at: -1 });
    res.json({ ok: true, events });
  } catch (err) {
    console.error("Error in GET /api/superadmin/events:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/superadmin/events", checkSuperadmin, async (req, res) => {
  try {
    const existing = await Event.findOne({ event_id: req.body.event_id });
    if (existing) return res.status(409).json({ ok: false, error: "event_id already exists" });
    const event = await Event.create(req.body);
    res.json({ ok: true, event });
  } catch (err) {
    console.error("Error in POST /api/superadmin/events:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/superadmin/events/:eventId", checkSuperadmin, async (req, res) => {
  try {
    const event = await Event.findOneAndUpdate(
      { event_id: req.params.eventId },
      { ...req.body, updated_at: new Date() },
      { new: true }
    );
    if (!event) return res.status(404).json({ ok: false, error: "Event not found" });
    res.json({ ok: true, event });
  } catch (err) {
    console.error("Error in PUT /api/superadmin/events/:eventId:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/superadmin/events/:eventId/activate", checkSuperadmin, async (req, res) => {
  try {
    const event = await Event.findOneAndUpdate(
      { event_id: req.params.eventId },
      { is_active: true, updated_at: new Date() },
      { new: true }
    );
    if (!event) return res.status(404).json({ ok: false, error: "Event not found" });
    res.json({ ok: true, event_id: event.event_id });
  } catch (err) {
    console.error("Error in POST /api/superadmin/events/:eventId/activate:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/superadmin/events/:eventId", checkSuperadmin, async (req, res) => {
  try {
    const result = await Event.deleteOne({ event_id: req.params.eventId });
    if (result.deletedCount === 0) return res.status(404).json({ ok: false, error: "Event not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in DELETE /api/superadmin/events/:eventId:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// Multer setup (in-memory)
// --------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB per file
  },
});

// Helper: get file extension from mimetype
function extFromMime(mimetype) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
  };
  return map[mimetype] || ".bin";
}

// Helper: upload buffer to S3
async function uploadToS3(buffer, key, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
}

// Helper: generate a presigned GET URL (7-day max)
async function presignedUrl(key) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), {
    expiresIn: 604800, // 7 days
  });
}

// Helper: run async mapper with bounded concurrency to avoid socket exhaustion
async function batchMap(items, fn, concurrency = 20) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    results.push(...await Promise.all(items.slice(i, i + concurrency).map(fn)));
  }
  return results;
}

// --------------------------
// /api/save endpoint
// --------------------------
const MAX_RAW_PHOTOS = 10;
const cpUpload = upload.fields([
  ...Array.from({ length: MAX_RAW_PHOTOS }, (_, i) => ({ name: `raw${i + 1}`, maxCount: 1 })),
  { name: "collage", maxCount: 1 },
]);

app.post("/api/save", cpUpload, async (req, res) => {
  try {
    const files = req.files || {};

    let eventId = req.body.eventId?.trim();
    if (!eventId) {
      const activeEvent = await Event.findOne({ is_active: true });
      if (!activeEvent) return res.status(404).json({ ok: false, error: "No active event" });
      eventId = activeEvent.event_id;
    }
    const rawClientId = req.body.sessionId?.trim() ?? "";
    const sessionId = /^[A-Za-z0-9_-]{1,64}$/.test(rawClientId)
      ? rawClientId
      : Date.now().toString();

    // 1) Upload raw photos
    const uploadPromises = [];

    for (let i = 0; i < MAX_RAW_PHOTOS; i++) {
      const fileArr = files[`raw${i + 1}`];
      if (!fileArr || fileArr.length === 0) continue;

      const file = fileArr[0];
      const ext = extFromMime(file.mimetype);
      const key = `${eventId}/raw/session_${sessionId}_raw${i + 1}${ext}`;
      uploadPromises.push(uploadToS3(file.buffer, key, file.mimetype));
    }

    // 2) Upload collage
    const collageArr = files["collage"];
    if (!collageArr || collageArr.length === 0) {
      console.error("No collage file received");
      return res.status(400).send("No collage file received");
    }

    const collageFile = collageArr[0];
    const collageExt = extFromMime(collageFile.mimetype);
    const collageKey = `${eventId}/collage/${sessionId}${collageExt}`;

    await Promise.all([
      uploadToS3(collageFile.buffer, collageKey, collageFile.mimetype),
      ...uploadPromises,
    ]);

    // 3) Generate presigned URL for collage (for QR code, valid 7 days)
    const collageUrl = await presignedUrl(collageKey);

    // 4) Generate QR code from collage URL
    const qrCodeDataUrl = await QRCode.toDataURL(collageUrl);

    console.log("Uploaded collage:", collageKey);

    // 5) Respond JSON
    res.json({
      ok: true,
      sessionId,
      collageUrl,
      qrCode: qrCodeDataUrl,
    });
  } catch (err) {
    console.error("Error in /api/save:", err);
    res.status(500).send("Server error while saving files");
  }
});

// --------------------------
// /api/admin/photos endpoint (list all photos)
// --------------------------
app.get("/api/admin/photos", checkAdmin, async (req, res) => {
  try {
    let eventId = req.query.eventId?.trim();
    if (!eventId) {
      const activeEvent = await Event.findOne({ is_active: true });
      if (!activeEvent) return res.status(404).json({ ok: false, error: "No active event" });
      eventId = activeEvent.event_id;
    }
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: `${eventId}/`, MaxKeys: 500 })
    );

    const photos = await batchMap(
      response.Contents || [],
      async (obj) => {
        const url = await presignedUrl(obj.Key);
        const parts = obj.Key.split("/");
        return {
          id: obj.Key,
          url,
          uploadedAt: obj.LastModified,
          folder: parts.length > 2 ? parts[1] : "root",
        };
      }
    );

    res.json({ ok: true, photos, total: photos.length });
  } catch (err) {
    console.error("Error fetching photos:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/session/:sessionId/status  (no auth — public)
// --------------------------
app.get("/api/session/:sessionId/status", async (req, res) => {
  const { sessionId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });
  }
  try {
    // Build ordered list of event IDs to check: hinted one first, then all others
    const hintedId = req.query.eventId?.trim();
    const allEvents = await Event.find().select("event_id").lean();
    const allIds = allEvents.map(e => e.event_id);

    const checkOrder = hintedId && /^[A-Za-z0-9_.-]{1,64}$/.test(hintedId)
      ? [hintedId, ...allIds.filter(id => id !== hintedId)]
      : allIds;

    for (const eventId of checkOrder) {
      const prefix = `${eventId}/collage/${sessionId}`;
      const listRes = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        MaxKeys: 1,
      }));
      const match = listRes.Contents?.[0];
      console.log(`[status] prefix=${prefix} found=${match?.Key ?? "none"}`);
      if (match) {
        const url = await presignedUrl(match.Key);
        return res.json({ ready: true, url });
      }
    }

    res.json({ ready: false });
  } catch (err) {
    console.error("Error in /api/session/:sessionId/status:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /p/:sessionId  — guest landing page
// --------------------------
app.get("/p/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    return res.status(400).send("Invalid session ID");
  }
  const rawEventId = req.query.eventId?.trim() ?? "";
  const eventId = /^[A-Za-z0-9_.-]{1,64}$/.test(rawEventId) ? rawEventId : "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Photo</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#111;color:#f0ead8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
  .card{text-align:center;max-width:480px;width:100%}
  img{max-width:100%;border-radius:8px;margin-bottom:16px}
  p{font-size:14px;opacity:.7;margin-bottom:12px}
  a.btn{display:inline-block;padding:10px 24px;background:#c8703a;color:#fff;border-radius:6px;text-decoration:none;font-size:14px}
  .spin{font-size:32px;animation:spin 1s linear infinite;display:inline-block;margin-bottom:12px}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card" id="app">
  <div class="spin">⏳</div>
  <p id="msg">Your photo is on its way…</p>
</div>
<script>
(function(){
  var sessionId = ${JSON.stringify(sessionId)};
  var eventId = ${JSON.stringify(eventId)};
  function check(){
    var url = '/api/session/'+sessionId+'/status'+(eventId ? '?eventId='+encodeURIComponent(eventId) : '');
    fetch(url)
      .then(function(r){return r.json()})
      .then(function(d){
        if(d.ready && d.url){
          var app=document.getElementById('app');
          var img=document.createElement('img');
          img.alt='Your photo';
          img.src=d.url;
          img.onerror=function(){
            app.innerHTML='<p>Photo ready but failed to load. <a href="'+d.url+'">Try opening directly</a>.</p>';
          };
          var btn=document.createElement('a');
          btn.className='btn';
          btn.href=d.url;
          btn.download='photo.jpg';
          btn.textContent='Download';
          app.innerHTML='';
          app.appendChild(img);
          app.appendChild(document.createElement('br'));
          app.appendChild(btn);
        } else {
          setTimeout(check,5000);
        }
      })
      .catch(function(){setTimeout(check,5000)});
  }
  check();
})();
</script>
</body>
</html>`);
});

// --------------------------
// /api/public/photos endpoint (list collage URLs, no auth)
// --------------------------
app.get("/api/public/photos", async (req, res) => {
  try {
    let eventId = req.query.eventId?.trim();
    if (!eventId) {
      const activeEvent = await Event.findOne({ is_active: true });
      if (!activeEvent) return res.status(404).json({ ok: false, error: "No active event" });
      eventId = activeEvent.event_id;
    }
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: `${eventId}/collage/`,
        MaxKeys: 1000,
      })
    );
    const photos = await batchMap(
      response.Contents || [],
      async (obj) => ({
        id: obj.Key,
        url: await presignedUrl(obj.Key),
        uploadedAt: obj.LastModified,
      })
    );
    res.json({ ok: true, eventId, total: photos.length, photos });
  } catch (err) {
    console.error("Error fetching public photos:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/admin/download-zip endpoint (download all photos as zip)
// --------------------------
app.get("/api/admin/download-zip", checkAdmin, async (req, res) => {
  try {
    let eventId = req.query.eventId?.trim();
    if (!eventId) {
      const activeEvent = await Event.findOne({ is_active: true });
      if (!activeEvent) return res.status(404).json({ ok: false, error: "No active event" });
      eventId = activeEvent.event_id;
    }
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: `${eventId}/`, MaxKeys: 500 })
    );

    const archive = archiver("zip", { zlib: { level: 9 } });

    res.attachment("photos.zip");
    archive.pipe(res);

    for (const obj of response.Contents || []) {
      const filename = obj.Key.split("/").pop();
      const s3Response = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key })
      );
      archive.append(s3Response.Body, { name: filename });
    }

    await archive.finalize();
  } catch (err) {
    console.error("Error creating zip:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/admin/download-selected endpoint (download selected photos)
// --------------------------
app.post("/api/admin/download-selected", checkAdmin, async (req, res) => {
  try {
    const { photoIds } = req.body;

    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid photoIds array" });
    }

    const archive = archiver("zip", { zlib: { level: 9 } });

    res.attachment("selected-photos.zip");
    archive.pipe(res);

    for (const key of photoIds) {
      try {
        const filename = key.split("/").pop();
        const s3Response = await s3.send(
          new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
        );
        archive.append(s3Response.Body, { name: filename });
      } catch (err) {
        console.warn(`Failed to download ${key}:`, err.message);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("Error creating selected zip:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// Helper: build tree from S3 object list
// --------------------------
function buildTree(objects) {
  const root = { name: "/", type: "folder", children: [] };

  for (const obj of objects) {
    const parts = obj.Key.split("/").filter(Boolean);
    let node = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (isFile) {
        node.children.push({
          name: part,
          type: "file",
          size: obj.Size,
          lastModified: obj.LastModified,
        });
      } else {
        let folder = node.children.find((c) => c.name === part && c.type === "folder");
        if (!folder) {
          folder = { name: part, type: "folder", children: [] };
          node.children.push(folder);
        }
        node = folder;
      }
    }
  }

  return root;
}

// --------------------------
// /api/superadmin/tree endpoint
// --------------------------
app.get("/api/superadmin/tree", checkSuperadmin, async (_req, res) => {
  try {
    const allObjects = [];
    let continuationToken;

    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET_NAME,
          ContinuationToken: continuationToken,
        })
      );
      allObjects.push(...(response.Contents || []));
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    res.json({ ok: true, tree: buildTree(allObjects) });
  } catch (err) {
    console.error("Error in /api/superadmin/tree:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/photos endpoint
// --------------------------
app.get("/api/superadmin/photos", checkSuperadmin, async (req, res) => {
  try {
    const prefix = req.query.prefix || "";
    const allObjects = [];
    let continuationToken;

    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET_NAME,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      allObjects.push(...(response.Contents || []));
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    const files = await batchMap(
      allObjects,
      async (obj) => ({
        key: obj.Key,
        url: await presignedUrl(obj.Key),
        size: obj.Size,
        lastModified: obj.LastModified,
      })
    );

    res.json({ ok: true, files });
  } catch (err) {
    console.error("Error in /api/superadmin/photos:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/file endpoint (delete single file)
// --------------------------
app.delete("/api/superadmin/file", checkSuperadmin, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ ok: false, error: "Missing key" });

    // Check existence first
    const listResponse = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: key, MaxKeys: 1 })
    );
    const exists = (listResponse.Contents || []).some((obj) => obj.Key === key);
    if (!exists) return res.status(404).json({ ok: false, error: "File not found" });

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    res.json({ ok: true, deleted: key });
  } catch (err) {
    console.error("Error in DELETE /api/superadmin/file:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/folder endpoint (delete all files under prefix)
// --------------------------
app.delete("/api/superadmin/folder", checkSuperadmin, async (req, res) => {
  try {
    const { prefix } = req.body;
    if (!prefix || prefix === "/") {
      return res.status(400).json({ ok: false, error: "Invalid or empty prefix" });
    }

    const allKeys = [];
    let continuationToken;

    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET_NAME,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      allKeys.push(...(response.Contents || []).map((obj) => ({ Key: obj.Key })));
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    if (allKeys.length === 0) return res.json({ ok: true, deletedCount: 0 });

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: allKeys },
      })
    );

    res.json({ ok: true, deletedCount: allKeys.length });
  } catch (err) {
    console.error("Error in DELETE /api/superadmin/folder:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/download-zip endpoint (download all or prefix as zip)
// --------------------------
app.get("/api/superadmin/download-zip", checkSuperadmin, async (req, res) => {
  try {
    const prefix = req.query.prefix || "";
    const allObjects = [];
    let continuationToken;

    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET_NAME,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      allObjects.push(...(response.Contents || []));
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment("download.zip");
    archive.pipe(res);

    for (const obj of allObjects) {
      const s3Response = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key })
      );
      archive.append(s3Response.Body, { name: obj.Key });
    }

    await archive.finalize();
  } catch (err) {
    console.error("Error in /api/superadmin/download-zip:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/download-selected endpoint (download selected files as zip)
// --------------------------
app.post("/api/superadmin/download-selected", checkSuperadmin, async (req, res) => {
  try {
    const { keys } = req.body;
    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid keys array" });
    }

    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment("selected.zip");
    archive.pipe(res);

    for (const key of keys) {
      try {
        const s3Response = await s3.send(
          new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
        );
        archive.append(s3Response.Body, { name: key });
      } catch (err) {
        console.warn(`Skipping ${key}:`, err.message);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("Error in /api/superadmin/download-selected:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/move endpoint (move/rename a file)
// --------------------------
app.post("/api/superadmin/move", checkSuperadmin, async (req, res) => {
  try {
    const { sourceKey, destKey } = req.body;
    if (!sourceKey || !destKey) {
      return res.status(400).json({ ok: false, error: "Missing sourceKey or destKey" });
    }
    if (sourceKey === destKey) {
      return res.status(400).json({ ok: false, error: "Source and destination are the same" });
    }

    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET_NAME,
        CopySource: `${BUCKET_NAME}/${sourceKey}`,
        Key: destKey,
      })
    );

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: sourceKey }));

    res.json({ ok: true, moved: { from: sourceKey, to: destKey } });
  } catch (err) {
    console.error("Error in /api/superadmin/move:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/upload-wallpaper endpoint
// --------------------------
app.post("/api/superadmin/upload-wallpaper", checkSuperadmin, upload.single("wallpaper"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const ext = extFromMime(req.file.mimetype);
    const name = `wallpaper_${Date.now()}${ext}`;
    const key = `wallpapers/${name}`;
    await uploadToS3(req.file.buffer, key, req.file.mimetype);
    const url = await presignedUrl(key);
    res.json({ ok: true, key, url });
  } catch (err) {
    console.error("Error in /api/superadmin/upload-wallpaper:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// Global error handler
// --------------------------
app.use((err, req, res, _next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  res.status(500).json({ ok: false, error: err.message });
});

// --------------------------
// Start server
// --------------------------
(async () => {
  await connectDB();

  const anyEvent = await Event.findOne();
  if (!anyEvent) {
    await Event.create({
      event_id: "test",
      event_name: "test server",
      templates: [
        { file: "templates/test/blank.png", width: 1080, height: 1920, slots: [{ x: 100, y: 100 }, { x: 100, y: 639 }, { x: 100, y: 1178 }] },
      ],
      capture: { totalShots: 3, photoWidth: 880, photoHeight: 495 },
      countdown: { seconds: 3, stepMs: 500 },
      gestureTrigger: { enabled: false, gestureType: "peace", holdDuration: 1000, detectionFps: 10 },
      qr: { size: 300, margin: 1 },
      is_active: true,
    });
    console.log('Seeded default "test" event');
  }

  app.listen(PORT, () => {
    console.log(`Photobooth server listening on http://localhost:${PORT}`);
  });
})();
