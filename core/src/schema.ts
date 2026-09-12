import { z } from "zod";

/** Opaque vendor data must still have a value on the JSON wire. */
export const opaqueSchema = z.unknown().refine((value): boolean => value !== undefined);

/** Never expose Zod issues: they can contain credentials or vendor payloads. */
export const decode = <S extends z.ZodType>(
  schema: S,
  value: unknown,
  message: string,
): z.infer<S> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
};
