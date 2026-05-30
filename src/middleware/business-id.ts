import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const BusinessIdSchema = z.string().uuid();

export type BusinessIdRequest = FastifyRequest & { businessId: string };

export function requireBusinessId(req: FastifyRequest, reply: FastifyReply): req is BusinessIdRequest {
  const raw = req.headers["x-business-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    void reply.code(400).send({ error: "Missing X-Business-Id" });
    return false;
  }
  const parsed = BusinessIdSchema.safeParse(value.toLowerCase());
  if (!parsed.success) {
    void reply.code(400).send({ error: "Invalid business id" });
    return false;
  }
  (req as BusinessIdRequest).businessId = parsed.data;
  return true;
}
