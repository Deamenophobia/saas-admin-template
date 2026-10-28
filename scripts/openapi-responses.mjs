const str = { type: 'string' }, uuid = { type: 'string', format: 'uuid' }, date = { type: 'string', format: 'date-time' };
const bool = { type: 'boolean' }, integer = { type: 'integer' }, role = { type: 'string', enum: ['OWNER','ADMIN','MEMBER','VIEWER'] };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const array = items => ({ type: 'array', items });
const stamps = { createdAt: date, updatedAt: date };
const org = { id: uuid, name: str, slug: str, suspended: bool, ...stamps };
const key = { id: uuid, name: str, userId: nullable(uuid), serviceAccountId: nullable(uuid), prefix: str, scopes: array(str), expiresAt: date, revokedAt: nullable(date), createdAt: date };
const page = (name, total = false) => obj({ items: array(ref(name)), page: integer, limit: integer, ...(total ? { total: integer } : {}) });
export const responseSchemas = {
  Health: obj({ status: str }), Success: obj({ success: { const: true } }), Message: obj({ message: str }),
  Registered: obj({ userId: uuid }), InviteRegistered: obj({ userId: uuid, orgId: uuid }),
  SignedIn: obj({ token: str, tokenType: { const: 'Bearer' }, expiresAt: date }),
  SsoProviders: array(obj({ id: str, label: str })),
  SsoStarted: obj({ authorizationUrl: { type: 'string', format: 'uri' }, flowToken: str, expiresAt: date }),
  SsoLinked: obj({ linked: { const: true } }),
  SsoCompleted: { oneOf: [ref('SignedIn'), ref('SsoLinked')] },
  SsoMfaRequired: obj({ mfaRequired: { const: true }, challengeToken: str, expiresAt: date }),
  SsoIdentities: array(obj({ id: uuid, providerId: str, issuer: { type: 'string', format: 'uri' }, createdAt: date })),
  SafeUser: obj({ id: uuid, email: { type: 'string', format: 'email' }, name: str, emailVerified: bool, disabled: bool, isSuperAdmin: bool, createdAt: date }),
  PasswordChanged: obj({ success: { const: true }, signInRequired: { const: true } }),
  Sessions: array(obj({ id: uuid, createdAt: date, expiresAt: date })),
  MfaEnrollment: obj({ uri: str }), RecoveryCodes: obj({ recoveryCodes: array(str) }),
  OrganizationView: obj(org), OrganizationMembership: obj({ ...org, role }), Organizations: page('OrganizationMembership'),
  Member: obj({ id: uuid, userId: uuid, orgId: uuid, role, ...stamps, user: obj({ id: uuid, name: str, email: str, disabled: bool }) }),
  Members: page('Member', true), InvitationView: obj({ id: uuid, email: str, role, expiresAt: date }),
  Invitations: array(ref('InvitationView')),
  ServiceAccount: obj({ id: uuid, orgId: uuid, name: str, disabled: bool, ...stamps }), ServiceAccounts: page('ServiceAccount'),
  KeyMetadata: obj(key), KeyIssued: obj({ ...key, key: str }), Keys: page('KeyMetadata'),
  Credential: obj({ id: uuid, name: str, provider: str, revokedAt: nullable(date), createdAt: date }), Credentials: page('Credential'),
  RevealedSecret: obj({ secret: str }),
  AuditEntry: obj({ id: uuid, orgId: nullable(uuid), actorId: nullable(uuid), action: str, resourceId: nullable(str), ...stamps }), Audit: page('AuditEntry'),
  Users: page('SafeUser', true),
  DomainEvent: obj({ id: uuid, version: { type: 'integer', const: 1 }, type: str, occurredAt: date, organizationId: nullable(uuid), actorId: nullable(uuid),
    data: { type: 'object', additionalProperties: true, properties: { resourceId: str, userId: uuid, role } } }), Events: page('DomainEvent'),
  Capabilities: obj({ contractVersion: { const: 1 }, permissions: array(str), extensions: array(str), entitlements: bool,
    credentialProvisioning: obj({ contractVersion: { const: 1 }, capabilities: array({ type: 'string', enum: ['issue','revoke'] }) }) }),
};
const p = '/api/v1', o = `${p}/orgs/{orgId}`;
const responses = {
  'get /health': 'Health', 'get /ready': 'Health',
  [`post ${p}/auth/register`]: 'Registered', [`post ${p}/auth/login`]: 'SignedIn',
  [`post ${p}/auth/verify`]: 'Success', [`post ${p}/auth/reset-password`]: 'Success',
  [`post ${p}/auth/forgot-password`]: 'Message', [`post ${p}/auth/resend-verification`]: 'Message',
  [`post ${p}/auth/invitations/register`]: 'InviteRegistered',
  [`get ${p}/auth/sso/providers`]: 'SsoProviders', [`post ${p}/auth/sso/{provider}/start`]: 'SsoStarted',
  [`post ${p}/auth/sso/{provider}/complete`]: 'SsoCompleted', [`post ${p}/auth/sso/mfa`]: 'SignedIn',
  [`get ${p}/me/sso`]: 'SsoIdentities', [`post ${p}/me/sso/{provider}/link/start`]: 'SsoStarted',
  [`get ${p}/me`]: 'SafeUser', [`patch ${p}/me`]: 'SafeUser', [`post ${p}/me/password`]: 'PasswordChanged',
  [`get ${p}/me/sessions`]: 'Sessions', [`post ${p}/me/mfa/enroll`]: 'MfaEnrollment', [`post ${p}/me/mfa/confirm`]: 'RecoveryCodes',
  [`post ${p}/orgs`]: 'OrganizationView', [`get ${p}/orgs`]: 'Organizations', [`get ${o}`]: 'OrganizationView', [`patch ${o}`]: 'OrganizationView',
  [`get ${o}/members`]: 'Members', [`post ${o}/invitations`]: 'InvitationView', [`get ${o}/invitations`]: 'Invitations',
  [`post ${o}/service-accounts`]: 'ServiceAccount', [`get ${o}/service-accounts`]: 'ServiceAccounts',
  [`post ${o}/api-keys`]: 'KeyIssued', [`get ${o}/api-keys`]: 'Keys', [`post ${o}/api-keys/{id}/rotate`]: 'KeyIssued',
  [`get ${o}/credentials`]: 'Credentials', [`post ${o}/credentials/{id}/reveal`]: 'RevealedSecret',
  [`get ${o}/audit`]: 'Audit', [`get ${o}/events`]: 'Events', [`get ${o}/capabilities`]: 'Capabilities',
  [`get ${p}/admin/users`]: 'Users', [`get ${p}/admin/users/{id}`]: 'SafeUser', [`patch ${p}/admin/users/{id}`]: 'SafeUser',
  [`patch ${p}/admin/organizations/{id}`]: 'OrganizationView',
};
export function responseFor(method, path) {
  const name = responses[`${method} ${path}`];
  if (!name) throw new Error(`Missing response schema: ${method} ${path}`);
  return ref(name);
}
