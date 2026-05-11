---
name: add-app-with-oauth
description: Add GitHub OAuth authentication (via the centralized oauth2-proxy) to an app in homelab-apps. Use when the user says "protect this app with auth", "add login to this app", "require GitHub sign-in", or "only I should be able to access this app".
compatibility: Requires the homelab cluster with the centralized oauth2-proxy deployment running (oauth2-proxy namespace). App workspace must already exist under apps/<name>/.
metadata:
  author: mrsimpson
  homelab-apps-repo: https://github.com/mrsimpson/homelab-apps
---

# Add OAuth Authentication to an App

Protects a `homelab-apps` app with GitHub OAuth via the centralized `oauth2-proxy` deployment.
No per-app OAuth application or sidecar is needed — one shared proxy handles all apps.

## How it works

```
Browser → Cloudflare → Traefik → IngressRoute
  ├─ ForwardAuth middleware → oauth2-proxy /oauth2/auth
  │   └─ Valid session cookie → forward to app (+ X-Auth-Request-Email header)
  └─ No session → 401 → redirect to GitHub OAuth → callback → cookie → app
```

`createExposedWebApp` sets up the full middleware chain automatically when you pass
`auth: AuthType.OAUTH2_PROXY`. No manual Traefik resource creation needed.

## Step 1 — Set auth in `src/index.ts`

```typescript
import { AuthType } from '@mrsimpson/homelab-core-components';

export const app = homelab.createExposedWebApp(APP_NAME, {
  namespace: ns,
  image: pulumi.output(image),
  domain: pulumi.interpolate`${APP_NAME}.${domain}`,
  port: APP_PORT,
  auth: AuthType.OAUTH2_PROXY,         // <-- add this
  oauth2Proxy: { group: 'users' },     // optional, defaults to 'users'
});
```

That's it for the Pulumi side. The component creates:

| Resource | Name | Purpose |
|----------|------|---------|
| Middleware | `<app>-oauth2-forwardauth` | ForwardAuth check against oauth2-proxy |
| Middleware | `<app>-oauth2-errors` | 401 → redirect via shared service |
| Middleware | `<app>-oauth2-chain` | Chains errors + forwardauth |
| IngressRoute | `<app>-oauth2-signin` | `/oauth2/*` → oauth2-proxy (unprotected) |
| IngressRoute | `<app>-oauth2-app` | `/*` → app (protected by chain) |

## Step 2 — Add the user's email to the allowlist

Users must be in the group's email allowlist in the **homelab** core repo:

```typescript
// homelab/packages/core/infrastructure/src/oauth2-proxy/groups.ts
export const groups: Record<string, string[]> = {
  users: [
    'alice@example.com',   // add your email here
  ],
};
```

Then deploy the homelab core stack:
```bash
cd ~/projects/privat/homelab
pulumi up --stack mrsimpson/homelab/dev
```

## Step 3 — Deploy and verify

```bash
cd apps/<name>
pulumi up --stack mrsimpson/<name>/dev
```

Verify:
1. Visit `https://<name>.<domain>` — should redirect to GitHub sign-in
2. After auth: app loads, `X-Auth-Request-Email` header available to app
3. If email not in group: `403 Forbidden`

## Reading the authenticated user

After auth, oauth2-proxy sets these request headers:

| Header | Value |
|--------|-------|
| `X-Auth-Request-Email` | `alice@example.com` |
| `X-Auth-Request-User` | GitHub username |
| `X-Auth-Request-Groups` | Groups the user belongs to |

Your app can read these without implementing its own auth.

## Extra routes with the same auth

If the app needs additional IngressRoutes (e.g. wildcard subdomains), reference the
chain middleware by its deterministic name:

```typescript
new k8s.apiextensions.CustomResource('my-extra-route', {
  apiVersion: 'traefik.io/v1alpha1',
  kind: 'IngressRoute',
  metadata: { name: 'my-extra-route', namespace: APP_NAME },
  spec: {
    entryPoints: ['web'],
    routes: [{
      match: `HostRegexp(\`{sub:[a-z]+}.${APP_NAME}.example.com\`)`,
      kind: 'Rule',
      middlewares: [{ name: `${APP_NAME}-oauth2-chain`, namespace: APP_NAME }],
      services: [{ name: APP_NAME, port: 80 }],
    }],
  },
}, { dependsOn: app.route });
```

## Auth modes comparison

| Mode | Route type | Provider | Use case |
|------|-----------|---------|---------|
| `AuthType.NONE` | HTTPRoute | None | Public apps |
| `AuthType.OAUTH2_PROXY` | IngressRoute | GitHub OAuth | Personal/external access |

## Troubleshooting

**Redirect loop** — check for cookie domain mismatch or Cloudflare caching auth cookies:
```bash
kubectl logs -n oauth2-proxy deployment/oauth2-proxy-users
```

**403 after successful GitHub login** — email not in allowlist:
```bash
kubectl get configmap -n oauth2-proxy oauth2-emails-users -o yaml
# Add the email to groups.ts in homelab core, then pulumi up
```

**401 but user is logged in** — session expired or oauth2-proxy unreachable:
```bash
kubectl get endpoints -n oauth2-proxy oauth2-proxy-users  # must have endpoints
kubectl logs -n <name> -l app=<name>                      # check for upstream errors
```

## See also

- `apps/lobehub/src/index.ts` — reference implementation
- [OAuth2-Proxy architecture](https://github.com/mrsimpson/homelab/blob/main/docs/OAUTH2_PROXY.md)
- [manage-access-control.md](https://github.com/mrsimpson/homelab/blob/main/docs/howto/manage-access-control.md) — add/remove users and groups
