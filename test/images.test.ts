import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { imageBytes, imageDimensions, splitImageContent, type ImageData } from "@loom/core/images";
import { openDb } from "@loom/daemon/store/db";
import { ImageStore } from "../backend/daemon/src/store/images.ts";
import { SessionEventStore } from "../backend/daemon/src/store/session-events.ts";
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

test("image headers report dimensions for PNG, GIF and JPEG", () => {
  assert.deepEqual(imageDimensions(Buffer.from(png.data, "base64"), "image/png"), {
    width: 1,
    height: 1,
  });
  assert.deepEqual(imageDimensions(Buffer.from("4749463839618002e001", "hex"), "image/gif"), {
    width: 640,
    height: 480,
  });
  // SOI followed by a baseline SOF for an 800 × 600 image.
  assert.deepEqual(
    imageDimensions(Buffer.from("ffd8ffc00011080258032003011100021100031100", "hex"), "image/jpeg"),
    { width: 800, height: 600 },
  );
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
    assert.deepEqual(a.dimensions, { width: 1, height: 1 });
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
    dimensions: { width: 1080, height: 2400 },
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

test("historical image references gain dimensions on both backward and forward paging", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO sessions (id, provider, mode, status, created_at, updated_at) VALUES ('s', 'fake', 'default', 'idle', 1, 1)",
    ).run();
    const { dimensions: _, ...legacy } = new ImageStore(db).put(png);
    const events = new SessionEventStore(db);
    events.append("s", {
      type: "tool_result",
      sessionId: "s",
      ts: 1,
      id: "read",
      ok: true,
      output: "[image]",
      images: [legacy],
    });
    for (const event of [events.page("s").items[0]!.event, events.after("s", 0, 10)[0]!.event]) {
      assert.ok(event.type === "tool_result");
      assert.deepEqual(event.images?.[0]?.dimensions, { width: 1, height: 1 });
    }
    assert.ok(
      !String(db.prepare("SELECT payload FROM session_events").get()?.payload).includes(
        "dimensions",
      ),
    );
    assert.deepEqual(new ImageStore(db).describe({ ...legacy, id: "0".repeat(64) }), {
      ...legacy,
      id: "0".repeat(64),
    });
  } finally {
    db.close();
  }
});

test("wide images use their actual footprint, including when scrolling and mixing aspect ratios", () => {
  const wide = {
    id: "b".repeat(64),
    name: "strip.png",
    mimeType: "image/png" as const,
    bytes: 68,
    dimensions: { width: 1800, height: 200 },
  };
  const portrait = { ...wide, id: "c".repeat(64), dimensions: { width: 600, height: 1800 } };
  const line: LogLine = {
    id: null,
    sessionId: "s",
    kind: "tool_result",
    glyph: "·",
    text: "screenshot",
    tone: "dim",
    ts: 0,
    images: [wide, portrait],
  };
  for (const ratio of [0.5, 0.75, 1]) {
    const ctx = logContext([line], 200, true, 64, ratio);
    const rows = windowRows(ctx, 0, totalRows(ctx));
    const wideRows = rows.filter((row) => row.image?.attachment.id === wide.id);
    const first = wideRows[0]!.image!;
    assert.equal(wideRows.length, Math.ceil((first.width * ratio) / 9));
    assert.ok(wideRows.length < 24, "a strip does not reserve most of the pane");
    assert.equal(rows.filter((row) => row.image?.attachment.id === portrait.id).length, 48);
    assert.equal(rows.length, totalRows(ctx));
    for (let from = 0; from < rows.length; from++) {
      assert.deepEqual(windowRows(ctx, from, from + 64), rows.slice(from, from + 64));
    }
  }
  const narrow = windowRows(logContext([line], 40, true, 64), 0, 1000);
  assert.ok(narrow.filter((row) => row.image?.attachment.id === wide.id).length < 4);
});
