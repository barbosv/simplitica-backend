/* global exports, console, fetch, AbortController, Buffer, TextDecoder, setTimeout, clearTimeout */
// Development tenant only. Never log request bodies, tokens, identities or query values.
function canonical32(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

async function cloudConnection(event, appleIdentity) {
  const secret = event.secrets?.CLOUD_CONNECTION_LOOKUP_TOKEN;
  if (!canonical32(secret)) throw new Error('unavailable');
  const controller = new AbortController();
  let timer, reader;
  // The same deadline covers fetching headers and acquiring the entire body.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('unavailable')); }, 2000);
  });
  try {
    const response = await Promise.race([fetch(
      'https://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch',
      { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appleIdentity }) }
    ), deadline]);
    if (response.status !== 200 || Number(response.headers.get('Content-Length')) > 1024 || !response.body) throw new Error('unavailable');
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > 1024) throw new Error('unavailable');
      chunks.push(value);
    }
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    if (!result || Array.isArray(result) || Object.keys(result).length !== 3
        || result.active !== true || !Number.isSafeInteger(result.epoch) || result.epoch <= 0
        || !canonical32(result.namespace)) throw new Error('unavailable');
    // Capture one coherent response; never separately refresh either scalar.
    return { epoch: result.epoch, namespace: result.namespace };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

exports.onExecutePostLogin = async (event, api) => {
  const native = event.client.client_id === 'WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa';
  if (!native && event.client.client_id !== 'tpc_5RjUULWf1V9koMnfWj1Xg3') return;
  // Access-only MCP: old refresh grants and ambiguous protocols cannot acquire
  // a fresh connection epoch, even when their request omits every scope field.
  if (!native && event.transaction?.protocol !== 'oidc-basic-profile') {
    api.access.deny('Development MCP authorization-code flow required');
    return;
  }
  const resource = native ? 'https://simpli-invoice-native-dev.simplitica.co/api'
    : 'https://simpli-invoice-mcp-dev.simplitica.co/mcp';
  if (event.resource_server?.identifier !== resource) {
    api.access.deny('Development probe audience required');
    return;
  }
  const identities = (event.user.identities ?? []).filter(
    identity => identity.provider === 'apple'
      && typeof identity.user_id === 'string'
      && identity.user_id.trim().length > 0
  );
  if (event.connection.strategy !== 'apple' || identities.length !== 1
      || identities[0].user_id.length > 1024 || /[\uD800-\uDFFF]/u.test(identities[0].user_id)) {
    api.access.deny('A single verified Apple identity is required');
    return;
  }
  const query = event.request?.query ?? {};
  const scopes = typeof query.scope === 'string' ? query.scope.split(/\s+/).filter(Boolean) : [];
  const cloud = !native && (scopes.includes('cloud:access')
    || (Array.isArray(event.transaction?.requested_scopes) && event.transaction.requested_scopes.includes('cloud:access')));
  if (cloud) {
    let connection;
    try { connection = await cloudConnection(event, identities[0].user_id); }
    catch { api.access.deny('Development cloud connection unavailable'); return; }
    api.accessToken.setCustomClaim('https://simplitica.co/connection_epoch', connection.epoch);
    api.accessToken.setCustomClaim('https://simplitica.co/authorization_namespace', connection.namespace);
  }
  const label = native ? 'development-native-qualification' : 'development-oauth-qualification';
  if (event.transaction?.protocol === 'oauth2-refresh-token') {
    console.log(JSON.stringify({ event: label, flow: 'refresh' }));
  } else {
    const observation = {
      event: label, flow: 'authorization',
      pkceS256: query.code_challenge_method === 'S256'
        && typeof query.code_challenge === 'string' && query.code_challenge.length > 0,
    };
    if (native) {
      console.log(JSON.stringify({ ...observation, audienceMatches: query.audience === resource,
        qualificationScope: scopes.includes('qualification:read'), offlineAccess: scopes.includes('offline_access'),
        unexpectedScopes: scopes.some(scope => !['openid', 'profile', 'offline_access', 'qualification:read'].includes(scope)),
      }));
    } else {
      console.log(JSON.stringify({ ...observation, resourceMatches: query.resource === resource,
        probeScope: scopes.includes('probe:read'), offlineAccess: scopes.includes('offline_access'),
        unexpectedScopes: scopes.some(scope => !['probe:read', 'cloud:access', 'offline_access'].includes(scope)),
      }));
    }
  }
  api.accessToken.setCustomClaim(
    'https://simplitica.co/apple_identity', identities[0].user_id
  );
};
