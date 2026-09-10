import { join } from "node:path";

/** Read before reaping: smolvm deletes the console along with the machine.
 * Only explicit, credential-free preparation may expose this raw guest output.
 */
export const preparationConsoleTail = async (machineDirectory: string): Promise<string> => {
  const limit = 16 * 1024;
  const path = join(machineDirectory, "agent-console.log");
  let file: Deno.FsFile | undefined;
  try {
    if (!(await Deno.lstat(path)).isFile) return "VM console log unavailable.";
    file = await Deno.open(path, { read: true });
    const size = (await file.stat()).size;
    const start = Math.max(0, size - limit);
    await file.seek(start, Deno.SeekMode.Start);
    const bytes = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset));
      if (read === null || read === 0) break;
      offset += read;
    }
    // Console text is guest-controlled. Escape terminal control characters.
    const text = new TextDecoder().decode(bytes.subarray(0, offset)).replace(
      // eslint-disable-next-line no-control-regex -- deliberately neutralize terminal controls
      /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
      (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
    return text
      ? `VM console log${start ? " (last 16 KiB)" : ""}:\n${text}`
      : "VM console log is empty; a host-side VM kill may leave no guest diagnostic.";
  } catch {
    return "VM console log unavailable.";
  } finally {
    file?.close();
  }
};
