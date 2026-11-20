import type { JWTVerifyGetKey } from "jose";
import { createCloudTokenAuthorizer } from "../auth/cloud-token.js";
import { RecordError } from "./types.js";
declare const recordAuthority: unique symbol;
export type CloudRecordAuthority = Readonly<{ ownerId: string; businessId: string; connectionEpoch: number; authorizationNamespace: string; [recordAuthority]: true }>;
const minted = new WeakSet<object>();
export function requireRecordAuthority(authority: CloudRecordAuthority, namespace: string): void {
  if (!authority || !minted.has(authority) || authority.authorizationNamespace !== namespace) throw new RecordError("not_authorized");
}
export function createCloudRecordAuthorizer(db: D1Database, dependencies: { authorizationNamespace: string; keys?: JWTVerifyGetKey; now?: () => number }) {
  const authorize = createCloudTokenAuthorizer(db, dependencies);
  return async (token: string): Promise<CloudRecordAuthority | null> => {
    const owner = await authorize(token);
    if (!owner) return null;
    const authority = Object.freeze(owner) as CloudRecordAuthority;
    minted.add(authority);
    return authority;
  };
}
