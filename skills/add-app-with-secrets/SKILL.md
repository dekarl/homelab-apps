---
name: add-app-with-secrets
description: Wire application secrets from Pulumi ESC into an app in homelab-apps using the External Secrets Operator. Use when the user says "this app needs an API key", "add a secret to this app", "configure credentials for this service", or "pull a secret from ESC into the app".
compatibility: Requires the homelab cluster with External Secrets Operator running and the pulumi-esc ClusterSecretStore configured. App workspace must already exist under apps/<name>/.
metadata:
  author: mrsimpson
  homelab-apps-repo: https://github.com/mrsimpson/homelab-apps
---

# Add Secrets to an App

Wire secrets from **Pulumi ESC** into a `homelab-apps` app via the External Secrets Operator (ESO).
Secrets are stored centrally in Pulumi ESC and synced automatically to Kubernetes every hour.

## Architecture

```
Pulumi ESC (mrsimpson/homelab/dev)
  ↓  ClusterSecretStore: pulumi-esc
External Secrets Operator
  ↓  ExternalSecret (per app)
Kubernetes Secret (synced every hour)
  ↓  envFrom / env / volume
App Pod
```

## Step 1 — Add the secret to Pulumi ESC

```bash
# View current secrets
pulumi env open mrsimpson/homelab/dev

# Edit and add your secret (use flat key naming: service-type-identifier)
pulumi env edit mrsimpson/homelab/dev
```

Naming convention: `{service}-{type}-{identifier}`, e.g.:
- `stripe-api-key`
- `sendgrid-api-key`
- `myapp-admin-token`

## Step 2 — Create an ExternalSecret in `src/index.ts`

```typescript
import * as k8s from '@pulumi/kubernetes';

const appSecrets = new k8s.apiextensions.CustomResource(`${APP_NAME}-secrets`, {
  apiVersion: 'external-secrets.io/v1beta1',
  kind: 'ExternalSecret',
  metadata: {
    name: `${APP_NAME}-secrets`,
    namespace: ns.metadata.name,
  },
  spec: {
    refreshInterval: '1h',
    secretStoreRef: {
      name: 'pulumi-esc',           // shared ClusterSecretStore
      kind: 'ClusterSecretStore',
    },
    target: {
      name: `${APP_NAME}-secrets`,  // name of the resulting K8s Secret
      creationPolicy: 'Owner',
    },
    data: [
      {
        secretKey: 'STRIPE_API_KEY',           // env var name in the pod
        remoteRef: { key: 'stripe-api-key' },  // key in Pulumi ESC
      },
      {
        secretKey: 'SENDGRID_API_KEY',
        remoteRef: { key: 'sendgrid-api-key' },
      },
    ],
  },
}, { dependsOn: ns });
```

## Step 3 — Mount the secret into the app

```typescript
export const app = homelab.createExposedWebApp(APP_NAME, {
  namespace: ns,
  image: pulumi.output(image),
  domain: pulumi.interpolate`${APP_NAME}.${domain}`,
  port: APP_PORT,
  auth: AuthType.OAUTH2_PROXY,
  // Mount all keys from the secret as env vars:
  envFrom: [{ secretRef: { name: `${APP_NAME}-secrets` } }],
  // Or mount specific keys:
  // env: [{ name: 'STRIPE_KEY', valueFrom: { secretKeyRef: { name: `${APP_NAME}-secrets`, key: 'STRIPE_API_KEY' } } }],
});
```

Make sure `appSecrets` is created before the app:
```typescript
export const app = homelab.createExposedWebApp(APP_NAME, {
  // ...
}, { dependsOn: [ns, appSecrets] });
```

## Step 4 — Deploy and verify

```bash
cd apps/<name>
pulumi up --stack mrsimpson/<name>/dev

# Check ExternalSecret status (should be Ready)
kubectl describe externalsecret <name>-secrets -n <name>

# Verify secret was created
kubectl get secret <name>-secrets -n <name>
```

## Rotating secrets

1. Update the value in Pulumi ESC:
   ```bash
   pulumi env edit mrsimpson/homelab/dev
   ```

2. Force immediate sync (instead of waiting up to 1h):
   ```bash
   kubectl annotate externalsecret <name>-secrets \
     force-sync="$(date +%s)" -n <name>
   ```

3. Restart the app to pick up the new value:
   ```bash
   kubectl rollout restart deployment/<name> -n <name>
   ```

## Troubleshooting

**ExternalSecret not syncing** — check status and ESO logs:
```bash
kubectl describe externalsecret <name>-secrets -n <name>
kubectl logs -n external-secrets -l app.kubernetes.io/name=external-secrets
```

**Pod can't read secret** — verify the secret exists and check env var names:
```bash
kubectl get secret <name>-secrets -n <name> -o yaml
kubectl exec -n <name> deploy/<name> -- env | grep <KEY_NAME>
```

**Key not found in ESC** — the `remoteRef.key` must exactly match the key in the ESC environment:
```bash
pulumi env open mrsimpson/homelab/dev | grep <key-name>
```

## See also

- [ADR-008: Secrets Management](https://github.com/mrsimpson/homelab/blob/main/docs/adr/008-secrets-management.md)
- [manage-secrets.md](https://github.com/mrsimpson/homelab/blob/main/docs/howto/manage-secrets.md) — full ESC + ESO architecture
- [External Secrets Operator docs](https://external-secrets.io)
