import { Buffer } from "node:buffer";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useStdout } from "ink";
import Image, { InkPictureProvider } from "ink-picture";
import { imageBytes, type ImageAttachment, type ImageData } from "@loom/core/images";
import type { PhysicalRow } from "./transcript.ts";

const Images = createContext<{
  enabled: boolean;
  visible: boolean;
  get: (id: string) => Promise<Buffer>;
}>({
  enabled: false,
  visible: false,
  get: () => Promise.reject(new Error("Images disabled")),
});
const initialTerminalInfo = {};

/** One terminal probe and bounded payload cache per UI, independent of transcript pages. */
export const ImageEnvironment = ({
  enabled,
  visible,
  request,
  children,
}: {
  enabled: boolean;
  visible: boolean;
  request: <T>(method: string, params: unknown) => Promise<T>;
  children: ReactNode;
}): ReactNode => {
  const { stdout } = useStdout();
  const active = enabled && stdout.isTTY === true;
  const get = useMemo(() => {
    const cache = new Map<string, Promise<Buffer>>();
    return (id: string): Promise<Buffer> => {
      const hit = cache.get(id);
      if (hit) return hit;
      const pending = request<ImageData>("image.get", { id }).then(imageBytes);
      cache.set(id, pending);
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
      void pending.catch(() => {
        if (cache.get(id) === pending) cache.delete(id);
      });
      return pending;
    };
  }, [request]);
  const content = (
    <Images.Provider value={{ enabled: active, visible, get }}>{children}</Images.Provider>
  );
  // Overrides let the text UI appear while terminal capability detection runs.
  return active ? (
    <InkPictureProvider terminalInfo={initialTerminalInfo}>{content}</InkPictureProvider>
  ) : (
    content
  );
};

const Attachment = ({
  image,
  width,
  height,
}: {
  image: ImageAttachment;
  width: number;
  height: number;
}): ReactNode => {
  const { get } = useContext(Images);
  const [data, setData] = useState<{ id: string; bytes?: Buffer; error?: boolean } | null>(null);
  useEffect(() => {
    let current = true;
    void get(image.id).then(
      (bytes) => {
        if (current) setData({ id: image.id, bytes });
      },
      () => {
        if (current) setData({ id: image.id, error: true });
      },
    );
    return () => {
      current = false;
    };
  }, [get, image.id]);
  const loaded = data?.id === image.id ? data : null;
  return loaded?.bytes ? (
    <Image src={loaded.bytes} width={width} height={height} objectFit="contain" alt={image.name} />
  ) : (
    <Box height={height}>
      <Text>{`[image: ${image.name}${loaded?.error ? " — unavailable" : " — loading…"}]`}</Text>
    </Box>
  );
};

/** Only complete image blocks get graphics. Pane clipping and modal coverage are explicit. */
export const ImageRows = ({
  rows,
  renderText,
}: {
  rows: readonly PhysicalRow[];
  renderText: (r: PhysicalRow) => ReactNode;
}): ReactNode => {
  const context = useContext(Images);
  const result: ReactNode[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const image = row.image;
    if (!image) {
      result.push(renderText(row));
      continue;
    }
    const last = rows[i + image.height - 1]?.image;
    if (
      context.enabled &&
      context.visible &&
      image.height > 1 &&
      image.offset === 0 &&
      last?.attachment.id === image.attachment.id &&
      last.offset === image.height - 1
    ) {
      result.push(
        <Box key={row.key} paddingLeft={row.indent} height={image.height} flexShrink={0}>
          <Attachment image={image.attachment} width={image.width} height={image.height} />
        </Box>,
      );
      i += image.height - 1;
    } else
      result.push(
        <Text key={row.key} wrap="truncate-end">
          {image.offset === 0 || i === 0 ? row.seg : " "}
        </Text>,
      );
  }
  return result;
};
