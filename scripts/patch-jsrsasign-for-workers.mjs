import console from "node:console";
import process from "node:process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * jsrsasign seeds its PRNG with crypto.getRandomValues / Math.random at module
 * load. Cloudflare Workers reject that in global scope (error 10021). Defer
 * entropy collection until the first rng_get_byte() call inside a request.
 */
const require = createRequire(import.meta.url);
const sourcePath = require.resolve("jsrsasign/lib/jsrsasign.js");
const source = readFileSync(sourcePath, "utf8");

const initPattern =
  /if\(rng_pool==null\)\{rng_pool=new Array\(\);rng_pptr=0;var t;if\(typeof window!=="undefined"&&\(window\.crypto!==undefined\|\|window\.msCrypto!==undefined\)\)\{var crypto=window\.crypto\|\|window\.msCrypto;if\(crypto\.getRandomValues\)\{var ua=new Uint8Array\(32\);crypto\.getRandomValues\(ua\);for\(t=0;t<32;\+\+t\)\{rng_pool\[rng_pptr\+\+\]=ua\[t\]\}\}else\{if\(navigator\.appName=="Netscape"&&navigator\.appVersion<"5"\)\{var z=window\.crypto\.random\(32\);for\(t=0;t<z\.length;\+\+t\)\{rng_pool\[rng_pptr\+\+\]=z\.charCodeAt\(t\)&255\}\}\}\}if\(rng_pptr<rng_psize&&typeof globalThis!=="undefined"&&globalThis\.crypto&&globalThis\.crypto\.getRandomValues\)\{var ga=new Uint8Array\(rng_psize-rng_pptr\);globalThis\.crypto\.getRandomValues\(ga\);for\(t=0;t<ga\.length;\+\+t\)\{rng_pool\[rng_pptr\+\+\]=ga\[t\]\}\}while\(rng_pptr<rng_psize\)\{t=Math\.floor\(65536\*Math\.random\(\)\);rng_pool\[rng_pptr\+\+\]=t>>>8;rng_pool\[rng_pptr\+\+\]=t&255\}rng_pptr=0;rng_seed_time\(\)\}/;

if (!initPattern.test(source)) {
  console.error(
    "jsrsasign RNG init pattern changed; update scripts/patch-jsrsasign-for-workers.mjs",
  );
  process.exit(1);
}

const deferredInit =
  "if(rng_pool==null){rng_pool=new Array();rng_pptr=0;/* Workers: seed on first use */}";

const getBytePattern =
  /function rng_get_byte\(\)\{if\(rng_state==null\)\{rng_seed_time\(\);/;

if (!getBytePattern.test(source)) {
  console.error(
    "jsrsasign rng_get_byte pattern changed; update scripts/patch-jsrsasign-for-workers.mjs",
  );
  process.exit(1);
}

const deferredGetByte = `function rng_get_byte(){if(rng_state==null){if(rng_pptr===0){var t;if(typeof globalThis!=="undefined"&&globalThis.crypto&&globalThis.crypto.getRandomValues){var ga=new Uint8Array(rng_psize);globalThis.crypto.getRandomValues(ga);for(t=0;t<ga.length;++t){rng_pool[rng_pptr++]=ga[t]}}else{while(rng_pptr<rng_psize){t=Math.floor(65536*Math.random());rng_pool[rng_pptr++]=t>>>8;rng_pool[rng_pptr++]=t&255}}rng_pptr=0;rng_seed_time()}rng_seed_time();`;

const patched = source
  .replace(initPattern, deferredInit)
  .replace(getBytePattern, deferredGetByte);

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/worker/vendor",
);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "jsrsasign.js");
writeFileSync(outPath, patched);
console.log(outPath);
