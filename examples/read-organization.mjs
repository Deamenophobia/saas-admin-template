import { ApiClient } from './api-client.mjs';
const { API_BASE_URL = 'http://127.0.0.1:4050', API_TOKEN, ORGANIZATION_ID } = process.env;
if (!API_TOKEN || !ORGANIZATION_ID) throw new Error('Set API_TOKEN and ORGANIZATION_ID');
const client = new ApiClient(API_BASE_URL, { token: API_TOKEN });
const org = await client.request('GET', `/api/v1/orgs/${encodeURIComponent(ORGANIZATION_ID)}`);
console.log(JSON.stringify({ id: org.id, name: org.name }, null, 2));
