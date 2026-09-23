export const fileLimitPattern = /\bEMFILE\b|too many open files(?! in system)|\bos error 24\b/i;
/** Match explicit descriptor-exhaustion evidence, never generic I/O or auth failures. */
export const isFileLimitError = (value: unknown): boolean => {
  if (value instanceof Error)
    return isFileLimitError(value.message) || ("code" in value && value.code === "EMFILE");
  return typeof value === "string" && fileLimitPattern.test(value);
};
export const fileLimitDiagnostic =
  'A VM operation failed with "Too many open files" (EMFILE). ' +
  "A process has exhausted its open-file limit; this may be the host VM backend serving shared files. " +
  "Check both guest process limits and the host open-file limit inherited by Loom and its VM backend.";
export const explainFileLimit = (message: string): string =>
  isFileLimitError(message) && !message.includes(fileLimitDiagnostic)
    ? message + "\n\n" + fileLimitDiagnostic
    : message;
