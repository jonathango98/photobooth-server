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
import { logger, requestLogger } from "./logger.js";

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
app.use(requestLogger);

// --------------------------
// Admin auth middleware
// --------------------------
const checkAdmin = async (req, res, next) => {
  const password = req.headers["x-admin-password"];
  if (!password) {
    req.log.warn("Admin auth rejected: no password header");
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (password === process.env.ADMIN_PASSWORD) return next();
  // Check per-event password
  const eventId = req.query.eventId?.trim() || req.body?.eventId?.trim();
  if (eventId) {
    const event = await Event.findOne({ event_id: eventId }).select("admin_password");
    if (event?.admin_password && password === event.admin_password) return next();
  }
  req.log.warn("Admin auth rejected: wrong password", { eventId });
  res.status(401).json({ error: "Unauthorized" });
};

const checkSuperadmin = (req, res, next) => {
  const password = req.headers["x-superadmin-password"];
  if (password && password === process.env.SUPERADMIN_PASSWORD) {
    next();
  } else {
    req.log.warn("Superadmin auth rejected");
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
app.get("/api/event", async (req, res) => {
  try {
    const event = await Event.findOne({ is_active: true });
    if (!event) return res.status(404).json({ ok: false, error: "No active event" });
    res.json({ eventId: event.event_id });
  } catch (err) {
    req.log.error("Failed to get active event", { err });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/event/config endpoint (no auth required)
// --------------------------
app.get("/api/event/config", async (req, res) => {
  try {
    const event = await Event.findOne({ is_active: true });
    if (!event) return res.status(404).json({ ok: false, error: "No active event found" });
    res.json(event);
  } catch (err) {
    req.log.error("Failed to fetch active event config", { err });
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
    req.log.error("Failed to fetch event config", { eventId: req.params.eventId, err });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/superadmin/events CRUD endpoints
// --------------------------
app.get("/api/superadmin/events", checkSuperadmin, async (req, res) => {
  try {
    const events = await Event.find().sort({ created_at: -1 });
    req.log.debug("Listed events", { count: events.length });
    res.json({ ok: true, events });
  } catch (err) {
    req.log.error("Failed to list events", { err });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/superadmin/events", checkSuperadmin, async (req, res) => {
  try {
    const existing = await Event.findOne({ event_id: req.body.event_id });
    if (existing) return res.status(409).json({ ok: false, error: "event_id already exists" });
    const event = await Event.create(req.body);
    req.log.info("Event created", { eventId: event.event_id });
    res.json({ ok: true, event });
  } catch (err) {
    req.log.error("Failed to create event", { eventId: req.body.event_id, err });
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
    req.log.info("Event updated", { eventId: req.params.eventId });
    res.json({ ok: true, event });
  } catch (err) {
    req.log.error("Failed to update event", { eventId: req.params.eventId, err });
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
    req.log.info("Event activated", { eventId: event.event_id });
    res.json({ ok: true, event_id: event.event_id });
  } catch (err) {
    req.log.error("Failed to activate event", { eventId: req.params.eventId, err });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/superadmin/events/:eventId", checkSuperadmin, async (req, res) => {
  try {
    const result = await Event.deleteOne({ event_id: req.params.eventId });
    if (result.deletedCount === 0) return res.status(404).json({ ok: false, error: "Event not found" });
    req.log.info("Event deleted", { eventId: req.params.eventId });
    res.json({ ok: true });
  } catch (err) {
    req.log.error("Failed to delete event", { eventId: req.params.eventId, err });
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

    const log = req.log.child({ sessionId, eventId });
    log.info("Save request received");

    // 1) Upload raw photos
    const uploadPromises = [];
    const rawKeys = [];

    for (let i = 0; i < MAX_RAW_PHOTOS; i++) {
      const fileArr = files[`raw${i + 1}`];
      if (!fileArr || fileArr.length === 0) continue;

      const file = fileArr[0];
      const ext = extFromMime(file.mimetype);
      const key = `${eventId}/raw/session_${sessionId}_raw${i + 1}${ext}`;
      rawKeys.push(key);
      log.debug(`Queuing raw photo upload`, { slot: i + 1, key, bytes: file.buffer.length });
      uploadPromises.push(uploadToS3(file.buffer, key, file.mimetype));
    }

    // 2) Upload collage
    const collageArr = files["collage"];
    if (!collageArr || collageArr.length === 0) {
      log.warn("No collage file in request");
      return res.status(400).send("No collage file received");
    }

    const collageFile = collageArr[0];
    const collageExt = extFromMime(collageFile.mimetype);
    const collageKey = `${eventId}/collage/${sessionId}${collageExt}`;

    log.debug("Uploading collage + raw photos", { collageKey, rawCount: rawKeys.length, bytes: collageFile.buffer.length });

    await Promise.all([
      uploadToS3(collageFile.buffer, collageKey, collageFile.mimetype),
      ...uploadPromises,
    ]);

    // 3) Generate presigned URL for collage (for QR code, valid 7 days)
    const collageUrl = await presignedUrl(collageKey);

    // 4) Generate QR code from collage URL
    const qrCodeDataUrl = await QRCode.toDataURL(collageUrl);

    log.info("Session saved", { collageKey, rawCount: rawKeys.length });

    // 5) Respond JSON
    res.json({
      ok: true,
      sessionId,
      collageUrl,
      qrCode: qrCodeDataUrl,
    });
  } catch (err) {
    req.log.error("Failed to save session", { err });
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
    req.log.debug("Listing admin photos", { eventId });
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

    req.log.debug("Admin photos listed", { eventId, total: photos.length });
    res.json({ ok: true, photos, total: photos.length });
  } catch (err) {
    req.log.error("Failed to list admin photos", { err });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/session/:sessionId/status  (no auth — public)
// --------------------------
app.get("/api/session/:sessionId/status", async (req, res) => {
  const { sessionId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    req.log.warn("Status check: invalid sessionId", { sessionId });
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

    req.log.debug("Status check", { sessionId, hintedEventId: hintedId, checking: checkOrder.length });

    for (const eventId of checkOrder) {
      const prefix = `${eventId}/collage/${sessionId}`;
      const listRes = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        MaxKeys: 1,
      }));
      const match = listRes.Contents?.[0];
      if (match) {
        req.log.info("Session ready", { sessionId, key: match.Key });
        const url = await presignedUrl(match.Key);
        return res.json({ ready: true, url });
      }
    }

    req.log.debug("Session not ready yet", { sessionId });
    res.json({ ready: false });
  } catch (err) {
    req.log.error("Failed to check session status", { sessionId, err });
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
    req.log.debug("Listing public photos", { eventId });
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
    req.log.debug("Public photos listed", { eventId, total: photos.length });
    res.json({ ok: true, eventId, total: photos.length, photos });
  } catch (err) {
    req.log.error("Failed to list public photos", { err });
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

    const fileCount = (response.Contents || []).length;
    req.log.info("Starting zip download", { eventId, fileCount });

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
    req.log.info("Zip download complete", { eventId, fileCount });
  } catch (err) {
    req.log.error("Failed to create zip", { err });
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

    req.log.info("Starting selected zip download", { count: photoIds.length });
    const archive = archiver("zip", { zlib: { level: 9 } });

    res.attachment("selected-photos.zip");
    archive.pipe(res);

    let skipped = 0;
    for (const key of photoIds) {
      try {
        const filename = key.split("/").pop();
        const s3Response = await s3.send(
          new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
        );
        archive.append(s3Response.Body, { name: filename });
      } catch (err) {
        skipped++;
        req.log.warn("Skipping file in selected zip", { key, err: err.message });
      }
    }

    await archive.finalize();
    req.log.info("Selected zip complete", { requested: photoIds.length, skipped });
  } catch (err) {
    req.log.error("Failed to create selected zip", { err });
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
app.get("/api/superadmin/tree", checkSuperadmin, async (req, res) => {
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

    req.log.debug("Tree fetched", { totalObjects: allObjects.length });
    res.json({ ok: true, tree: buildTree(allObjects) });
  } catch (err) {
    req.log.error("Failed to build tree", { err });
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

    req.log.debug("Superadmin photos listed", { prefix: prefix || "(all)", total: files.length });
    res.json({ ok: true, files });
  } catch (err) {
    req.log.error("Failed to list superadmin photos", { err });
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
    req.log.info("File deleted", { key });
    res.json({ ok: true, deleted: key });
  } catch (err) {
    req.log.error("Failed to delete file", { key: req.body?.key, err });
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

    if (allKeys.length === 0) {
      req.log.warn("Folder delete: no files found", { prefix });
      return res.json({ ok: true, deletedCount: 0 });
    }

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: allKeys },
      })
    );

    req.log.info("Folder deleted", { prefix, deletedCount: allKeys.length });
    res.json({ ok: true, deletedCount: allKeys.length });
  } catch (err) {
    req.log.error("Failed to delete folder", { prefix: req.body?.prefix, err });
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

    req.log.info("Starting superadmin zip download", { prefix: prefix || "(all)", fileCount: allObjects.length });
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
    req.log.info("Superadmin zip complete", { prefix: prefix || "(all)", fileCount: allObjects.length });
  } catch (err) {
    req.log.error("Failed to create superadmin zip", { err });
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

    req.log.info("Starting superadmin selected zip", { count: keys.length });
    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment("selected.zip");
    archive.pipe(res);

    let skipped = 0;
    for (const key of keys) {
      try {
        const s3Response = await s3.send(
          new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
        );
        archive.append(s3Response.Body, { name: key });
      } catch (err) {
        skipped++;
        req.log.warn("Skipping file in selected zip", { key, err: err.message });
      }
    }

    await archive.finalize();
    req.log.info("Superadmin selected zip complete", { requested: keys.length, skipped });
  } catch (err) {
    req.log.error("Failed to create superadmin selected zip", { err });
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

    req.log.info("Moving file", { from: sourceKey, to: destKey });
    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET_NAME,
        CopySource: `${BUCKET_NAME}/${sourceKey}`,
        Key: destKey,
      })
    );

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: sourceKey }));

    req.log.info("File moved", { from: sourceKey, to: destKey });
    res.json({ ok: true, moved: { from: sourceKey, to: destKey } });
  } catch (err) {
    req.log.error("Failed to move file", { from: req.body?.sourceKey, to: req.body?.destKey, err });
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
    req.log.info("Uploading wallpaper", { key, bytes: req.file.buffer.length });
    await uploadToS3(req.file.buffer, key, req.file.mimetype);
    const url = await presignedUrl(key);
    req.log.info("Wallpaper uploaded", { key });
    res.json({ ok: true, key, url });
  } catch (err) {
    req.log.error("Failed to upload wallpaper", { err });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// Global error handler
// --------------------------
app.use((err, req, res, _next) => {
  req.log.error("Unhandled error", { err });
  res.status(500).json({ ok: false, error: err.message });
});

// --------------------------
// Start server
// --------------------------
(async () => {
  logger.info("Starting photobooth server", {
    port: PORT,
    nodeEnv: process.env.NODE_ENV || "development",
    logLevel: process.env.LOG_LEVEL || "default",
    bucket: BUCKET_NAME,
    mongoUrl: process.env.MONGO_URL ? "(set)" : "(missing)",
    s3Endpoint: process.env.AWS_ENDPOINT_URL_S3 ? "(set)" : "(missing)",
  });

  await connectDB();
  logger.info("MongoDB connected");

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
    logger.info('Seeded default "test" event');
  }

  app.listen(PORT, () => {
    logger.info(`Server listening on http://localhost:${PORT}`);
  });
})();
