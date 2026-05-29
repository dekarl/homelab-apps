# homelab-apps

> Part of [digitaleraluhut](https://github.com/digitaleraluhut) — the application layer. Each app deploys onto the [homelab](https://github.com/digitaleraluhut/homelab) cluster and connects to [local-ai](https://github.com/digitaleraluhut/local-ai) for inference, transcription, and image generation.

Personal homelab app deployments — each app is a [Pulumi](https://www.pulumi.com/) project
that consumes [`@mrsimpson/homelab-core-components`](https://www.npmjs.com/package/@mrsimpson/homelab-core-components)
and deploys onto the homelab k3s cluster.

## Apps

| App | What it does |
|-----|-------------|
| [lobehub](./apps/lobehub/) | Self-hosted AI chat (LobeHub) with local LLM, web search, image generation |
| [matrix](./apps/matrix/) | Matrix homeserver (Conduit) + WhatsApp/Signal bridges + voice transcription bot |
| [opencode-router](./apps/opencode-router/) | Per-user isolated OpenCode instances with Cloudflare routing |
| [aftertouch](./apps/aftertouch/) | Local cloud replacement for Bose SoundTouch speakers |

## Repository layout

```
homelab-apps/
├── package.json               ← npm workspaces root; shared devDeps (typescript, @types/node)
├── tsconfig.base.json         ← shared TypeScript compiler options
├── apps/
│   └── lobehub/               ← self-hosted LobeHub (AI chat)
│       ├── Pulumi.yaml
│       ├── Pulumi.dev.yaml
│       ├── src/
│       │   ├── index.ts
│       │   └── models.ts
│       ├── package.json
│       └── tsconfig.json
└── .github/
    └── workflows/
        └── deploy-lobehub.yml ← calls digitaleraluhut/homelab/.github/workflows/deploy-to-cluster.yml
```

## How it works

Each app in `apps/<name>/` is a standalone Pulumi project.  It reads shared
infrastructure outputs (domain, tunnel CNAME, Cloudflare zone) via a
`StackReference` to your homelab base stack and manages its own Kubernetes resources
in an isolated Pulumi state.

GitHub Actions deploys to the cluster by calling the reusable
[`deploy-to-cluster.yml`](https://github.com/digitaleraluhut/homelab/blob/main/.github/workflows/deploy-to-cluster.yml)
workflow from the `digitaleraluhut/homelab` repo.

## Deploying to your own homelab

These apps are designed to be forkable. They depend on a separate
[homelab](https://github.com/digitaleraluhut/homelab) base stack that provides shared
infrastructure (Cloudflare tunnel, domain, zone ID). You need to run that first.

### Prerequisites

1. A running k3s (or compatible) cluster
2. The [homelab](https://github.com/digitaleraluhut/homelab) base stack deployed and its
   Pulumi stack outputs available (exports `domain`, `cloudflareZoneId`, `tunnelId`)
3. A [Pulumi Cloud](https://app.pulumi.com) account (free tier works)
4. `pulumi` CLI authenticated: `pulumi login`

### One-time setup per app

```bash
cd apps/<name>

# Create your stack
pulumi stack init dev

# Point it at YOUR homelab base stack (replace with your Pulumi org)
pulumi config set <app>:homelabStack <your-pulumi-org>/homelab/dev

# Copy the example config and fill in your values
cp Pulumi.dev.yaml.example Pulumi.dev.yaml
# Edit Pulumi.dev.yaml — replace all <placeholder> values
# Then import it:
pulumi config --path < Pulumi.dev.yaml

# Set required secrets (see Pulumi.dev.yaml.example comments for what's needed)
pulumi config set <app>:someSecret <value> --secret

# Deploy
pulumi up
```

> **Note:** `homelabStack` has no default — Pulumi will error immediately if it is not set,
> preventing silent cross-org stack references.

### CI/CD with GitHub Actions

Fork both repos ([homelab](https://github.com/digitaleraluhut/homelab) and this one),
then add these secrets to your fork of `homelab-apps`:

| Secret | How to get it |
|--------|---------------|
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud → Access Tokens |
| `KUBECONFIG` | `bash scripts/create-kubeconfig.sh <app>` from the homelab repo, then `base64 -w0` |
| `TS_OAUTH_CLIENT_ID` | Tailscale admin → OAuth clients (`tag:ci`) |
| `TS_OAUTH_CLIENT_SECRET` | Same OAuth client |

The deploy workflows call a reusable
[`deploy-to-cluster.yml`](https://github.com/digitaleraluhut/homelab/blob/main/.github/workflows/deploy-to-cluster.yml)
from the homelab repo — update the `uses:` line in each workflow file to point to your fork.

## Security & Secrets

### How secrets are stored

| What | Mechanism | Tracked in git? |
|------|-----------|-----------------|
| Pulumi stack config (passwords, tokens, keys) | Pulumi Cloud AES-256-GCM encryption (`secure:` values) | No — `Pulumi.dev.yaml` is gitignored |
| Infrastructure-specific plaintext config (node IPs, hostnames) | `Pulumi.dev.yaml` on local machine only | No — gitignored |
| Example config structure | `Pulumi.dev.yaml.example` per app | Yes — placeholders only |

### Local setup on a new machine

```bash
# 1. Authenticate with Pulumi Cloud (restores all encrypted stack config)
pulumi login

# 2. For each app, select the stack — Pulumi pulls config from the cloud automatically
cd apps/<name>
pulumi stack select dev

# 3. Fill in plaintext values (node IP, hostname, etc.) from the example file
cp Pulumi.dev.yaml.example Pulumi.dev.yaml
# edit Pulumi.dev.yaml — replace <placeholders> with your values
# e.g.: pulumi config set aftertouch:nodeIp 192.168.x.x --stack dev
```

## Required repository secrets

| Secret | Description |
|--------|-------------|
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud access token |
| `KUBECONFIG` | base64-encoded namespace-scoped kubeconfig (Tailscale address) |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (`tag:ci`) |
| `TS_OAUTH_CLIENT_SECRET` | Tailscale OAuth client secret |

Bootstrap all secrets in one step from the `digitaleraluhut/homelab` repo:

```bash
./scripts/setup-homelab-apps.sh
```

## Agent skills

This repo ships [agentskills.io](https://agentskills.io)-compatible skills under `skills/`.
Load them in your AI agent to deploy and configure apps without reading documentation manually.

| Skill | When to use |
|-------|-------------|
| [`deploy-homelab-app`](./skills/deploy-homelab-app/SKILL.md) | Add a new app end-to-end (scaffold → RBAC → CI) |
| [`add-app-with-database`](./skills/add-app-with-database/SKILL.md) | App needs a PostgreSQL database (CNPG) |
| [`add-app-with-oauth`](./skills/add-app-with-oauth/SKILL.md) | Protect an app with GitHub OAuth (oauth2-proxy) |
| [`add-app-with-secrets`](./skills/add-app-with-secrets/SKILL.md) | Wire secrets from Pulumi ESC into an app |

## Adding a new app

Load the [`deploy-homelab-app`](./skills/deploy-homelab-app/SKILL.md) skill in your AI agent and say *"add a new app to homelab-apps"*.

Or manually:
1. Create `apps/<name>/` following the structure of `apps/lobehub/`
2. Add a deploy workflow `.github/workflows/deploy-<name>.yml`
3. Run `pulumi up` locally once to create the Kubernetes namespace
4. Generate a namespace-scoped KUBECONFIG:
   ```bash
    # from the digitaleraluhut/homelab repo
    bash scripts/create-kubeconfig.sh <name>
    base64 -w0 /tmp/<name>-ci.kubeconfig | gh secret set KUBECONFIG --repo digitaleraluhut/homelab-apps
   ```
