import { openSync, readSync, closeSync } from "node:fs";
import { Buffer } from "node:buffer";
import { imageBytes, MAX_IMAGE_BYTES, type ImageData } from "./images.ts";

/** Capture the file in the provider/client environment, never resolve its path on the daemon. */
export const readImageFile = (path: string): ImageData => {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, size);
      if (n === 0) break;
      size += n;
    }
    if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds 2 MiB");
    let mimeType: ImageData["mimeType"] = "image/gif";
    if (bytes[0] === 137) mimeType = "image/png";
    else if (bytes[0] === 255) mimeType = "image/jpeg";
    const image: ImageData = { mimeType, data: bytes.subarray(0, size).toString("base64") };
    imageBytes(image);
    return image;
  } finally {
    closeSync(fd);
  }
};
