# Manual Testing Runbook: Matrix Voice-Transcription Pipeline

This runbook provides step-by-step commands to verify each component of the
Matrix pipeline after deployment.

---

## Pre-Deployment Checks

Run these before `pulumi up` to catch configuration issues early.

### 1. Verify whisper.cpp is running on flinker

```bash
# From any machine with SSH access to flinker
ssh flinker 'curl -s http://localhost:8081/docs | head -5'

# Expected: HTML or JSON from whisper.cpp (not a connection refused)
```

### 2. Verify Cloudflare Tunnel is healthy

```bash
kubectl get pods -n cloudflared
# Expected: cloudflared pod(s) in Running state

# Verify the tunnel DNS entry resolves
dig +short matrix.<your-domain>
# Expected: CNAME pointing to your tunnel hostname
```

### 3. Verify required secrets exist

```bash
cd apps/matrix

# Check that all required secrets are set
pulumi config --cwd apps/matrix

# Verify these secrets exist (values hidden):
#   matrix:conduitAdminToken
#   matrix:whatsappAsToken
#   matrix:whatsappHsToken
#   matrix:signalAsToken
#   matrix:signalHsToken
```

### 4. Verify appservice registration secrets are created

```bash
kubectl get secrets -n matrix | grep conduit-appservice
# Expected:
#   conduit-appservice-whatsapp
#   conduit-appservice-signal

```

---

## Deployment Verification

### Step 1: Run Pulumi preview

```bash
cd apps/matrix
pulumi preview
```

**Expected:** No errors. Preview shows:
- Namespace `matrix`
- Conduit StatefulSet + Service + IngressRoute
- mautrix-whatsapp StatefulSet + Service
- mautrix-signal StatefulSet + Service
- transcription-bot Deployment + Service

### Step 2: Deploy the stack

```bash
pulumi up
```

**Expected:** All resources created successfully. No replacement warnings for
Conduit (which would indicate a `server_name` change — **dangerous**).

### Step 3: Verify all pods are running

```bash
kubectl get pods -n matrix

# Expected (after ~2 minutes):
# NAME                              READY   STATUS
# conduit-0                         1/1     Running
# mautrix-whatsapp-0                1/1     Running
# mautrix-signal-0                  1/1     Running
# transcription-bot-...             1/1     Running
```

### Step 4: Verify Conduit is accessible

```bash
# From inside the cluster
kubectl run test --rm -i --restart=Never --image=curlimages/curl:latest \
  -- http://conduit.matrix.svc.cluster.local:6167/_matrix/client/versions

# Expected: JSON with {"versions": [...]}
```

### Step 5: Verify Conduit is accessible from the internet

```bash
# From your local machine
curl -s https://matrix.<your-domain>/_matrix/client/versions | jq

# Expected: Same JSON as above
```

---

## Per-Component Verification

### Conduit Homeserver

```bash
# Check logs for errors
kubectl logs -n matrix deployment/conduit --tail=50

# Verify Conduit registered the appservices
kubectl logs -n matrix deployment/conduit | grep -i "appservice"

# Expected: "Registered appservice: whatsapp", "Registered appservice: signal", etc.
```

### mautrix-whatsapp

```bash
# Check bridge logs
kubectl logs -n matrix statefulset/mautrix-whatsapp --tail=50

# Verify bridge connected to Conduit
kubectl logs -n matrix statefulset/mautrix-whatsapp | grep -i "connected"

# Expected: "Connected to Conduit" or similar
```

### mautrix-signal

```bash
# Check bridge logs
kubectl logs -n matrix statefulset/mautrix-signal --tail=50

# Verify bridge connected to Conduit
kubectl logs -n matrix statefulset/mautrix-signal | grep -i "connected"
```

### transcription-bot

```bash
# Check bot logs
kubectl logs -n matrix deployment/transcription-bot --tail=50

# If bot hasn't started yet (waiting for access token), you'll see:
#   {"config_error": "Required environment variable 'BOT_ACCESS_TOKEN' is not set"}
# This is expected until you complete the bootstrap step below.
```

---

## Bot Bootstrap (Post-Deployment)

The bot user must be registered manually after Conduit is running.

### Step 1: Access Conduit admin room

```bash
# Port-forward Conduit to your local machine
kubectl port-forward -n matrix svc/conduit 6167:6167

# In a separate terminal, use the admin token to create the bot user
# The admin API is via the Conduit admin room (room ID is in Conduit logs)
```

### Step 2: Create bot user and get access token

