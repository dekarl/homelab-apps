import * as pulumi from "@pulumi/pulumi"
import * as k8s from "@pulumi/kubernetes"
import * as fs from "fs"
import * as path from "path"
import { AuthType, createHomelabContextFromStack } from "@mrsimpson/homelab-core-components"
import { fetchFreeModels, fetchPaidModels } from "./models"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = "code"
const NAMESPACE = APP_NAME
const ROUTER_PORT = 3000
const OPENCODE_PORT = 4096
const ATTACH_PORT = 4096
const ATTACH_ROUTE_PREFIX = "attach-"
const EDITOR_ROUTE_PREFIX = "editor-"
/** Suffix appended to hash for session hostnames: <hash>-oc.<domain> */
const ROUTE_SUFFIX = "-oc"
/**
 * In-cluster URL the Cloudflare operator routes session traffic to.
 * Must point to Traefik (not the router directly) so that the IngressRoute
 * middleware chain (ForwardAuth → oauth2-chain) runs for session subdomains.
 */
const ROUTER_SERVICE_URL = "http://traefik-controller.traefik-system.svc.cluster.local:80"
const CF_OPERATOR_CONTAINER_NAME = "cloudflare-operator"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config("code")
const cloudflareConfig = new pulumi.Config("cloudflare")

// StackReference to the homelab base stack — provides tunnelCname, cloudflareZoneId, domain
const homelabStackName = cfg.require("homelabStack")
const homelabStack = new pulumi.StackReference(homelabStackName)

// Read infrastructure facts from homelab stack outputs
const domain = homelabStack.getOutput("domain") as pulumi.Output<string>
const cfZoneId = homelabStack.getOutput("cloudflareZoneId") as pulumi.Output<string>

// Tunnel ID — needed by the Cloudflare operator sidecar.
// Exported from homelab stack as "tunnelId".
const cfTunnelId = homelabStack.getOutput("tunnelId") as pulumi.Output<string>

// Build HomelabContext from StackReference — homelab defaults apply
const homelab = createHomelabContextFromStack(homelabStack)

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

const routerImage = cfg.require("routerImage")
const cfOperatorImage = cfg.require("cfOperatorImage")
const opencodeImage = cfg.require("opencodeImage")
const editorImage = cfg.get("editorImage") ?? "ghcr.io/mrsimpson/opencode-editor:latest"
const chromiumImage = cfg.get("chromiumImage") ?? "chromedp/headless-shell:latest"
const openrouterApiKey = cfg.requireSecret("openrouterApiKey")
const openrouterFreeApiKey = cfg.requireSecret("openrouterFreeApiKey")
const defaultGitRepo = cfg.get("defaultGitRepo")
const storageSize = cfg.get("storageSize") ?? "2Gi"
// podEnv: optional multiline .env content injected into session pods via ConfigMap.
// Operators set arbitrary env vars here (e.g. "WORKFLOW_AGENTS=ade\nOPENCODE_MODEL=...").
const podEnv = cfg.get("podEnv") ?? ""
const victoriaMetricsUrl = cfg.get("victoriaMetricsUrl") ?? ""
const modelThinking = cfg.get("modelThinking") ?? "opencode/nemotron-3-ultra-free"
const modelCoding = cfg.get("modelCoding") ?? "flinker/qwen3.6-35b-a3b"
const modelResearch = cfg.get("modelResearch") ?? "opencode/deepseek-v4-flash-free"
const cfApiToken = cloudflareConfig.requireSecret("apiToken")

// ---------------------------------------------------------------------------
// 1. Namespace (pre-created; passed to ExposedWebApp so it doesn't re-create)
// ---------------------------------------------------------------------------

const ns = new k8s.core.v1.Namespace(`${APP_NAME}-ns`, {
  metadata: {
    name: NAMESPACE,
    labels: {
      app: APP_NAME,
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/enforce-version": "latest",
      "pod-security.kubernetes.io/warn": "restricted",
      "pod-security.kubernetes.io/warn-version": "latest",
    },
  },
})

// ---------------------------------------------------------------------------
// 2. RBAC — router manages user pods/PVCs; operator sidecar watches pods and
//    manages IngressRoutes at runtime.
// ---------------------------------------------------------------------------

