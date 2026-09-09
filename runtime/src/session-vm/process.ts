/** Linux process identities. pidfds keep signalling separate from reusable PID numbers. */
export interface OwnedProcess {
  pid: number;
  start: string;
  group: number;
}
export const bootId = () =>
  Deno.readTextFile("/proc/sys/kernel/random/boot_id").then((s) => s.trim());
export const processIdentity = async (pid: number): Promise<OwnedProcess | undefined> => {
  try {
    const raw = await Deno.readTextFile(`/proc/${pid}/stat`);
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return undefined;
    return { pid, start: fields[19]!, group: Number(fields[2]) };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
};
const same = (a: OwnedProcess | undefined, b: OwnedProcess) =>
  a?.start === b.start && a.group === b.group;
/** Stop an identified helper and, for a living group leader, its native descendants. */
export const stopProcess = async (owner: OwnedProcess) => {
  const current = await processIdentity(owner.pid);
  if (!same(current, owner)) {
    if (!current && owner.group === owner.pid) {
      for await (const entry of Deno.readDir("/proc")) {
        if (
          /^\d+$/.test(entry.name) &&
          (await processIdentity(Number(entry.name)))?.group === owner.group
        )
          throw new Error(
            "Unverified descendants remain in an orphaned process group; retry after they exit",
          );
      }
    }
    return;
  }
  if (owner.pid === Deno.pid) throw new Error("Refusing to stop the recovery process itself");
  const libc = Deno.dlopen("libc.so.6", {
    pidfd_open: { parameters: ["i32", "u32"], result: "i32" },
    pidfd_send_signal: { parameters: ["i32", "i32", "pointer", "u32"], result: "i32" },
    close: { parameters: ["i32"], result: "i32" },
  });
  const held: Array<{ fd: number; identity: OwnedProcess }> = [];
  const hold = async (identity: OwnedProcess) => {
    const fd = libc.symbols.pidfd_open(identity.pid, 0);
    if (fd < 0) {
      if (!same(await processIdentity(identity.pid), identity)) return;
      throw new Error("Cannot open process handle");
    }
    if (!same(await processIdentity(identity.pid), identity)) {
      libc.symbols.close(fd);
      return;
    }
    held.push({ fd, identity });
    if (
      libc.symbols.pidfd_send_signal(fd, 19, null, 0) < 0 &&
      same(await processIdentity(identity.pid), identity)
    )
      throw new Error("Cannot stop owned process");
  };
  try {
    await hold(owner);
    if (!held.length) return;
    // Freeze the group leader first, then its members, so they cannot race cleanup
    // by launching more work. Every signal uses its own checked pidfd.
    if (owner.group === owner.pid) {
      const deadline = Date.now() + 5000;
      for (;;) {
        let added = false;
        for await (const entry of Deno.readDir("/proc")) {
          if (!/^\d+$/.test(entry.name)) continue;
          const identity = await processIdentity(Number(entry.name));
          if (
            identity?.group === owner.group &&
            !held.some((p) => same(identity, p.identity) && identity.pid === p.identity.pid)
          ) {
            await hold(identity);
            added = true;
          }
        }
        if (!added) break;
        if (Date.now() > deadline) throw new Error("Owned process group did not settle");
      }
    }
  } finally {
    // Never leave a helper suspended on an error path.
    for (const { fd } of held.reverse()) libc.symbols.pidfd_send_signal(fd, 9, null, 0);
    for (const { fd } of held) libc.symbols.close(fd);
    libc.close();
  }
  const deadline = Date.now() + 5000;
  for (const { identity } of held)
    while (same(await processIdentity(identity.pid), identity)) {
      if (Date.now() > deadline) throw new Error("Owned process did not exit");
      await new Promise((r) => setTimeout(r, 20));
    }
};
