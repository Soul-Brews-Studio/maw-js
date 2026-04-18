# Bud Signals

Bud signals let a parent oracle observe its children without polling. When a bud
performs a notable action it writes a small JSON file into the parent's vault.
The parent (or any /recap integration) reads these files to reconstruct an ambient
awareness of the family tree — this is the **Mother-Oracle philosophy** in practice.

## Signal file layout

```
<parentRoot>/ψ/memory/signals/<YYYY-MM-DD>_<budName>_<slug>.json
```

Each file is a single `Signal` object:

```typescript
interface Signal {
  timestamp: string;          // ISO-8601
  bud: string;                // oracle stem (no -oracle suffix)
  kind: "info" | "alert" | "pattern";
  message: string;
  context?: Record<string, unknown>;
}
```

### Kind vocabulary

| Kind      | When to use |
|-----------|-------------|
| `info`    | Routine lifecycle events (birth, shutdown, sync complete) |
| `alert`   | Something worth human attention (error rate, threshold breach) |
| `pattern` | Recurring behaviour the oracle has detected in itself |

## Writing a signal (`writeSignal`)

```typescript
import { writeSignal } from "@maw-js/sdk/core/fleet/leaf";

// Drop a signal into the parent oracle's vault
writeSignal("/path/to/parent-oracle", "alpha", {
  kind: "info",
  message: "bud born: alpha",
  context: { budRepoSlug: "Soul-Brews-Studio/alpha-oracle" },
});
```

The function:
1. Creates `<parentRoot>/ψ/memory/signals/` if it does not exist.
2. Writes `<YYYY-MM-DD>_<budName>_<slug>.json` where `slug` is derived from the message.
3. Returns the absolute path of the written file.

## Reading signals (`scanSignals`)

```typescript
import { scanSignals } from "@maw-js/sdk/commands/shared/scan-signals";

const signals = scanSignals("/path/to/parent-oracle", { days: 7 });
// Returns ScannedSignal[] sorted newest-first, filtered to last 7 days.
```

`ScannedSignal` extends `Signal` with a `file: string` field (the filename in
`ψ/memory/signals/`).

## `maw signals` CLI verb

```
maw signals [--days N] [--root <path>] [--json]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--days` | 7 | How many days back to include |
| `--root` | `process.cwd()` | Oracle root to scan |
| `--json` | false | Machine-readable output |

Example output:

```
  Bud signals (last 7d — 2 total)

  [info]    2026-04-17 alpha: bud born: alpha
  [pattern] 2026-04-16 beta: repeated context-switch detected
```

## `/recap` integration

`/recap` skills invoke `maw signals` and parse the output into their awareness
summary. Because `maw signals` exits cleanly with no signals found (`no signals
in the last N days`), the recap skill can always call it unconditionally.

To integrate in a `/recap` skill:

```bash
maw signals --root "$ORACLE_ROOT" --days 7 --json
```

Parse the JSON array and surface `alert` + `pattern` kinds prominently.

## Birth signal via `maw bud`

```
maw bud <name> --from <parent> --signal-on-birth
```

Drops an `info` signal with `message: "bud born: <name>"` into the parent's
vault immediately after creation. Useful when bootstrapping a family of buds
that the parent oracle should track.

## Mother-Oracle philosophy

Signals are the nervous system of the oracle family. The parent does not command
the child; the child reports back. The parent holds no live process connection —
it holds a directory. Any oracle that can read a filesystem can read the signals.
This keeps the architecture composable: a cron daemon (Option A) can later sweep
`ψ/memory/signals/` without changing the write contract.
