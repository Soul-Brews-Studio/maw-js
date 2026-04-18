# @maw-js/sdk

Stable typed API for [maw-js](https://github.com/Soul-Brews-Studio/maw-js) plugin authors — Multi-Agent Workflow orchestration in Bun/TS.

> **Alpha track.** API may change before 1.0.0. Pin an exact version.

## Install

```bash
bun add @maw-js/sdk
```

## Usage

### Authoring a plugin

```ts
import type { InvokeContext, InvokeResult } from "@maw-js/sdk/plugin";

export default async function (ctx: InvokeContext): Promise<InvokeResult> {
  return { ok: true, output: "hello from sdk" };
}
```

### Calling the host SDK

```ts
import { maw } from "@maw-js/sdk";

const id = await maw.identity();
console.log(id.node, id.version);

const fed = await maw.federation();
maw.print.kv("peers", String(fed.reachablePeers));
```

## API surface

- `maw.identity()` — node identity (name, version, agents, clock)
- `maw.federation()` — peers, latency, clock drift
- `maw.sessions(local?)` — local + federated tmux sessions
- `maw.feed(limit?)` — oracle feed events
- `maw.plugins()` — loaded plugin stats
- `maw.config()` — masked node config
- `maw.wake(target, task?)` / `maw.sleep(target)` — oracle lifecycle
- `maw.send(target, text)` — message an agent
- `maw.print` — colored terminal helpers
- `maw.baseUrl()` / `maw.fetch<T>(path, init?)` — typed HTTP to local maw serve

Types: `Identity`, `Peer`, `FederationStatus`, `Session`, `FeedEvent`, `PluginInfo`, `InvokeContext`, `InvokeResult`.

## License

BUSL-1.1 — see [LICENSE](./LICENSE). Change License: Apache-2.0 on 2040-04-07.

## Links

- Repo: https://github.com/Soul-Brews-Studio/maw-js
- Issues: https://github.com/Soul-Brews-Studio/maw-js/issues
