---
name: add-app-with-database
description: Add a PostgreSQL database (via CloudNativePG) to an app in homelab-apps. Use when the user wants to deploy an app that needs a database, e.g. "this app needs postgres", "add a DB to this app", "deploy with persistent SQL storage".
compatibility: Requires the homelab cluster with the CNPG operator running (cnpg-system namespace). App workspace must already exist under apps/<name>/.
metadata:
  author: mrsimpson
  homelab-apps-repo: https://github.com/mrsimpson/homelab-apps
---

# Add a PostgreSQL Database to an App

Adds a CloudNativePG-managed PostgreSQL instance to an existing `homelab-apps` Pulumi stack.

## Prerequisites

- App workspace already exists at `apps/<name>/` (run the `deploy-homelab-app` skill first)
- CNPG operator running in `cnpg-system` on the cluster
- `@mrsimpson/homelab-core-components` installed (already in the workspace template)

## Step 1 — Add the database to `src/index.ts`

Import `PostgresInstance` and wire it to your app:

```typescript
import { PostgresInstance } from '@mrsimpson/homelab-core-components';

// Add after namespace creation, before createExposedWebApp:
const db = new PostgresInstance(`${APP_NAME}-db`, {
  namespace: ns,
  databaseName: APP_NAME,
  storageSize: '10Gi',
  cnpgOperator: homelab.cnpg.operator,  // ensures webhook is ready before cluster
});

// Pass credentials to app via envFrom:
export const app = homelab.createExposedWebApp(APP_NAME, {
  namespace: ns,
  image: pulumi.output(image),
  domain: pulumi.interpolate`${APP_NAME}.${domain}`,
  port: APP_PORT,
  replicas: 1,
  auth: AuthType.OAUTH2_PROXY,
  oauth2Proxy: { group: 'users' },
  envFrom: [{ secretRef: { name: db.credentialsSecretName } }],
});
```

The credentials secret exposes these env vars to the app:

| Env var | Content |
|---------|---------|
| `POSTGRES_DB` | Database name |
| `POSTGRES_USER` | `app` user |
| `POSTGRES_PASSWORD` | Generated password |
| `DATABASE_URL` | Full connection string `postgresql://app:...@host/db` |

## Step 2 — Configure options (if needed)

```typescript
const db = new PostgresInstance(`${APP_NAME}-db`, {
  namespace: ns,
  databaseName: APP_NAME,
  storageSize: '10Gi',          // default: '5Gi'
  instances: 1,                  // set to 3 for HA — no other API changes needed
  cnpgOperator: homelab.cnpg.operator,
});
```

| Option | Default | Notes |
|--------|---------|-------|
| `image` | `postgres:18` | Tag must start with PG major version |
| `storageSize` | `5Gi` | |
| `storageClass` | `longhorn-persistent` | Daily R2 backup, 7-day retention |
| `instances` | `1` | `3` for HA |
| `postgresUID/GID` | `26` | Use `999` for paradedb — **immutable** after creation |
| `sharedPreloadLibraries` | `[]` | Required for `pg_search`, `pg_cron`, etc. |
| `postInitApplicationSQL` | `[]` | Runs as superuser at bootstrap — use for extensions or default privileges |

## Step 3 — Non-standard images (e.g. paradedb)

Extensions like `pg_search` require superuser installation:

```typescript
const db = new PostgresInstance(`${APP_NAME}-db`, {
  namespace: ns,
  databaseName: APP_NAME,
  image: 'paradedb/paradedb:18-v0.23.4',
  postgresUID: 999,
  postgresGID: 999,
  sharedPreloadLibraries: ['pg_search', 'pg_cron', 'pg_stat_statements'],
  postInitApplicationSQL: [
    'CREATE EXTENSION IF NOT EXISTS vector',
    'CREATE EXTENSION IF NOT EXISTS pg_search',
  ],
  cnpgOperator: homelab.cnpg.operator,
});
```

## Step 4 — Drizzle schema migrations (if using Drizzle ORM)

Drizzle creates a `drizzle` schema owned by the `postgres` bootstrap user. Future migrations
fail with `permission denied` unless you grant default privileges at bootstrap:

```typescript
const db = new PostgresInstance(`${APP_NAME}-db`, {
  // ...
  postInitApplicationSQL: [
    'CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION app',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON TABLES TO app',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL ON SEQUENCES TO app',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO app',
  ],
  cnpgOperator: homelab.cnpg.operator,
});
```

## Step 5 — Deploy and verify

```bash
cd apps/<name>
pulumi up --stack mrsimpson/<name>/dev
kubectl get cluster -n <name>    # should show HEALTHY
kubectl get pods -n <name>       # postgres pod Running, app pod Running
```

## HA upgrade

Change `instances: 1` → `instances: 3` and `pulumi up`. No other changes needed.

## Restore runbook (pg_dump → CNPG)

When restoring from a dump taken outside CNPG (e.g. migrating from a StatefulSet), all
objects are owned by `postgres`. Transfer ownership to the `app` user first:

```bash
APP=<name>

# 1. Scale down app
kubectl scale deployment -n $APP $APP --replicas=0

# 2. Clean slate
kubectl exec -n $APP ${APP}-db-postgres-1 -- psql -U postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$APP' AND pid <> pg_backend_pid();"
kubectl exec -n $APP ${APP}-db-postgres-1 -- psql -U postgres -c "DROP DATABASE IF EXISTS $APP;"
kubectl exec -n $APP ${APP}-db-postgres-1 -- psql -U postgres -c "CREATE DATABASE $APP OWNER app;"

# 3. Restore
cat dump.sql | kubectl exec -i -n $APP ${APP}-db-postgres-1 -- psql -U postgres -d $APP

# 4. Transfer ownership
kubectl exec -n $APP ${APP}-db-postgres-1 -- psql -U postgres -d $APP -c "
DO \$\$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE 'ALTER TABLE public.' || quote_ident(r.tablename) || ' OWNER TO app';
  END LOOP;
END\$\$;
GRANT ALL ON SCHEMA public TO app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app;
"

# 5. Scale app back up
kubectl scale deployment -n $APP $APP --replicas=1
```

## See also

- `apps/lobehub/src/index.ts` — reference implementation with CNPG + Drizzle
- [ADR-017: CloudNativePG](https://github.com/mrsimpson/homelab/blob/main/docs/adr/017-postgres-cloudnativepg.md)
