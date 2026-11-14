/* global exports, console */
// Development tenant only. Never log request bodies, tokens, identities or query values.
exports.onExecutePostLogin = async (event, api) => {
  const native = event.client.client_id === 'WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa';
  if (!native && event.client.client_id !== 'tpc_5RjUULWf1V9koMnfWj1Xg3') return;
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
  if (event.connection.strategy !== 'apple' || identities.length !== 1) {
    api.access.deny('A single verified Apple identity is required');
    return;
  }
  const label = native ? 'development-native-qualification' : 'development-oauth-qualification';
  if (event.transaction?.protocol === 'oauth2-refresh-token') {
    console.log(JSON.stringify({ event: label, flow: 'refresh' }));
  } else {
    const query = event.request?.query ?? {};
    const scopes = typeof query.scope === 'string' ? query.scope.split(/\s+/).filter(Boolean) : [];
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
        unexpectedScopes: scopes.some(scope => scope !== 'probe:read' && scope !== 'offline_access'),
      }));
    }
  }
  api.accessToken.setCustomClaim(
    'https://simplitica.co/apple_identity', identities[0].user_id
  );
};
