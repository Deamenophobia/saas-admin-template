// Browser integration helper; import from your frontend's own code/build.
// Reuses the template API client. Store session tokens according to your frontend's policy.
import { ApiClient } from './api-client.mjs';

export async function beginSso(baseUrl, provider, { token, password, code } = {}) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(provider)) throw new Error('Invalid provider id');
  const client = new ApiClient(baseUrl, { token });
  const linking = token !== undefined;
  const result = await client.request('POST', linking ? `/api/v1/me/sso/${provider}/link/start` : `/api/v1/auth/sso/${provider}/start`,
    linking ? { password, code } : {});
  const url = new URL(result.authorizationUrl), state = url.searchParams.get('state');
  if (!state || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid authorization response');
  sessionStorage.setItem(`sso:${state}`, JSON.stringify({ provider, flowToken: result.flowToken, expiresAt: result.expiresAt,
    apiOrigin: new URL(baseUrl).origin }));
  window.location.assign(url.href);
}

export async function completeSso(baseUrl) {
  const query = new URL(window.location.href).searchParams, state = query.get('state');
  const saved = state && sessionStorage.getItem(`sso:${state}`);
  if (!saved) throw new Error('No sign-in started in this browser tab');
  sessionStorage.removeItem(`sso:${state}`);
  // Remove authorization parameters before rendering pages or loading third-party resources.
  window.history.replaceState(null, '', window.location.pathname);
  const flow = JSON.parse(saved);
  if (new Date(flow.expiresAt) <= new Date() || flow.apiOrigin !== new URL(baseUrl).origin) throw new Error('Sign-in flow expired or belongs to another API');
  if (query.has('error') || !query.get('code')) throw new Error('Provider sign-in did not complete; start again');
  return new ApiClient(baseUrl).request('POST', `/api/v1/auth/sso/${flow.provider}/complete`, {
    state, code: query.get('code'), flowToken: flow.flowToken, ...(query.has('iss') ? { iss: query.get('iss') } : {}),
  });
}

export function completeSsoMfa(baseUrl, challengeToken, code) {
  return new ApiClient(baseUrl).request('POST', '/api/v1/auth/sso/mfa', { challengeToken, code });
}
