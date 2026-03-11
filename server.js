import express from "express";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import archiver from "archiver";
import "dotenv/config";

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
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-password");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// --------------------------
// Admin auth middleware
// --------------------------
const checkAdmin = (req, res, next) => {
  const password = req.headers["x-admin-password"];
  if (password === process.env.ADMIN_PASSWORD) {
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

    const sessionId = Date.now().toString();

    // 1) Upload raw photos
    const uploadPromises = [];

    for (let i = 0; i < MAX_RAW_PHOTOS; i++) {
      const fileArr = files[`raw${i + 1}`];
      if (!fileArr || fileArr.length === 0) continue;

      const file = fileArr[0];
      const ext = extFromMime(file.mimetype);
      const key = `raw/session_${sessionId}_raw${i + 1}${ext}`;
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
    const collageKey = `collage/session_${sessionId}_collage${collageExt}`;

    await Promise.all([
      uploadToS3(collageFile.buffer, collageKey, collageFile.mimetype),
      ...uploadPromises,
    ]);

    // 3) Generate presigned URL for collage (for QR code, valid 7 days)
    const collageUrl = await presignedUrl(collageKey);

    console.log("Uploaded collage:", collageKey);

    // 4) Respond JSON
    res.json({
      ok: true,
      sessionId,
      collageUrl,
    });
  } catch (err) {
    console.error("Error in /api/save:", err);
    res.status(500).send("Server error while saving files");
  }
});

// --------------------------
// /api/admin/photos endpoint (list all photos)
// --------------------------
app.get("/api/admin/photos", checkAdmin, async (_req, res) => {
  try {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, MaxKeys: 500 })
    );

    const photos = await Promise.all(
      (response.Contents || []).map(async (obj) => {
        const url = await presignedUrl(obj.Key);
        const parts = obj.Key.split("/");
        return {
          id: obj.Key,
          url,
          uploadedAt: obj.LastModified,
          folder: parts.length > 1 ? parts[0] : "root",
        };
      })
    );

    res.json({ ok: true, photos, total: photos.length });
  } catch (err) {
    console.error("Error fetching photos:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------
// /api/admin/download-zip endpoint (download all photos as zip)
// --------------------------
app.get("/api/admin/download-zip", checkAdmin, async (_req, res) => {
  try {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, MaxKeys: 500 })
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
// Start server
// --------------------------
app.listen(PORT, () => {
  console.log(`Photobooth server listening on http://localhost:${PORT}`);
});
