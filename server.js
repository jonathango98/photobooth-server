import express from "express";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
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
const EVENT_ID = process.env.EVENT_ID || "default";

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
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-password, x-superadmin-password");
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
// Superadmin auth middleware
// --------------------------
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
app.get("/api/event", (_req, res) => {
  res.json({ eventId: EVENT_ID });
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
      const key = `${EVENT_ID}/raw/session_${sessionId}_raw${i + 1}${ext}`;
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
    const collageKey = `${EVENT_ID}/collage/session_${sessionId}_collage${collageExt}`;

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
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: `${EVENT_ID}/`, MaxKeys: 500 })
    );

    const photos = await Promise.all(
      (response.Contents || []).map(async (obj) => {
        const url = await presignedUrl(obj.Key);
        const parts = obj.Key.split("/");
        return {
          id: obj.Key,
          url,
          uploadedAt: obj.LastModified,
          folder: parts.length > 2 ? parts[1] : "root",
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
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: `${EVENT_ID}/`, MaxKeys: 500 })
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

    const files = await Promise.all(
      allObjects.map(async (obj) => ({
        key: obj.Key,
        url: await presignedUrl(obj.Key),
        size: obj.Size,
        lastModified: obj.LastModified,
      }))
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
// Start server
// --------------------------
app.listen(PORT, () => {
  console.log(`Photobooth server listening on http://localhost:${PORT}`);
});
