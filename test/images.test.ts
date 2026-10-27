import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { imageBytes, splitImageContent, type ImageData } from "@loom/core/images";
import { openDb } from "@loom/daemon/store/db";
import { ImageStore } from "../backend/daemon/src/store/images.ts";
import { logContext, totalRows, windowRows, type LogLine } from "../frontend/tui/src/transcript.ts";

const png: ImageData = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
};

test("image validation rejects mismatched formats, malformed base64 and oversized rasters", () => {
  assert.equal(imageBytes(png).length, 68);
  assert.throws(() => imageBytes({ ...png, mimeType: "image/jpeg" }));
  assert.throws(() => imageBytes({ ...png, data: "!!!!" }));
  const huge = Buffer.from(png.data, "base64");
  huge.writeUInt32BE(16000, 16);
  huge.writeUInt32BE(16000, 20);
  assert.throws(() => imageBytes({ ...png, data: huge.toString("base64") }));
});

test("provider image blocks become separate images and readable text", () => {
  for (const block of [
    { type: "image", ...png },
    { type: "image", source: { type: "base64", media_type: png.mimeType, data: png.data } },
    { type: "input_image", image_url: `data:${png.mimeType};base64,${png.data}` },
    { type: "inputImage", imageUrl: `data:${png.mimeType};base64,${png.data}` },
  ]) {
    const result = splitImageContent({ content: [{ type: "text", text: "hello" }, block] });
    assert.deepEqual(result.images, [png]);
    assert.deepEqual(result.output, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "[image]" },
      ],
    });
    assert.ok(!JSON.stringify(result.output).includes(png.data));
  }
  const result = splitImageContent(Array.from({ length: 5 }, () => ({ type: "image", ...png })));
  assert.equal(result.images.length, 4);
  assert.ok(!JSON.stringify(result.output).includes(png.data));
});

test("image storage deduplicates bytes and resolves durable references", () => {
  const db = openDb(":memory:");
  try {
    const store = new ImageStore(db);
    const a = store.put(png, "clipboard.png");
    const b = store.put(png, "other.png");
    assert.equal(a.id, b.id);
    assert.deepEqual(store.resolve([a]), [png]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM images").get()?.n, 1);
    assert.equal(store.put(png, "\x1b\nimage").name, "image");
    assert.throws(() => store.get("0".repeat(64)), /no longer available/);
  } finally {
    db.close();
  }
});

test("image geometry agrees for full windows, clipped windows, and disabled graphics", () => {
  const image = {
    id: "a".repeat(64),
    name: "picture.png",
    mimeType: "image/png" as const,
    bytes: 68,
  };
  const lines: LogLine[] = [
    {
      id: null,
      sessionId: "s",
      kind: "tool_result",
      glyph: "·",
      text: "picture",
      tone: "dim",
      ts: 0,
      images: [image],
    },
  ];
  for (const [height, imageHeight] of [
    [1, 1],
    [6, 5],
    [24, 18],
    [64, 48],
  ] as const) {
    for (const enabled of [true, false]) {
      const ctx = logContext(lines, 80, enabled, height);
      const all = windowRows(ctx, 0, totalRows(ctx));
      assert.equal(all.length, totalRows(ctx));
      assert.equal(all.filter((row) => row.image).length, enabled ? imageHeight : 1);
      for (let i = 0; i < all.length; i++)
        assert.deepEqual(windowRows(ctx, i, i + 3), all.slice(i, i + 3));
    }
  }
});
