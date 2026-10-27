import { z } from "zod";
import { Buffer } from "node:buffer";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGE_IMAGES = 4;
export const imageMimeSchema = z.enum(["image/png", "image/jpeg", "image/gif"]);
export const imageDataSchema = z.object({
  mimeType: imageMimeSchema,
  data: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
});
export type ImageData = z.infer<typeof imageDataSchema>;
export const imageAttachmentSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z
    .string()
    .min(1)
    .max(160)
    .refine(
      (name) =>
        [...name].every(
          (ch) => ch.charCodeAt(0) >= 32 && (ch.charCodeAt(0) < 127 || ch.charCodeAt(0) > 159),
        ),
      "Image names cannot contain terminal controls",
    ),
  mimeType: imageMimeSchema,
  bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
});
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export const imageAttachmentsSchema = z.array(imageAttachmentSchema).max(MAX_MESSAGE_IMAGES);

/** Check bytes, format and allocation size before storing or decoding a raster. */
export const imageBytes = (image: ImageData): Buffer => {
  imageDataSchema.parse(image);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data))
    throw new Error("Invalid image base64");
  const bytes = Buffer.from(image.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 2 MiB");
  let width = 0,
    height = 0;
  if (
    image.mimeType === "image/png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (
    image.mimeType === "image/gif" &&
    bytes.length >= 10 &&
    /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))
  ) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (image.mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    for (let off = 2; off + 4 < bytes.length;) {
      if (bytes[off++] !== 255) break;
      while (bytes[off] === 255) off++;
      const marker = bytes[off++];
      if (marker === undefined || marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (off + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(off);
      if (length < 2 || off + length > bytes.length) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 7
      ) {
        height = bytes.readUInt16BE(off + 3);
        width = bytes.readUInt16BE(off + 5);
        break;
      }
      off += length;
    }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 16_000_000)
    throw new Error("Invalid image or image exceeds 16 megapixels");
  return bytes;
};

export const imageDataUrl = (image: ImageData): string =>
  `data:${image.mimeType};base64,${image.data}`;

/** Extract explicit provider/MCP content blocks; never fetch URLs or open paths. */
export const splitImageContent = (output: unknown): { output: unknown; images: ImageData[] } => {
  const images: ImageData[] = [];
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 8) return value;
    if (Array.isArray(value)) return value.map((x) => visit(x, depth + 1));
    if (!value || typeof value !== "object") return value;
    const o = value as Record<string, unknown>;
    if (["image", "input_image", "inputImage", "image_url"].includes(String(o.type))) {
      const source =
        o.source && typeof o.source === "object" ? (o.source as Record<string, unknown>) : o;
      const url = o.image_url ?? o.imageUrl ?? o.url;
      const rawUrl = typeof url === "object" && url ? (url as Record<string, unknown>).url : url;
      const match = typeof rawUrl === "string" ? /^data:([^;]+);base64,(.*)$/s.exec(rawUrl) : null;
      const parsed = imageDataSchema.safeParse(
        match
          ? { mimeType: match[1], data: match[2] }
          : { mimeType: source.mimeType ?? source.media_type, data: source.data },
      );
      if (parsed.success && images.length < MAX_MESSAGE_IMAGES) {
        try {
          imageBytes(parsed.data);
          images.push(parsed.data);
          return { type: "text", text: "[image]" };
        } catch {
          /* Keep a label when invalid or too large. */
        }
      }
      return { type: "text", text: "[image unavailable: unsupported format or size]" };
    }
    const copy = { ...o };
    for (const key of ["content", "contentItems"])
      if (Array.isArray(copy[key])) copy[key] = visit(copy[key], depth + 1);
    return copy;
  };
  return { output: visit(output, 0), images };
};
