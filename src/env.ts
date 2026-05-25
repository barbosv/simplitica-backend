import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APPLE_ENVIRONMENT: z.enum(["Sandbox", "Production"]).default("Sandbox"),
  SIMPLI_INVOICE_BUNDLE_ID: z.string().default("co.simplitica.simpli-invoice"),
  SIMPLI_INVOICE_APP_APPLE_ID: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function readEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(raw);
}

