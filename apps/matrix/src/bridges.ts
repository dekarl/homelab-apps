import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeArgs {
  /** Pre-created namespace resource */
  namespace: k8s.core.v1.Namespace;
  /** In-cluster URL of the Conduit homeserver */
  conduitInClusterUrl: pulumi.Output<string>;
  /** mautrix-whatsapp container image */
  whatsappImage: string;
  /** mautrix-signal container image */
  signalImage: string;
  /** WhatsApp bridge appservice token (from registration.yaml) — optional, skip bridge if absent */
  whatsappAsToken?: pulumi.Output<string>;
  /** WhatsApp bridge homeserver token (from registration.yaml) — optional, skip bridge if absent */
  whatsappHsToken?: pulumi.Output<string>;
  /** Signal bridge appservice token (from registration.yaml) — optional, skip bridge if absent */
  signalAsToken?: pulumi.Output<string>;
  /** Signal bridge homeserver token (from registration.yaml) — optional, skip bridge if absent */
  signalHsToken?: pulumi.Output<string>;
}

export interface BridgeOutputs {
  /** In-cluster URL for mautrix-whatsapp management API (empty string if not deployed) */
  whatsappInClusterUrl: string;
  /** In-cluster URL for mautrix-signal management API (empty string if not deployed) */
  signalInClusterUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PART_OF = 'matrix-pipeline';
const WHATSAPP_PORT = 29318;   // port exposed by Service / nginx sidecar (Conduit connects here)
const SIGNAL_PORT = 29328;
const BRIDGE_PORT_OFFSET = 1;  // bridge listens on PORT+1; nginx rewrites auth and proxies

// ---------------------------------------------------------------------------
// Helper — shared bridge resources (SA, Secret, PVC, StatefulSet, Service)
// ---------------------------------------------------------------------------

interface SingleBridgeConfig {
  name: string;
  image: string;
  port: number;
  namespace: k8s.core.v1.Namespace;
  asToken?: pulumi.Output<string>;
  hsToken?: pulumi.Output<string>;
  conduitInClusterUrl: pulumi.Output<string>;
}

function deployBridge(cfg: SingleBridgeConfig): boolean {
  // Skip deployment if either token is missing — allows incremental bootstrap
  if (!cfg.asToken || !cfg.hsToken) {
    return false;
  }

  const ns = cfg.namespace;
  const nsName = ns.metadata.name;
  const labels: Record<string, string> = {
    'app.kubernetes.io/name': cfg.name,
    'app.kubernetes.io/part-of': PART_OF,
  };

  // ServiceAccount — automount disabled; bridges need no k8s API access
  const sa = new k8s.core.v1.ServiceAccount(
    `${cfg.name}-sa`,
    {
      metadata: {
        name: cfg.name,
        namespace: nsName,
        labels,
      },
      automountServiceAccountToken: false,
    },
    { dependsOn: [ns] },
  );

  const shortName = cfg.name === 'mautrix-whatsapp' ? 'whatsapp' : 'signal';
  const botUsername = `${shortName}bot`;
  const botDisplayname = cfg.name === 'mautrix-whatsapp' ? 'WhatsApp bridge bot' : 'Signal bridge bot';

  const bridgeInternalPort = cfg.port + BRIDGE_PORT_OFFSET;

  // nginx auth-proxy: rewrites Conduit's ?access_token= query param to the
  // Authorization: Bearer header expected by mautrix megabridge, and adds
  // WebSocket upgrade headers for the Signal provisioning flow.
  const nginxCm = new k8s.core.v1.ConfigMap(
    `${cfg.name}-nginx`,
    {
      metadata: {
        name: `${cfg.name}-nginx`,
        namespace: nsName,
        labels,
      },
      data: {
        'nginx.conf': `
events {}
http {
  server {
    listen ${cfg.port};
    location / {
      # Extract access_token query param and forward as Authorization header.
      # The bridge ignores the query param; Conduit sends it this way.
      set $token $arg_access_token;
      proxy_set_header Authorization "Bearer $token";
      proxy_pass http://127.0.0.1:${bridgeInternalPort};
      proxy_read_timeout 300s;

      # WebSocket support — required for the Signal provisioning/linking flow.
      # Without these headers nginx drops the Upgrade handshake and the QR
      # scan confirmation ("context canceled") never arrives.
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
    }
  }
}
`,
      },
    },
    { dependsOn: [ns] },
  );

  const configSecret = new k8s.core.v1.Secret(
    `${cfg.name}-config`,
    {
      metadata: {
        name: `${cfg.name}-config`,
        namespace: nsName,
        labels,
      },
      type: 'Opaque',
      stringData: {
        'config.yaml': pulumi.interpolate`
homeserver:
  address: ${cfg.conduitInClusterUrl}
  domain: matrix.no-panic.org
  software: standard

appservice:
  address: http://${cfg.name}.${nsName}.svc.cluster.local:${cfg.port}
  hostname: 0.0.0.0
  port: ${bridgeInternalPort}
  id: ${shortName}
  bot:
    username: ${botUsername}
    displayname: ${botDisplayname}
  ephemeral_events: true
  as_token: "${cfg.asToken}"
  hs_token: "${cfg.hsToken}"
  username_template: ${shortName}_{{.}}

database:
  type: sqlite3-fk-wal
  uri: file:/data/mautrix.db?_txlock=immediate

bridge:
  command_prefix: "!${shortName}"
  personal_filtering_spaces: true
  permissions:
    "*": relay
    "matrix.no-panic.org": user
    "@admin:matrix.no-panic.org": admin

encryption:
  allow: false
  default: false
  require: false

logging:
  min_level: debug
  writers:
    - type: stdout
      format: pretty-colored
`,
      },
    },
    { dependsOn: [ns] },
  );

  // PVC — bridge DB + media cache (longhorn-uncritical: non-critical, can be re-synced)
  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    `${cfg.name}-pvc`,
    {
      metadata: {
        name: `${cfg.name}-data`,
        namespace: nsName,
        labels,
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'longhorn-uncritical',
        resources: { requests: { storage: '2Gi' } },
      },
    },
    { dependsOn: [ns] },
  );

