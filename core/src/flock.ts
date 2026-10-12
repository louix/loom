/** A `flock` this process holds on an open file, until `release`. */
export interface HeldFlock {
  release: () => void;
}

/**
 * Unlock, then close. A subprocess any thread spawns holds a copy of every open
 * descriptor until its exec, so a bare `close` can leave the lock held for that
 * moment; the unlock drops it from every copy at once.
 */
export const releaseFlock = (file: Deno.FsFile): void => {
  try {
    file.unlockSync();
  } finally {
    file.close();
  }
};

export const heldFlock = (file: Deno.FsFile): HeldFlock => ({
  release: () => releaseFlock(file),
});
