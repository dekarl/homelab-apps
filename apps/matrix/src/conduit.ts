import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { AuthType, type ExposedWebAppArgs } from '@mrsimpson/homelab-core-components';
import type { HomelabContext } from '@mrsimpson/homelab-core-components';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConduitArgs {
  /** Pulumi homelab context (provides createExposedWebApp) */
  homelab: HomelabContext;
  /** Pre-created namespace resource */
  namespace: k8s.core.v1.Namespace;
  /** Conduit container image */
  image: string;
  /** Matrix server_name — IMMUTABLE after first run (baked into Matrix IDs) */
  serverName: pulumi.Output<string>;
  /** Fully-qualified domain name exposed via Cloudflare Tunnel */
  domain: pulumi.Output<string>;
  /** Conduit admin token (for registration API) — stored as k8s Secret */
  adminToken: pulumi.Output<string>;
  /** Which appservices to mount (default: all). Bridges are skipped if their tokens are not set. */
  enabledAppservices?: string[];
}

export interface ConduitOutputs {
  /** In-cluster base URL for the homeserver: http://conduit.matrix.svc.cluster.local (port 80 via Service) */
  inClusterUrl: pulumi.Output<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPONENT = 'conduit';
const CONDUIT_PORT = 6167;
const LABELS = {
  'app.kubernetes.io/name': COMPONENT,
  'app.kubernetes.io/part-of': 'matrix-pipeline',
};

// ---------------------------------------------------------------------------
// deployConduit
// ---------------------------------------------------------------------------

/**
 * Deploys the Conduit Matrix homeserver as a StatefulSet with:
 * - RocksDB data on a 20 Gi PVC (longhorn-persistent)
 * - Appservice registration YAMLs mounted from pre-existing k8s Secrets
 *   (conduit-appservice-whatsapp, conduit-appservice-signal)
 * - Internet exposure via createExposedWebApp (Cloudflare Tunnel)
 *
 * IMPORTANT: `server_name` is permanently baked into Matrix IDs.
 * Set it to `matrix.<domain>` before the first `pulumi up` and never change it.
 *
 * Bootstrap:
 *   1. kubectl create secret -n matrix conduit-appservice-whatsapp --from-file=registration.yaml
 *   2. kubectl create secret -n matrix conduit-appservice-signal   --from-file=registration.yaml
 *   3. pulumi up
 */
export function deployConduit(args: ConduitArgs): ConduitOutputs {
  const ns = args.namespace;
  const nsName = ns.metadata.name;
  const enabled = args.enabledAppservices ?? ['whatsapp', 'signal'];

  const sa = new k8s.core.v1.ServiceAccount(
    `${COMPONENT}-sa`,
    {
      metadata: {
        name: COMPONENT,
        namespace: nsName,
        labels: LABELS,
      },
      automountServiceAccountToken: false,
    },
    { dependsOn: [ns] },
  );

  // conduit.toml — stored as a Secret because it contains emergency_password.
  // Appservice file list is built dynamically: only enabled bridges are mounted.
  const appserviceFiles = [
    ...(enabled.includes('whatsapp') ? ['    "/var/lib/conduit/appservices/whatsapp/registration.yaml"'] : []),
    ...(enabled.includes('signal') ? ['    "/var/lib/conduit/appservices/signal/registration.yaml"'] : []),
  ];
  const appserviceConfigSection = appserviceFiles.length > 0
    ? `\nappservice_config_files = [\n${appserviceFiles.join(',\n')}\n]`
    : '';

  const configMap = new k8s.core.v1.Secret(
    `${COMPONENT}-config`,
    {
      metadata: {
        name: `${COMPONENT}-config`,
        namespace: nsName,
        labels: LABELS,
      },
      type: 'Opaque',
      stringData: {
        'conduit.toml': pulumi.interpolate`[global]
server_name = "${args.serverName}"
database_path = "/var/lib/conduit/db"
database_backend = "rocksdb"
port = ${CONDUIT_PORT}
max_request_size = 20_000_000  # 20 MB — sufficient for voice message media
allow_registration = false
allow_guest_registration = false
allow_federation = false
allow_public_rooms_without_login = false
allow_public_rooms_over_federation = false
trusted_servers = []
# Must be 0.0.0.0 in a container — default 127.0.0.1 is loopback-only and
# prevents k8s readiness/liveness probes from reaching the pod IP.
address = "0.0.0.0"
# emergency_password enables login as @conduit:<server_name> for admin room access.
# Used once during bootstrap to register the bot user; keep set so admin room stays accessible.
emergency_password = "${args.adminToken}"

# Media storage — explicit filesystem backend
[global.media]
backend = "filesystem"
path = "/var/lib/conduit/db/media"
${appserviceConfigSection}
`,
      },
    },
    { dependsOn: [ns] },
  );

  const adminSecret = new k8s.core.v1.Secret(
    `${COMPONENT}-admin`,
    {
      metadata: {
        name: `${COMPONENT}-admin`,
        namespace: nsName,
        labels: LABELS,
      },
      type: 'Opaque',
      stringData: {
        CONDUIT_ADMIN_TOKEN: args.adminToken,
      },
    },
    { dependsOn: [ns] },
  );

  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    `${COMPONENT}-pvc`,
    {
      metadata: {
        name: `${COMPONENT}-data`,
        namespace: nsName,
        labels: LABELS,
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'longhorn-persistent',
        resources: { requests: { storage: '20Gi' } },
      },
    },
    { dependsOn: [ns] },
  );