  // StatefulSet — mautrix bridges maintain local SQLite state
  new k8s.apps.v1.StatefulSet(
    `${cfg.name}-statefulset`,
    {
      metadata: {
        name: cfg.name,
        namespace: nsName,
        labels,
      },
      spec: {
        serviceName: cfg.name,
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': cfg.name } },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: cfg.name,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
            },
            containers: [
              {
                name: 'auth-proxy',
                image: 'nginx:1.27-alpine',
                imagePullPolicy: 'IfNotPresent',
                ports: [{ name: 'appservice', containerPort: cfg.port, protocol: 'TCP' }],
                resources: {
                  requests: { cpu: '5m', memory: '16Mi' },
                  limits: { cpu: '50m', memory: '32Mi' },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  runAsNonRoot: true,
                  runAsUser: 101,
                  readOnlyRootFilesystem: false,
                  seccompProfile: { type: 'RuntimeDefault' },
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: 'nginx-conf', mountPath: '/etc/nginx/nginx.conf', subPath: 'nginx.conf', readOnly: true },
                  { name: 'nginx-tmp', mountPath: '/tmp' },
                  { name: 'nginx-cache', mountPath: '/var/cache/nginx' },
                  { name: 'nginx-run', mountPath: '/var/run' },
                ],
                readinessProbe: {
                  tcpSocket: { port: cfg.port },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
              {
                name: 'bridge',
                image: cfg.image,
                imagePullPolicy: 'Always',
                // Sleep 5s so the nginx sidecar is up before Conduit sends the first startup ping.
                command: ['sh', '-c', `sleep 5 && exec /usr/bin/${cfg.name} --no-update -c /data/config.yaml`],
                ports: [{ name: 'bridge-internal', containerPort: bridgeInternalPort, protocol: 'TCP' }],
                resources: {
                  requests: { cpu: '50m', memory: '128Mi' },
                  limits: { cpu: '500m', memory: '512Mi' },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  runAsNonRoot: true,
                  readOnlyRootFilesystem: false,
                  seccompProfile: { type: 'RuntimeDefault' },
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: 'data', mountPath: '/data' },
                  { name: 'config', mountPath: '/data/config.yaml', subPath: 'config.yaml', readOnly: true },
                ],
                readinessProbe: {
                  httpGet: { path: '/_matrix/mau/ready', port: cfg.port },
                  initialDelaySeconds: 15,
                  periodSeconds: 15,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  httpGet: { path: '/_matrix/mau/live', port: cfg.port },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                  failureThreshold: 5,
                },
              },
            ],
            volumes: [
              {
                name: 'data',
                persistentVolumeClaim: { claimName: `${cfg.name}-data` },
              },
              {
                name: 'config',
                secret: { secretName: `${cfg.name}-config` },
              },
              {
                name: 'nginx-conf',
                configMap: { name: `${cfg.name}-nginx` },
              },
              { name: 'nginx-tmp', emptyDir: {} },
              { name: 'nginx-cache', emptyDir: {} },
              { name: 'nginx-run', emptyDir: {} },
            ],
          },
        },
      },
    },
    { dependsOn: [ns, sa, configSecret, nginxCm, pvc] },
  );

  // publishNotReadyAddresses: Conduit pings the bridge on startup before it is ready;
  // without this the Service has no endpoints and Conduit gets a 502.
  new k8s.core.v1.Service(
    `${cfg.name}-svc`,
    {
      metadata: {
        name: cfg.name,
        namespace: nsName,
        labels,
      },
      spec: {
        type: 'ClusterIP',
        selector: { 'app.kubernetes.io/name': cfg.name },
        publishNotReadyAddresses: true,
        ports: [
          {
            name: 'appservice',
            port: cfg.port,
            targetPort: cfg.port,
            protocol: 'TCP',
          },
        ],
      },
    },
    { dependsOn: [ns] },
  );

  return true;
}

