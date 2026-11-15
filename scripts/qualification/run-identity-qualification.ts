import { createRemoteJWKSet } from "jose";
import { developmentOAuth, tokenClient } from "./managed-oauth.js";
import { qualifyIdentity } from "./identity-qualification.js";
import { consumeClientSecret, qualificationFailureReason } from "./runner-support.js";

async function main() {
  const client = tokenClient(await consumeClientSecret());
  const keys = createRemoteJWKSet(new URL(".well-known/jwks.json", developmentOAuth.issuer), { timeoutDuration: 2000 });
  const result = await qualifyIdentity(client, keys, event => console.log(JSON.stringify(event)));
  console.log(JSON.stringify(result));
}

void main().catch(error => {
  console.error(JSON.stringify({ status: "failed", mode: "identity-only", reason: qualificationFailureReason(error) }));
  process.exitCode = 1;
});
