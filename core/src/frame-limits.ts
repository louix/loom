/** Shared by worker and VM transports; four 2 MiB images fit after base64 encoding. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 2 * MAX_FRAME_BYTES;
