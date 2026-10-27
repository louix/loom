import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { imageBytes, type ImageAttachment, type ImageData } from "@loom/core/images";
import type { Db } from "./db.ts";

/** Content-addressed, repository-local storage shared by uploads and tool results. */
export class ImageStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  put(image: ImageData, name = "image"): ImageAttachment {
    const bytes = imageBytes(image);
    const id = createHash("sha256").update(bytes).digest("hex");
    this.db
      .prepare("INSERT OR IGNORE INTO images (id, mime_type, data) VALUES (?, ?, ?)")
      .run(id, image.mimeType, bytes);
    // Names are display labels, never paths or terminal control sequences.
    // eslint-disable-next-line no-control-regex -- Strip terminal controls from display labels.
    const label = name.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160) || "image";
    return { id, mimeType: image.mimeType, bytes: bytes.length, name: label };
  }

  get(id: string): ImageData {
    const row = this.db.prepare("SELECT mime_type, data FROM images WHERE id = ?").get(id) as
      | { mime_type: ImageData["mimeType"]; data: Uint8Array }
      | undefined;
    if (!row) throw new Error("Image attachment is no longer available");
    return { mimeType: row.mime_type, data: Buffer.from(row.data).toString("base64") };
  }

  resolve(images: readonly ImageAttachment[] = []): ImageData[] {
    return images.map((image) => this.get(image.id));
  }
}
