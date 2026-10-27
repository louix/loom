import type { ModelMessage } from "ai";
import type { ImageData } from "@loom/core/images";

export const userContent = (
  text: string,
  images?: readonly ImageData[],
): Extract<ModelMessage, { role: "user" }>["content"] =>
  images?.length
    ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...images.map((image) => ({
          type: "image" as const,
          image: image.data,
          mediaType: image.mimeType,
        })),
      ]
    : text;