// ---------------------------------------------------------------------------
// deployBridges — public entry point
// ---------------------------------------------------------------------------

/**
 * Deploys mautrix-whatsapp and mautrix-signal as StatefulSets in the matrix namespace.
 *
 * Both bridges are ClusterIP-only (no internet exposure needed — they connect outbound
 * to WhatsApp/Signal cloud services). Appservice tokens must be generated before Conduit
 * starts (see bootstrap order in architecture.md §7).
 *
 * mautrix-imessage is not supported — it requires a dedicated Mac app and is out of scope.
 */
export function deployBridges(args: BridgeArgs): BridgeOutputs {
  const nsName = args.namespace.metadata.name;

  const hasWhatsapp = deployBridge({
    name: 'mautrix-whatsapp',
    image: args.whatsappImage,
    port: WHATSAPP_PORT,
    namespace: args.namespace,
    asToken: args.whatsappAsToken,
    hsToken: args.whatsappHsToken,
    conduitInClusterUrl: args.conduitInClusterUrl,
  });

  const hasSignal = deployBridge({
    name: 'mautrix-signal',
    image: args.signalImage,
    port: SIGNAL_PORT,
    namespace: args.namespace,
    asToken: args.signalAsToken,
    hsToken: args.signalHsToken,
    conduitInClusterUrl: args.conduitInClusterUrl,
  });

  return {
    whatsappInClusterUrl: hasWhatsapp
      ? `http://mautrix-whatsapp.${nsName}.svc.cluster.local:${WHATSAPP_PORT}`
      : '',
    signalInClusterUrl: hasSignal
      ? `http://mautrix-signal.${nsName}.svc.cluster.local:${SIGNAL_PORT}`
      : '',
  };
}
