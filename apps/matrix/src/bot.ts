import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotArgs {
  /** Pre-created namespace resource */
  namespace: k8s.core.v1.Namespace;
  /** Bot container image */
  image: string;
  /** In-cluster URL of the Conduit homeserver */
  homeserverUrl: pulumi.Output<string>;
  /** Matrix user ID for the bot (e.g. @transcription-bot:matrix.<domain>) */
  botUserId: pulumi.Output<string>;
  /** whisper.cpp URL — defaults to http://flinker:8081 (node-local) */
  whisperUrl?: string;
  /** llama.cpp URL — defaults to http://flinker:8080/v1 */
  llmUrl?: string;
  /** LLM model name — defaults to "default" */
  llmModel?: string;
  /**
   * ESC key for the bot's Matrix access token.
   * Stored in Pulumi ESC (mrsimpson/homelab/dev) and synced via ExternalSecret.
   * Defaults to "matrix-bot-access-token".
   * The bot pod tolerates the secret being absent (optional: true) — it waits
   * in a sleep loop until the token is provisioned.
   */
  escBotTokenKey?: string;
}

export interface BotOutputs {
  /** Name of the bot k8s Deployment */
  deploymentName: pulumi.Output<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPONENT = 'transcription-bot';
const LABELS = {
  'app.kubernetes.io/name': COMPONENT,
  'app.kubernetes.io/part-of': 'matrix-pipeline',
};

// ---------------------------------------------------------------------------
// deployBot
// ---------------------------------------------------------------------------

/**
 * Deploys the voice-transcription-bot as a k8s Deployment.
 *
 * The bot is a regular Matrix user (not an appservice). It listens for m.audio events,
 * downloads the audio file, sends it to whisper.cpp (flinker:8081), and posts the
 * transcript back as a threaded reply.
 *
 * Bootstrap (one-time, after first Conduit deploy):
 *   1. Create bot user in the Conduit admin room: `create-user transcription-bot <password>`
 *   2. Get access token:
 *        curl -s https://matrix.no-panic.org/_matrix/client/v3/login \
 *          -H "Content-Type: application/json" \
 *          -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"transcription-bot"},"password":"<password>"}'
 *   3. Store in Pulumi ESC:
 *        pulumi env set mrsimpson/homelab/dev matrix-bot-access-token <access_token> --secret
 *   4. Force ESO sync (instead of waiting up to 1h):
 *        kubectl annotate externalsecret transcription-bot-credentials \
 *          force-sync="$(date +%s)" -n matrix --overwrite
 *   5. Restart bot pod: kubectl rollout restart deployment/transcription-bot -n matrix
 */
export function deployBot(args: BotArgs): BotOutputs {
  const ns = args.namespace;
  const nsName = ns.metadata.name;
  const whisperUrl = args.whisperUrl ?? 'http://flinker:8081';
  const llmUrl = args.llmUrl ?? 'http://flinker:8080/v1';
  const llmModel = args.llmModel ?? 'default';
  const escBotTokenKey = args.escBotTokenKey ?? 'matrix-bot-access-token';
  const credentialsSecretName = 'transcription-bot-credentials';

  // ServiceAccount — automount disabled; bot needs no k8s API access
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

  // PVC — matrix-nio session store (longhorn-uncritical)
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
        storageClassName: 'longhorn-uncritical',
        resources: { requests: { storage: '500Mi' } },
      },
    },
    { dependsOn: [ns] },
  );

  // ConfigMap — non-sensitive environment values
  const configMap = new k8s.core.v1.ConfigMap(
    `${COMPONENT}-config`,
    {
      metadata: {
        name: `${COMPONENT}-config`,
        namespace: nsName,
        labels: LABELS,
      },
      data: {
        MATRIX_HOMESERVER_URL: args.homeserverUrl,
        MATRIX_BOT_USER_ID: args.botUserId,
        WHISPER_URL: whisperUrl,
        LLM_URL: llmUrl,
        LLM_MODEL: llmModel,
        STORE_PATH: '/data/nio-store',
      },
    },
    { dependsOn: [ns] },
  );

  const externalSecret = new k8s.apiextensions.CustomResource(
    `${COMPONENT}-external-secret`,
    {
      apiVersion: 'external-secrets.io/v1beta1',
      kind: 'ExternalSecret',
      metadata: {
        name: credentialsSecretName,
        namespace: nsName,
        labels: LABELS,
      },
      spec: {
        refreshInterval: '1h',
        secretStoreRef: {
          name: 'pulumi-esc',
          kind: 'ClusterSecretStore',
        },
        target: {
          name: credentialsSecretName,
          creationPolicy: 'Owner',
        },
        data: [
          {
            secretKey: 'BOT_ACCESS_TOKEN',
            remoteRef: { key: escBotTokenKey },
          },
        ],
      },
    },
    { dependsOn: [ns] },
  );

  // Deployment — the bot is a long-running async client (no HTTP server)
  const deployment = new k8s.apps.v1.Deployment(
    `${COMPONENT}-deployment`,
    {
      metadata: {
        name: COMPONENT,
        namespace: nsName,
        labels: LABELS,
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': COMPONENT } },
        template: {
          metadata: { labels: LABELS },
          spec: {
            serviceAccountName: COMPONENT,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
            },
            // GHCR image pull secret — bot image is a private package on ghcr.io
            imagePullSecrets: [{ name: 'ghcr-pull-secret' }],
            containers: [
              {
                name: 'bot',
                image: args.image,
                imagePullPolicy: 'Always',
                resources: {
                  requests: { cpu: '50m', memory: '128Mi' },
                  limits: { cpu: '500m', memory: '512Mi' },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  runAsNonRoot: true,
                  readOnlyRootFilesystem: false, // matrix-nio writes session store
                  seccompProfile: { type: 'RuntimeDefault' },
                  capabilities: { drop: ['ALL'] },
                },
                envFrom: [
                  { configMapRef: { name: `${COMPONENT}-config` } },
                  // optional — pod starts before the token is provisioned; bot waits in a loop.
                  { secretRef: { name: 'transcription-bot-credentials', optional: true } },
                ],
                volumeMounts: [
                  { name: 'data', mountPath: '/data' },
                ],
              },
            ],
            volumes: [
              {
                name: 'data',
                persistentVolumeClaim: { claimName: `${COMPONENT}-data` },
              },
            ],
          },
        },
      },
    },
    { dependsOn: [ns, sa, pvc, configMap, externalSecret] },
  );

  return {
    deploymentName: deployment.metadata.name,
  };
}
