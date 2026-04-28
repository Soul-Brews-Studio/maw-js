# Self-hosted runner — federation + flake cross-check

Operator guide for the runner host that powers
`.github/workflows/federation-self-hosted.yml` (issue #763).

## What this runner does

It exercises two things that GitHub-hosted runners cannot do well:

1. **Federation tests** that need a real peer / real network stack
   (`test/federation-*.test.ts`, `test/integration/federation-local.test.ts`,
   `test/integration/search-peers-2port.test.ts`).
2. **Cross-check** the 14 known-flaky tests in `test/curl-fetch.test.ts`
   (6) and `test/build-command-cwd.test.ts` (8) that were marked
   environment-specific in #786 — if they pass on a real Linux host,
   we know the failure is a GH-Actions sandbox quirk.

Existing GH-hosted CI (`.github/workflows/ci.yml`) keeps running on every
PR and push; this workflow is purely additive.

## SECURITY WARNING — read first

`Soul-Brews-Studio/maw-js` is a **public repository**. GitHub explicitly
warns against attaching self-hosted runners to public repos:

> We recommend that you only use self-hosted runners with private
> repositories. This is because forks of your public repository can
> potentially run dangerous code on your self-hosted runner machine
> by creating a pull request that executes the code in a workflow.

The workflow is therefore restricted to `push` to `main` only. **Do
not** add `pull_request` triggers without an explicit guard like:

```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
```

Additionally, in repo Settings → Actions → General, enable:

- **Fork pull request workflows from outside collaborators** →
  *Require approval for all outside collaborators* (or stricter).
- **Allow GitHub Actions to create and approve pull requests** → off.

## Required runner labels

The workflow targets `runs-on: [self-hosted, federation]`. The runner
must be registered with **both** labels — `self-hosted` is added by
the runner installer, `federation` must be added explicitly (see below).

## Operator setup

### 1. Pick a host

Candidates from the fleet (#763 reporter notes):

- `m5` — already runs maw federation, has spare cycles.
- `white` — primary maw-js code partner, more agents.

Either works. Pick whichever has best uptime + spare CPU/RAM. The host
needs:

- Linux (Ubuntu 22.04+ or similar) or macOS.
- `bun` on PATH (1.3.13+ to match `ci.yml`).
- `/usr/bin/curl` present (the `curl-fetch` tests probe this exact path).
- `git` on PATH.
- Outbound HTTPS to `github.com` and `objects.githubusercontent.com`.
- If federation tests are extended to real fleet peers: SSH keys for
  the peer hosts (`mba.wg`, `oracle-world`, etc.) configured for the
  runner user.

### 2. Register the runner

#### Option A — manual `actions-runner` binary (recommended for one host)

```bash
# On the runner host:
mkdir -p ~/actions-runner && cd ~/actions-runner
# Get the latest from
# https://github.com/actions/runner/releases
curl -O -L https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-x64-2.319.1.tar.gz
tar xzf actions-runner-linux-x64-2.319.1.tar.gz

# Generate a registration token from the repo:
#   gh api -X POST repos/Soul-Brews-Studio/maw-js/actions/runners/registration-token
# or via the UI: Settings → Actions → Runners → New self-hosted runner

./config.sh \
  --url https://github.com/Soul-Brews-Studio/maw-js \
  --token <REG_TOKEN> \
  --labels self-hosted,federation \
  --name fed-runner-$(hostname -s) \
  --unattended

# Run as a service (Linux):
sudo ./svc.sh install
sudo ./svc.sh start
```

Verify the runner appears in
`https://github.com/Soul-Brews-Studio/maw-js/settings/actions/runners`
with **both** `self-hosted` and `federation` labels.

#### Option B — `actions-runner-controller` (Kubernetes)

Use [actions-runner-controller](https://github.com/actions/actions-runner-controller)
if the fleet already runs k8s. Define a `RunnerDeployment` (or
`AutoscalingRunnerSet` with the newer `gha-runner-scale-set` chart)
with `labels: [self-hosted, federation]` and the same Bun + curl
prerequisites baked into the runner image.

### 3. Sanity check

Push any no-op commit to `main` and watch the workflow at
`https://github.com/Soul-Brews-Studio/maw-js/actions/workflows/federation-self-hosted.yml`.
The first step (`Show runner identity`) prints `bun:` and `curl:` paths
— if either is `MISSING`, fix the host before debugging anything else.

## Operating notes

- **One job at a time.** `concurrency.group: federation-self-hosted`
  serializes runs so port-binding tests don't race each other.
- **`MAW_SKIP_FLAKY` is intentionally unset.** This runner is the one
  place in CI that exercises the real path; setting it would defeat
  the purpose.
- **Failure logs.** The `Federation log dump on failure` step prints
  recent `~/.maw/logs` and open ports for triage.
- **Runner host is not ephemeral.** Unlike GH-hosted runners, state
  persists between jobs. If a federation test leaks a process or port
  it may affect the next run — check `ps`, `ss -tlnp`, and clean up
  in the test's `afterAll`.

## Decommissioning

```bash
cd ~/actions-runner
sudo ./svc.sh stop
sudo ./svc.sh uninstall
./config.sh remove --token <REMOVAL_TOKEN>
```

Removal token: `gh api -X POST repos/Soul-Brews-Studio/maw-js/actions/runners/remove-token`.