  const conduitApp = args.homelab.createExposedWebApp(
    COMPONENT,
    {
      namespace: ns,
      image: args.image,
      domain: args.domain,
      port: CONDUIT_PORT,
      replicas: 1,
      auth: AuthType.NONE,
      serviceAccountName: COMPONENT,
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      },
      resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
      extraVolumes: [
        {
          name: 'conduit-data',
          persistentVolumeClaim: { claimName: `${COMPONENT}-data` },
        },
        {
          name: 'conduit-config',
          secret: { secretName: `${COMPONENT}-config` },
        },
        ...(enabled.includes('whatsapp')
          ? [{
              name: 'appservice-whatsapp',
              secret: { secretName: 'conduit-appservice-whatsapp', optional: true },
            }]
          : []),
        ...(enabled.includes('signal')
          ? [{
              name: 'appservice-signal',
              secret: { secretName: 'conduit-appservice-signal', optional: true },
            }]
          : []),
      ],
      extraVolumeMounts: [
        { name: 'conduit-data', mountPath: '/var/lib/conduit/db' },
        { name: 'conduit-config', mountPath: '/etc/conduit', readOnly: true },
        ...(enabled.includes('whatsapp')
          ? [{ name: 'appservice-whatsapp', mountPath: '/var/lib/conduit/appservices/whatsapp', readOnly: true }]
          : []),
        ...(enabled.includes('signal')
          ? [{ name: 'appservice-signal', mountPath: '/var/lib/conduit/appservices/signal', readOnly: true }]
          : []),
      ],
      initContainers: [
        {
          name: 'create-media-dir',
          image: 'busybox:1.36',
          command: ['sh', '-c', 'mkdir -p /var/lib/conduit/db/media && chown 1000:1000 /var/lib/conduit/db/media'],
          volumeMounts: [
            { name: 'conduit-data', mountPath: '/var/lib/conduit/db' },
          ],
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
          },
        },
      ],
      env: [
        { name: 'CONDUIT_CONFIG', value: '/etc/conduit/conduit.toml' },
        // k8s injects CONDUIT_PORT as a service-link URL string; override with the
        // actual integer so Conduit's env-var parser doesn't crash on startup.
        { name: 'CONDUIT_PORT', value: String(CONDUIT_PORT) },
      ],
      probes: {
        readinessProbe: {
          httpGet: { path: '/_matrix/client/versions', port: CONDUIT_PORT },
          initialDelaySeconds: 30,
          periodSeconds: 15,
          failureThreshold: 6,
        },
        livenessProbe: {
          // First boot initialises RocksDB + admin room — allow 2 min before killing.
          httpGet: { path: '/_matrix/client/versions', port: CONDUIT_PORT },
          initialDelaySeconds: 120,
          periodSeconds: 30,
          failureThreshold: 5,
        },
      },
    } satisfies Omit<ExposedWebAppArgs, 'tls' | 'gatewayApi' | 'externalSecrets'>,
    { dependsOn: [ns, sa, configMap, pvc] },
  );

  return {
    inClusterUrl: pulumi.interpolate`http://${COMPONENT}.${nsName}.svc.cluster.local`,
  };
}
