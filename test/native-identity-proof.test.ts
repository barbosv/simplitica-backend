import { expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { nativeProofReceiver } from "../scripts/qualification/native-proof.js";
import { verifyNativeAccessToken } from "../scripts/qualification/managed-oauth.js";

it("accepts only a signed native-development token with the same opaque hosted Apple identity", async () => {
  const keys = await generateKeyPair("RS256");
  const sign = (overrides = {}) => new SignJWT({ iss: "https://dev-i8usug5fp48kepvr.us.auth0.com/",
    aud: "https://simpli-invoice-native-dev.simplitica.co/api", sub: "synthetic-native",
    azp: "WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa", scope: "qualification:read",
    "https://simplitica.co/apple_identity": "private-opaque-identity", ...overrides })
    .setProtectedHeader({alg:"RS256"}).setExpirationTime("2m").sign(keys.privateKey);
  const receiver = await nativeProofReceiver("private-opaque-identity", token=>verifyNativeAccessToken(token,async()=>keys.publicKey),2000,0);
  void receiver.qualified.catch(()=>undefined);
  const post = (token:string) => fetch(receiver.url,{method:"POST",headers:{authorization:`Bearer ${token}`}});
  try {
    expect((await fetch(receiver.url)).status).toBe(405);
    expect((await post("unsigned")).status).toBe(401);
    expect((await post(await sign({aud:"https://simpli-invoice-mcp-dev.simplitica.co/mcp"}))).status).toBe(401);
    expect((await post(await sign({azp:"other"}))).status).toBe(401);
    expect((await post(await sign({scope:"probe:read"}))).status).toBe(401);
    expect((await post(await sign({"https://simplitica.co/apple_identity":"another-private-identity"}))).status).toBe(403);
    const response=await post(await sign());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({qualified:true});
    await expect(receiver.qualified).resolves.toBeUndefined();
    expect((await post(await sign())).status).toBe(409);
  } finally {await receiver.close();}
});

it("times out native proof rather than inferring continuity from configuration",async()=>{
  const receiver=await nativeProofReceiver("identity",async()=>"identity",10,0);
  try {await expect(receiver.qualified).rejects.toThrow("native_proof_timeout");}
  finally {await receiver.close();}
});
