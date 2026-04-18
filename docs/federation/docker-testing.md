# Federation testing in Docker

Reproduce a GitHub-Actions-like environment locally: two maw-js
containers on a shared Docker network, handshaking as peers.

## Why this exists

Peer handshake bugs only surface across real network boundaries — on a
single host everything talks via `localhost` and subtle URL / DNS /
CORS issues hide. Running two containers behind Docker's internal DNS
gives us a cheap, reproducible 2-node cluster that mirrors what CI and
production peer pairs actually see.

## Run it locally

```bash
# One-shot: build + up + probe + teardown
bash scripts/test-docker-federation.sh

# Or step-through (leaves containers running):
bash scripts/dev-federation.sh up
docker compose -f docker/compose.yml exec node-a maw peers probe peer
docker compose -f docker/compose.yml exec node-b maw peers probe peer
bash scripts/dev-federation.sh down
```

Requires Docker Engine 24+ and `docker compose` v2.

## Expected output

```
## Docker federation probe result
a → b: PASS, code: 0, hint: -
b → a: PASS, code: 0, hint: -
```

The script exits `0` only if both probe calls exit `0` **and** the
output contains no `handshake failed` substring. Any other shape is a
regression.

## Debugging failures

1. Re-run with the stack left up: `bash scripts/dev-federation.sh up`
2. Shell into a node: `docker compose -f docker/compose.yml exec node-a sh`
3. Inspect logs: `docker compose -f docker/compose.yml logs node-a node-b`
4. Check healthchecks: `docker compose -f docker/compose.yml ps`
5. Manual probe inside a node: `maw peers probe peer`

On CI, the `Federation (Docker) integration` workflow uploads compose
logs as a `federation-docker-logs` artifact when the job fails.

## Known gaps

- `maw-js` does not yet register a `/info` endpoint, so
  `src/commands/plugins/peers/probe.ts` will surface `HTTP_4XX` against
  any currently-built image. The probe round-trip is still useful for
  catching transport / DNS / compose-wiring regressions, but the
  handshake classifier will stay red until `/info` lands.
  Tracking: <TODO: link issue #N once tester files it>.

## Related

- `docker/Dockerfile` — the `maw-js:test` image (single-stage, bun-alpine)
- `docker/compose.yml` — 2-node wiring with mutual `PEER_URL`s
- `scripts/dev-federation.sh` — local up/down helper
- `scripts/test-docker-federation.sh` — end-to-end probe driver
- `.github/workflows/federation-docker.yml` — CI wrapper
