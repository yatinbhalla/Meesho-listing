import multer from 'multer';
import path from 'path';
import fs from 'fs';

// WHY: We use diskStorage (not memoryStorage) so large images are written straight
// to disk and never pile up in Node's heap. The destination is determined at
// request time because each path has its own shared_images/ subfolder.
export function createUpload(destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, destDir),
    filename: (_req, file, cb) => cb(null, file.originalname),
  });

  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max per image
    fileFilter: (_req, file, cb) => {
      const allowed = /jpeg|jpg|png|webp/;
      if (allowed.test(path.extname(file.originalname).toLowerCase())) {
        cb(null, true);
      } else {
        cb(new Error('Only JPG, PNG, and WebP images are allowed.'));
      }
    },
  });
}
