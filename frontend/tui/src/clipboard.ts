import { Buffer } from "node:buffer";
import { imageBytes, MAX_IMAGE_BYTES, type ImageData } from "@loom/core/images";

/** Clipboard access belongs to the client machine, never the daemon or VM. */
export const readClipboardImage = async (): Promise<ImageData> => {
  const platform = Deno.build.os;
  const commands: [string, string[]][] = [];
  if (platform === "darwin") {
    commands.push(["osascript", ["-e", "get the clipboard as «class PNGf»"]]);
  } else {
    if (Deno.env.get("WAYLAND_DISPLAY"))
      commands.push(["wl-paste", ["--no-newline", "--type", "image/png"]]);
    commands.push(["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]);
  }
  for (const [command, args] of commands) {
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(command, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).spawn();
    } catch {
      continue;
    }
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(kill, 5000);
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of child.stdout) {
        total += chunk.length;
        if (total > MAX_IMAGE_BYTES * (platform === "darwin" ? 2 : 1) + 100)
          throw new Error("Image exceeds 2 MiB");
        chunks.push(chunk);
      }
      if (!(await child.status).success) continue;
      let bytes = Buffer.concat(chunks);
      if (platform === "darwin") {
        const hex = /«data PNGf([a-f\d]+)»/i.exec(bytes.toString("utf8"))?.[1];
        if (!hex) continue;
        bytes = Buffer.from(hex, "hex");
      }
      const image: ImageData = { mimeType: "image/png", data: bytes.toString("base64") };
      imageBytes(image);
      return image;
    } finally {
      clearTimeout(timer);
      kill();
      await child.status;
    }
  }
  throw new Error(
    platform === "linux"
      ? "No clipboard image. Copy an image; install wl-clipboard (Wayland) or xclip (X11)."
      : "No clipboard image. Copy an image and try again.",
  );
};