const serviceAccount = new k8s.core.v1.ServiceAccount(
  `${APP_NAME}-sa`,
  {
    metadata: {
      name: APP_NAME,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
  },
  { dependsOn: [ns] },
)

const role = new k8s.rbac.v1.Role(
  `${APP_NAME}-role`,
  {
    metadata: {
      name: APP_NAME,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    rules: [
      {
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["get", "list", "watch", "create", "delete", "patch"],
      },
      {
        apiGroups: [""],
        resources: ["pods/exec"],
        verbs: ["create", "get"],
      },
      {
        apiGroups: [""],
        resources: ["persistentvolumeclaims"],
        verbs: ["get", "list", "watch", "create", "delete"],
      },
      {
        apiGroups: [""],
        resources: ["secrets"],
        verbs: ["get", "create", "update", "patch", "delete"],
      },
      {
        apiGroups: [""],
        resources: ["configmaps"],
        verbs: ["get", "create", "delete"],
      },
      {
        apiGroups: ["traefik.io"],
        resources: ["ingressroutes"],
        verbs: ["get", "list", "create", "delete"],
      },
    ],
  },
  { dependsOn: [ns] },
)

const roleBinding = new k8s.rbac.v1.RoleBinding(
  `${APP_NAME}-rolebinding`,
  {
    metadata: {
      name: APP_NAME,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: APP_NAME,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: APP_NAME,
        namespace: NAMESPACE,
      },
    ],
  },
  { dependsOn: [role, serviceAccount] },
)

// ---------------------------------------------------------------------------
// 3. Secret — Anthropic API key mounted into session pods
// ---------------------------------------------------------------------------

const apiKeysSecret = new k8s.core.v1.Secret(
  `${APP_NAME}-api-keys`,
  {
    metadata: {
      name: "opencode-api-keys",
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    type: "Opaque",
    stringData: {
      OPENROUTER_API_KEY: openrouterApiKey,
      OPENROUTER_FREE_API_KEY: openrouterFreeApiKey,
    },
  },
  { dependsOn: [ns] },
)

// ---------------------------------------------------------------------------
// 4. ConfigMap — dynamic config overrides for session pods
//    Contains only dynamic parts (model lists) that change at deploy time.
//    These are merged with baked config (/etc/opencode-defaults/) by the
//    init container using jq deep merge.
// ---------------------------------------------------------------------------

const freeModels = pulumi.output(fetchFreeModels())
const paidModels = pulumi.output(fetchPaidModels())

type FlinkerModel = {
  id: string
  status: { value: string; args: string[] }
}

function parseFlinkerModel(m: FlinkerModel): [string, object] | null {
  const args = m.status.args ?? []
  // Exclude embedding models and placeholders with no --model arg
  if (args.includes("--embeddings")) return null
  if (!args.includes("--model") && !args.includes("--hf-repo")) return null

  const ctxIdx = args.indexOf("--ctx-size")
  const ctx = ctxIdx !== -1 ? parseInt(args[ctxIdx + 1], 10) : undefined

  return [
    m.id,
    {
      name: `${m.id} (local${m.status.value === "loaded" ? ", loaded" : ""})`,
      tool_call: true,
      ...(ctx ? { limit: { context: ctx, output: Math.min(ctx, 32768) } } : {}),
      ...(m.id === "qwen3.6-35b-a3b" ? { options: { top_k: 20, top_p: 0.95, temperature: 0.6 } } : {}),
    },
  ]
}

async function fetchFlinkerModels() {
  try {
    const res = await fetch("http://flinker:8080/v1/models")
    const data = (await res.json()) as { data: FlinkerModel[] }
    return Object.fromEntries(
      (data.data ?? [])
        .sort((a, b) => (a.status.value === "loaded" ? -1 : 1) - (b.status.value === "loaded" ? -1 : 1))
        .flatMap((m) => {
          const entry = parseFlinkerModel(m)
          return entry ? [entry] : []
        }),
    )
  } catch {
    return {}
  }
}
const flinkerModels = pulumi.output(fetchFlinkerModels())

const configMap = new k8s.core.v1.ConfigMap(
  `${APP_NAME}-config`,
  {
    metadata: {
      name: "opencode-config-dir",
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    data: pulumi.all([freeModels, paidModels, flinkerModels]).apply(([free, paid, flinker]) => ({
      // This file is deep-merged into the baked opencode.json by the init container.
      // Only contains the parts that need to be dynamic (model lists).
      "opencode.json": JSON.stringify(
        {
          model: "flinker/qwen3.6-35b-a3b",
          provider: {
            openrouter: {
              models: paid,
            },
            "openrouter-free": {
              models: free,
            },
            flinker: {
              name: "Flinker LLMs",
              api: "http://flinker:8080/v1",
              models: flinker,
            },
          },
        },
        null,
        2,
      ),
      // .env is sourced by the pod entrypoint before launching opencode.
      // Operators set arbitrary vars here, e.g. WORKFLOW_AGENTS=ade.
      // Empty by default — the source command is guarded with "|| true".
      ".env": podEnv,
    })),
  },
  { dependsOn: [ns] },
)

// ---------------------------------------------------------------------------
// 5. Secret — Cloudflare credentials for the operator sidecar
// ---------------------------------------------------------------------------

const cfSecret = new k8s.core.v1.Secret(
  `${APP_NAME}-cf-credentials`,
  {
    metadata: {
      name: `${APP_NAME}-cf-credentials`,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    type: "Opaque",
    stringData: {
      CF_API_TOKEN: cfApiToken,
    },
  },
  { dependsOn: [ns] },
)

// ---------------------------------------------------------------------------
// 6b. Secret — Admin secret for CI endpoints (e.g. /api/admin/pull-image)
// ---------------------------------------------------------------------------

const adminSecretValue = cfg.requireSecret("adminSecret")

const adminSecret = new k8s.core.v1.Secret(
  `${APP_NAME}-admin-secret`,
  {
    metadata: {
      name: `${APP_NAME}-admin-secret`,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    type: "Opaque",
    stringData: {
      ADMIN_SECRET: adminSecretValue,
    },
  },
  { dependsOn: [ns] },
)

// ---------------------------------------------------------------------------
// 6c. PVC — persistent archive for session history JSON files
// ---------------------------------------------------------------------------

const historyPvc = new k8s.core.v1.PersistentVolumeClaim(
  `${APP_NAME}-history`,
  {
    metadata: {
      name: "code-history",
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "longhorn-persistent",
      resources: {
        requests: {
          storage: "2Gi",
        },
      },
    },
  },
  {
    dependsOn: [ns],
    // longhorn-persistent uses WaitForFirstConsumer binding mode: the PVC stays
    // Pending until a pod mounts it. Skip Pulumi's readiness wait so the
    // deployment (first consumer) can be created and trigger provisioning.
    customTimeouts: { create: "1s" },
  },
)

// ---------------------------------------------------------------------------
// 6d. Grafana dashboard — sync Job writes to shared PVC owned by homelab
//     The dashboard JSON lives in this repo at grafana/opencode-token-metrics.json.
//     We embed it in a ConfigMap in the "observability" namespace (where Grafana runs),
//     then run a one-shot Job that copies it onto a shared ReadWriteMany PVC.
//     The PVC is created by the homelab observability stack (not here), so it
//     already exists when this Job runs. The homelab/Grafana stack mounts it
//     read-only — dashboards appear within 30s via the provisioner hot-reload.
// ---------------------------------------------------------------------------

// ConfigMap in observability namespace — carries the dashboard JSON.
// The sync Job reads from this ConfigMap so the dashboard stays up to date on every deploy.
const dashboardConfigMap = new k8s.core.v1.ConfigMap(
  "opencode-dashboards-cm",
  {
    metadata: {
      name: "opencode-dashboards",
      namespace: "observability",
      labels: { app: APP_NAME, "managed-by": "homelab-apps" },
    },
    data: {
      "opencode-token-metrics.json": fs.readFileSync(
        path.join(__dirname, "../grafana/opencode-token-metrics.json"),
        "utf-8",
      ),
    },
  },
)

// Sync Job — runs on every pulumi up, writes dashboard JSON from ConfigMap to PVC.
// The PVC is owned by the homelab observability stack (grafana-app-dashboards in
// observability namespace), so it already exists when this Job runs.
// Timestamp-based name forces a new Job each deploy (Jobs are immutable once created).
// ttlSecondsAfterFinished: 300 cleans up completed Jobs after 5 minutes.
const dashboardSyncJob = new k8s.batch.v1.Job(
  "opencode-dashboard-sync",
  {
    metadata: {
      name: `opencode-dashboard-sync-${Date.now()}`,
      namespace: "observability",
      labels: { app: APP_NAME, "managed-by": "homelab-apps" },
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: { app: `${APP_NAME}-dashboard-sync` },
        },
        spec: {
          restartPolicy: "OnFailure",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            fsGroup: 65534,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "sync",
              image: "busybox:1.36",
              command: [
                "sh",
                "-c",
                "rm -rf /output/dashboards && cp /dashboards/opencode-token-metrics.json /output/opencode-token-metrics.json && echo 'dashboard sync complete'",
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [
                { name: "dashboards-src", mountPath: "/dashboards" },
                { name: "dashboards-out", mountPath: "/output" },
              ],
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "50m", memory: "32Mi" },
              },
            },
          ],
          volumes: [
            {
              name: "dashboards-src",
              configMap: { name: "opencode-dashboards" },
            },
            {
              name: "dashboards-out",
              persistentVolumeClaim: { claimName: "grafana-app-dashboards" },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [dashboardConfigMap] },
)

// ---------------------------------------------------------------------------
// 7. Cloudflare operator sidecar container spec
//    Watches session pods, manages <hash>-oc.<domain> DNS + tunnel routes.
// ---------------------------------------------------------------------------

const operatorSidecar = [
  {
    name: CF_OPERATOR_CONTAINER_NAME,
    image: pulumi.output(cfOperatorImage),
    securityContext: {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    },
    env: [
      { name: "WATCH_NAMESPACE", value: NAMESPACE },
      {
        name: "POD_LABEL_SELECTOR",
        value: "app.kubernetes.io/managed-by=opencode-router",
      },
      { name: "CF_ZONE_ID", value: cfZoneId },
      { name: "CF_TUNNEL_ID", value: cfTunnelId },
      { name: "DOMAIN", value: domain },
      { name: "ROUTE_SUFFIX", value: ROUTE_SUFFIX },
      { name: "ROUTER_SERVICE_URL", value: ROUTER_SERVICE_URL },
      // Direct ClusterIP URL for admin API calls — bypasses Traefik/oauth2 middleware
      { name: "ROUTER_ADMIN_URL", value: pulumi.interpolate`http://${APP_NAME}.${NAMESPACE}.svc.cluster.local:80` },
      { name: "INGRESSROUTE_NAMESPACE", value: NAMESPACE },
      { name: "OAUTH2_CHAIN_MIDDLEWARE", value: `${APP_NAME}-oauth2-chain` },
      { name: "ROUTER_SERVICE_NAME", value: APP_NAME },
      { name: "ATTACH_ROUTE_PREFIX", value: ATTACH_ROUTE_PREFIX },
      { name: "ATTACH_SERVICE_PORT", value: String(ATTACH_PORT) },
      { name: "ATTACH_SERVICE_NAME", value: `${APP_NAME}-attach` },
      { name: "EDITOR_ROUTE_PREFIX", value: EDITOR_ROUTE_PREFIX },
      {
        name: "CF_API_TOKEN",
        valueFrom: {
          secretKeyRef: {
            name: `${APP_NAME}-cf-credentials`,
            key: "CF_API_TOKEN",
          },
        },
      },
      {
        name: "ROUTER_ADMIN_SECRET",
        valueFrom: {
          secretKeyRef: {
            name: `${APP_NAME}-admin-secret`,
            key: "ADMIN_SECRET",
          },
        },
      },
    ],
    readinessProbe: {
      httpGet: { path: "/healthz", port: 8080 },
      initialDelaySeconds: 5,
      periodSeconds: 10,
    },
    livenessProbe: {
      httpGet: { path: "/healthz", port: 8080 },
      initialDelaySeconds: 15,
      periodSeconds: 30,
    },
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "200m", memory: "128Mi" },
    },
  },
]

// ---------------------------------------------------------------------------
// 8. ExposedWebApp — Deployment, Service, OAuth2-Proxy auth, main DNS CNAME
// ---------------------------------------------------------------------------

const appDomain = pulumi.interpolate`${APP_NAME}.${domain}`

export const app = homelab.createExposedWebApp(
  APP_NAME,
  {
    namespace: ns,
    image: pulumi.output(routerImage),
    domain: appDomain,
    port: ROUTER_PORT,
    replicas: 1,
    auth: AuthType.OAUTH2_PROXY,
    oauth2Proxy: { group: "developers" },
    serviceAccountName: APP_NAME,
    imagePullSecrets: [{ name: "ghcr-pull-secret" }],
    securityContext: {
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    },
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "256Mi" },
    },
    env: [
      { name: "OPENCODE_IMAGE", value: pulumi.output(opencodeImage) },
      { name: "EDITOR_IMAGE", value: pulumi.output(editorImage) },
      { name: "CHROMIUM_IMAGE", value: chromiumImage },
      { name: "OPENCODE_NAMESPACE", value: NAMESPACE },
      { name: "OPENCODE_PORT", value: String(OPENCODE_PORT) },
      { name: "STORAGE_CLASS", value: "longhorn-uncritical" },
      { name: "STORAGE_SIZE", value: storageSize },
      { name: "API_KEY_SECRET_NAME", value: "opencode-api-keys" },
      { name: "CONFIG_MAP_NAME", value: "opencode-config-dir" },
      { name: "IMAGE_PULL_SECRET_NAME", value: "ghcr-pull-secret" },
      { name: "ROUTER_DOMAIN", value: domain },
      { name: "ROUTE_SUFFIX", value: ROUTE_SUFFIX },
      { name: "DEBUG_HEADERS", value: "true" },
      ...(defaultGitRepo ? [{ name: "DEFAULT_GIT_REPO", value: defaultGitRepo }] : []),
      // Admin secret for CI endpoints (e.g. /api/admin/pull-image)
      { name: "ADMIN_SECRET", value: adminSecretValue },
      // Direct ClusterIP URL passed to session pods so the plugin can push port events back
      { name: "OPENCODE_ROUTER_URL", value: pulumi.interpolate`http://${APP_NAME}.${NAMESPACE}.svc.cluster.local:80` },
      // External domain passed to session pods so the dev-server skill can construct public port-forward URLs
      { name: "OPENCODE_ROUTER_EXTERNAL_DOMAIN", value: domain },
      // Archive directory for session export JSON files
      { name: "ARCHIVE_DIR", value: "/data/history" },
      // VictoriaMetrics URL for token metrics push from session pods (also consumed by router itself)
      ...(victoriaMetricsUrl ? [{ name: "VICTORIA_METRICS_URL", value: victoriaMetricsUrl }] : []),
      // Capability-aware model routing — router injects these into pod init scripts
      { name: "OPENCODE_MODEL_THINKING", value: modelThinking },
      { name: "OPENCODE_MODEL_CODING", value: modelCoding },
      { name: "OPENCODE_MODEL_RESEARCH", value: modelResearch },
    ],
    extraVolumes: [
      {
        name: "session-history",
        persistentVolumeClaim: { claimName: "code-history" },
      },
    ],
    extraVolumeMounts: [
      {
        name: "session-history",
        mountPath: "/data/history",
      },
    ],
    probes: {
      readinessProbe: {
        httpGet: {
          path: "/api/sessions",
          port: ROUTER_PORT,
          httpHeaders: [{ name: "X-Auth-Request-Email", value: "healthcheck@probe" }],
        },
        initialDelaySeconds: 5,
        periodSeconds: 10,
        failureThreshold: 3,
      },
      livenessProbe: {
        httpGet: {
          path: "/api/sessions",
          port: ROUTER_PORT,
          httpHeaders: [{ name: "X-Auth-Request-Email", value: "healthcheck@probe" }],
        },
        initialDelaySeconds: 15,
        periodSeconds: 30,
        failureThreshold: 3,
      },
    },
    extraContainers: operatorSidecar,
    tags: ["opencode", "router", "ai"],
  },
  {
    dependsOn: [roleBinding, cfSecret, apiKeysSecret, configMap, adminSecret, historyPvc],
  },
)

// ---------------------------------------------------------------------------
// Stack outputs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. Attach Service — exposes the router's attach port (4096) as a named
//    Service port so Traefik IngressRoutes can target it without oauth2.
//    ExposedWebApp only creates a Service on the main port (3000), so we
//    patch the existing Service by adding a second named port here.
// ---------------------------------------------------------------------------

const attachService = new k8s.core.v1.Service(
  `${APP_NAME}-attach`,
  {
    metadata: {
      name: `${APP_NAME}-attach`,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    spec: {
      selector: { app: APP_NAME },
      ports: [
        {
          name: "attach",
          port: ATTACH_PORT,
          targetPort: ATTACH_PORT,
          protocol: "TCP",
        },
      ],
    },
  },
  { dependsOn: [app] },
)

export const url = pulumi.interpolate`https://${appDomain}`
export const namespace = app.namespace.metadata.name
