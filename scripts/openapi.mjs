import { writeFileSync, readFileSync } from 'node:fs';
import { responseSchemas, responseFor } from './openapi-responses.mjs';
const str = { type: 'string' }, uuid = { type: 'string', format: 'uuid' };
const name = { type: 'string', minLength: 1, maxLength: 100 };
const email = { type: 'string', format: 'email' };
const password = { type: 'string', minLength: 12, maxLength: 256 };
const token = { type: 'string', minLength: 32, maxLength: 512 };
const role = { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const schemas = {
  ...responseSchemas,
  Register: obj({ email, name, password }),
  Login: obj({ email, password: str, code: str }, ['email', 'password']),
  Token: obj({ token }), Email: obj({ email }), Reset: obj({ token, password }),
  InviteRegister: obj({ token, name, password }),
  Name: obj({ name }), Organization: obj({ name, slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 80 } }),
  Invitation: obj({ email, role }, ['email']), Role: obj({ role }),
  PasswordChange: obj({ currentPassword: str, password, code: str }, ['currentPassword', 'password']),
  Password: obj({ password: str }), Code: obj({ code: str }), PasswordCode: obj({ password: str, code: str }),
  SsoStart: obj({}),
  SsoComplete: obj({ state: token, code: { type: 'string', minLength: 1, maxLength: 4096 }, flowToken: token,
    iss: { type: 'string', format: 'uri', maxLength: 2048 } }, ['state', 'code', 'flowToken']),
  SsoMfa: obj({ challengeToken: token, code: { type: 'string', minLength: 1, maxLength: 128 } }),
  SsoReauthenticate: obj({ password: { type: 'string', maxLength: 256 }, code: { type: 'string', maxLength: 128 } }, ['password']),
  UserUpdate: obj({ name, disabled: { type: 'boolean' } }, []),
  OrganizationState: obj({ suspended: { type: 'boolean' } }),
  ApiKey: obj({ name, serviceAccountId: uuid, scopes: { type: 'array', minItems: 1, maxItems: 20,
    items: { type: 'string', enum: ['organizations.read','organizations.write','members.read','members.write','credentials.read','credentials.write','secrets.read','audit.read','service_accounts.read','service_accounts.write'] } },
    expiresAt: { type: 'string', format: 'date-time' } }, ['name', 'scopes']),
  Error: obj({ error: obj({ type: str, code: str, message: str, status: { type: 'integer' }, request_id: str,
    timestamp: { type: 'string', format: 'date-time' }, details: { type: 'array', items: obj({ field: str, reason: str }) } },
    ['type','code','message','status','request_id','timestamp']) }),
  Operation: obj({ id: uuid, status: { type: 'string', enum: ['PENDING','SUCCEEDED','FAILED'] }, kind: str,
    credentialId: { anyOf: [uuid, { type: 'null' }] }, errorCode: { anyOf: [str, { type: 'null' }] }, updatedAt: { type: 'string', format: 'date-time' } }),
};
const paths = {};
function add(method, path, summary, body, options = {}) {
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true,
    schema: m[1] === 'provider' ? { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' } : uuid }));
  if (options.page) parameters.push(...['page','limit','search'].map(n => ({ name: n, in: 'query', schema: n === 'search' ? str : { type: 'integer', minimum: 1, ...(n === 'limit' ? { maximum: 100 } : {}) } })));
  if (options.idempotent) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true,
    schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' } });
  const code = options.status ?? 200;
  const responses = { [code]: { description: options.description ?? 'Success', ...(code === 204 ? {} : { content: { 'application/json': { schema: options.operation ? ref('Operation') : responseFor(method, path) } } }) } };
  for (const status of [400,401,403,404,409,422,429,500,503]) responses[status] = { description: 'Structured API error', content: { 'application/json': { schema: ref('Error') } } };
  if (options.operation && options.idempotent) {
    responses[202] = { description: 'Operation pending; poll status or retry the same request/key after lease expiry', content: { 'application/json': { schema: ref('Operation') } } };
    responses[502] = { description: 'Operation failed; same request/key retries the original operation', content: { 'application/json': { schema: ref('Operation') } } };
  }
  if (options.ssoMfa) responses[202] = { description: 'Local MFA required; exchange challenge at /api/v1/auth/sso/mfa',
    content: { 'application/json': { schema: ref('SsoMfaRequired') } } };
  paths[path] ??= {};
  paths[path][method] = { summary, operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g,'_')}`,
    security: options.public ? [] : [{ bearerAuth: [] }], parameters, responses,
    ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(body) } } } } : {}) };
}
add('get','/health','Liveness',null,{public:true});
add('get','/ready','Database readiness',null,{public:true});
const p = '/api/v1', a = `${p}/auth`, o = `${p}/orgs/{orgId}`;
for (const [path, body, status] of [['register','Register',201],['login','Login',200],['verify','Token',200],['forgot-password','Email',202],['resend-verification','Email',202],['reset-password','Reset',200],['invitations/register','InviteRegister',201]])
  add('post',`${a}/${path}`,path,body,{public:true,status});
add('get',`${a}/sso/providers`,'List configured OIDC providers',null,{public:true});
add('post',`${a}/sso/{provider}/start`,'Begin bound OIDC sign-in','SsoStart',{public:true});
add('post',`${a}/sso/{provider}/complete`,'Verify authorization response and sign in or finish explicit linking','SsoComplete',{public:true,ssoMfa:true});
add('post',`${a}/sso/mfa`,'Complete local MFA after OIDC sign-in','SsoMfa',{public:true});
add('get',`${p}/me/sso`,'List own linked identities');
add('post',`${p}/me/sso/{provider}/link/start`,'Begin explicit linking with local password and MFA','SsoReauthenticate');
add('delete',`${p}/me/sso/{id}`,'Unlink identity and revoke its SSO sessions','SsoReauthenticate',{status:204});
add('get',`${p}/me`,'Current user'); add('patch',`${p}/me`,'Update own profile','Name');
add('post',`${p}/me/password`,'Change password and revoke sessions','PasswordChange');
add('get',`${p}/me/sessions`,'List own sessions'); add('delete',`${p}/me/sessions/{id}`,'Revoke own session',null,{status:204});
add('post',`${p}/logout`,'Revoke current session',null,{status:204});
add('post',`${p}/me/mfa/enroll`,'Start TOTP enrollment','Password');
add('post',`${p}/me/mfa/confirm`,'Confirm TOTP and return recovery codes once','Code');
add('delete',`${p}/me/mfa`,'Disable TOTP with password and second factor','PasswordCode',{status:204});
add('post',`${p}/orgs`,'Create organization','Organization',{status:201});
add('get',`${p}/orgs`,'List own organizations',null,{page:true});
add('get',o,'Get organization'); add('patch',o,'Rename organization','Name');
add('get',`${o}/members`,'Search organization members',null,{page:true});
add('patch',`${o}/members/{id}`,'Update member role; OWNER may transfer ownership','Role',{status:204});
add('delete',`${o}/members/{id}`,'Remove member and revoke their organization keys',null,{status:204});
add('post',`${o}/invitations`,'Invite a member','Invitation',{status:201});
add('get',`${o}/invitations`,'List up to 100 pending invitations');
add('delete',`${o}/invitations/{id}`,'Cancel pending invitation',null,{status:204});
add('post',`${p}/invitations/accept`,'Accept invitation as its recipient','Token',{status:204});
add('post',`${o}/service-accounts`,'Create service account','Name',{status:201});
add('get',`${o}/service-accounts`,'List service accounts',null,{page:true});
add('patch',`${o}/service-accounts/{id}`,'Rename or disable service account','UserUpdate',{status:204});
add('post',`${o}/api-keys`,'Issue key; plaintext returned once','ApiKey',{status:201});
add('get',`${o}/api-keys`,'List key metadata',null,{page:true});
add('delete',`${o}/api-keys/{id}`,'Revoke key',null,{status:204});
add('post',`${o}/api-keys/{id}/rotate`,'Replace key and revoke previous key',null,{status:201});
add('post',`${o}/credentials`,'Provision external credential','Name',{operation:true,idempotent:true});
add('get',`${o}/credentials`,'List external credential metadata',null,{page:true});
add('post',`${o}/credentials/{id}/reveal`,'Reveal external secret; human session and secrets.read required');
add('post',`${o}/credentials/{id}/revoke`,'Revoke upstream before marking locally revoked',null,{operation:true,idempotent:true});
add('get',`${o}/operations/{id}`,'Get provisioning operation',null,{operation:true});
add('get',`${o}/audit`,'List organization audit events',null,{page:true});
add('get',`${o}/events`,'List versioned organization events',null,{page:true});
add('get',`${o}/capabilities`,'Discover current permissions and configured adapters');
add('get',`${p}/admin/users`,'Platform administrator: search users',null,{page:true});
add('get',`${p}/admin/users/{id}`,'Platform administrator: user details');
add('patch',`${p}/admin/users/{id}`,'Platform administrator: update or suspend user','UserUpdate');
add('patch',`${p}/admin/organizations/{id}`,'Platform administrator: suspend or resume organization','OrganizationState');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
writeFileSync('openapi.json', JSON.stringify({ openapi:'3.1.0', info:{ title:'SaaS Admin API',version,
  description:'Backend template. Bearer sessions and scoped organization API keys. Global identity; organization memberships determine tenant access. See README and docs/SCOPE.md for supported behavior.' },
  paths, components: { securitySchemes:{ bearerAuth:{ type:'http',scheme:'bearer' } }, schemas } },null,2)+'\n');
console.log(`Documented ${Object.values(paths).reduce((n,p)=>n+Object.keys(p).length,0)} operations`);
