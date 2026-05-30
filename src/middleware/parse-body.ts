import { z } from "zod";

export function parseRequestBody<T>(schema: z.ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
