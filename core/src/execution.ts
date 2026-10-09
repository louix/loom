import { z } from "zod";

/** An executable and literal arguments, never an implicitly interpreted shell command. */
export const executionOptionsSchema = z
  .object({
    argv: z
      .array(
        z
          .string()
          .max(65536)
          .refine((arg) => !arg.includes("\0")),
      )
      .min(1)
      .max(1024)
      .refine((argv) => !!argv[0] && !argv[0].startsWith("-"))
      .refine((argv) => argv.reduce((size, arg) => size + arg.length + 1, 0) <= 131072),
    terminal: z
      .strictObject({
        TERM: z
          .string()
          .max(128)
          .regex(/^[a-zA-Z0-9._+-]*$/)
          .optional(),
        COLORTERM: z
          .string()
          .max(128)
          .regex(/^[a-zA-Z0-9._+-]*$/)
          .optional(),
      })
      .optional(),
    stdin: z.boolean().default(true),
    tty: z.boolean().default(false),
  })
  .strict()
  .refine((options) => !options.tty || options.stdin, "A terminal requires stdin");

export type ExecutionOptions = z.output<typeof executionOptionsSchema>;

/**
 * Local transport handoff. The client holds the RPC connection and owns the
 * foreground child until it exits, then closes the lease. No guest secrets or
 * activated environment values are included in this target.
 */
export interface ExecutionTarget {
  token: string;
  vm: { executable: string; args: string[]; env: Record<string, string> };
}
