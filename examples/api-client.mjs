/** Small reusable server-side client. Tokens stay in memory and are never printed. */
export class ApiClient {
  constructor(baseUrl, { token, timeoutMs = 10000 } = {}) {
    this.baseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password) {
      throw new Error('API base URL must use HTTP(S) without embedded credentials');
    }
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  async request(method, path, body, { idempotencyKey } = {}) {
    if (!path.startsWith('/api/v1/')) throw new Error('Expected a versioned API path');
    const response = await fetch(new URL(path, this.baseUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(data?.error?.message ?? 'API request failed');
      error.status = response.status;
      error.code = data?.error?.code ?? data?.errorCode;
      throw error;
    }
    return data;
  }
}
