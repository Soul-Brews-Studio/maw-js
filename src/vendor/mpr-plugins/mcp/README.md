# maw mcp — stdio MCP server

`maw mcp` (alias `maw mcp serve`) launches a long-lived **stdio** MCP server so
Claude Code can call maw verbs as first-class MCP tools instead of shelling out.

Each tool spawns the real `maw <verb> ...` subprocess and relays its output.
Identity / Rule-6 signing happen inside `maw` — this layer only relays.

## Register in `~/.claude.json`

Add under `mcpServers` (root-level for user-scoped, or per-project):

```json
{
  "mcpServers": {
    "maw": {
      "command": "maw",
      "args": ["mcp"]
    }
  }
}
```

Requires `maw` on `PATH` (it is installed as a bin). One step — no other config.

## Tools

| Tool | maw command |
|------|-------------|
| `maw_hey(target, message)` | `maw hey <target> <message>` |
| `maw_reply(correlationId, message)` | `maw reply <correlationId> <message>` |
| `maw_inbox(action, id?)` | `maw inbox status` \| `maw inbox list` \| `maw inbox read <id>` |
| `maw_ls(verbose?)` | `maw ls` \| `maw ls -v` |
| `maw_company(action, company?, dept?)` | `maw company ls` \| `maw company tree [company]` \| `maw company attach <company> <dept>` |
| `maw_dept(action, company?, dept?, oracle?, role?, text?)` | `maw dept assign <company> <dept> <oracle> [--role <role>]` \| `maw dept members <company> <dept>` \| `maw dept learn <company> <dept> "<text>"` \| `maw dept knowledge <company> <dept> [text]` |

## Notes

- **stdout is the MCP JSON-RPC channel.** All logging goes to stderr; tool
  subprocesses pipe their own stdout (never inherit).
- **Best-effort errors:** a non-zero `maw` exit (or `maw` missing) returns a
  clear MCP error result — it never throws/crashes the server.