```bash
# Option A: Use curl against the admin API
# First, find the admin room ID from Conduit logs:
kubectl logs -n matrix deployment/conduit | grep "admin room"

# Then register the bot user
curl -X POST "http://localhost:6167/_matrix/client/r0/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "transcription-bot",
    "password": "<temporary-password>",
    "type": "m.login.password"
  }'

# Then log in as the bot to get an access token
curl -X POST "http://localhost:6167/_matrix/client/r0/login" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "m.login.password",
    "user": "transcription-bot",
    "password": "<temporary-password>"
  }'

# Save the access_token from the response
```

### Step 3: Create the k8s Secret

```bash
kubectl create secret -n matrix generic transcription-bot-credentials \
  --from-literal=BOT_ACCESS_TOKEN="<access-token-from-step-2>"
```

### Step 4: Restart the bot pod

```bash
kubectl rollout restart deployment/transcription-bot -n matrix
```

### Step 5: Verify bot is authenticated

```bash
# Wait 10 seconds, then check logs
kubectl logs -n matrix deployment/transcription-bot --tail=20

# Expected:
#   {"event": "authenticated", "user_id": "@transcription-bot:matrix.<domain>"}
#   {"event": "starting_sync", "homeserver": "http://conduit.matrix.svc.cluster.local:6167"}
```

---

## End-to-End Test: Voice Message Transcription

### Test 1: WhatsApp voice message

1. Open WhatsApp on your phone
2. Send a voice message to any contact (or to yourself)
3. Wait 30–60 seconds
4. Open Element app on your phone
5. Navigate to the bridged WhatsApp room
6. **Expected:** You see:
   - The original voice message (from the bridge)
   - A threaded reply from `@transcription-bot` containing the transcript

### Test 2: Verify transcript accuracy

1. Listen to the original voice message
2. Compare with the bot's transcript
3. **Expected:** The transcript is reasonably accurate (whisper.cpp `small` model
   is ~85–90% accurate for clear speech)

### Test 3: Check bot logs for the flow

```bash
kubectl logs -n matrix deployment/transcription-bot | jq -C '. | select(.event)'

# Expected flow of events:
#   {"event": "audio_received", ...}
#   {"event": "transcribed", "chars": 123}
#   {"event": "reply_sent", ...}
```

### Test 4: Whisper.cpp direct test (bypass Matrix)

If the bot isn't working, test whisper.cpp directly:

```bash
# Copy an audio file to flinker
scp test-audio.ogg flinker:/tmp/

# Test whisper.cpp directly
ssh flinker 'curl -s http://localhost:8081/inference \
  -F file=@/tmp/test-audio.ogg \
  -F temperature=0.0 \
  -F response_format=json | jq .text'

# Expected: Transcript text
```

---

## Signal Bridge Test

1. Send a voice message via Signal
2. Check the bridged Signal room in Element
3. **Expected:** Transcript reply appears

---

## Troubleshooting Common Issues

### Bot not responding

```bash
# Check if bot crashed (missing access token)
kubectl logs -n matrix deployment/transcription-bot | tail -20

# Check if bot is syncing
kubectl logs -n matrix deployment/transcription-bot | grep "sync"

# Verify bot can reach Conduit
kubectl exec -n matrix deployment/transcription-bot -- \
  python -c "import urllib.request; print(urllib.request.urlopen('http://conduit.matrix.svc.cluster.local:6167/_matrix/client/versions').read())"
```

### Transcription not appearing

```bash
# Check if whisper.cpp is reachable from the bot pod
kubectl exec -n matrix deployment/transcription-bot -- \
  python -c "import urllib.request; print(urllib.request.urlopen('http://flinker:8081/docs').read()[:100])"

# If this fails, whisper.cpp may not be running on flinker:8081
ssh flinker 'systemctl status whisper-cpp'  # or however it's managed
```

### Bridge not connecting

```bash
# Check bridge logs for registration errors
kubectl logs -n matrix statefulset/mautrix-whatsapp | grep -i "error\|fail"

# Verify the appservice Secret is mounted in Conduit
kubectl exec -n matrix deployment/conduit -- ls /var/lib/conduit/appservices/whatsapp/

# Expected: registration.yaml
```

---

## Cleanup After Testing

If you created test users or rooms during testing, clean them up:

```bash
# Delete test messages (optional — Conduit does not auto-purge)
# The bot's session store is persisted to PVC and will survive restarts
```

---

## Success Criteria

All of the following must pass for the deployment to be considered verified:

- [ ] Conduit responds to `/_matrix/client/versions` both internally and externally
- [ ] mautrix-whatsapp logs show "Connected to Conduit"
- [ ] mautrix-signal logs show "Connected to Conduit"
- [ ] Bot logs show "authenticated" and "starting_sync"
- [ ] Sending a WhatsApp voice message produces a transcript reply in Element within 60 seconds
- [ ] Bot logs show the full event flow (audio_received → transcribed → reply_sent)
