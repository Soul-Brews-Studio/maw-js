module.exports = {
  apps: [
    {
      name: 'maw',
      script: 'src/core/server.ts',
      interpreter: 'bun',                // PATH lookup — works on any host
      watch: false,                       // production: restart manual after deploy only
      max_restarts: 5,                    // fail-fast — no silent 542-restart loops
      restart_delay: 3000,
      env: {
        MAW_HOST: 'local',
        MAW_PORT: '3456',
      },
    },
    {
      name: 'maw-boot',
      // Launcher shim: PM2 wraps spawned processes with require-in-the-middle,
      // which sync-require()s the entry file. src/cli.ts is an ESM async module
      // (top-level await) → require() throws on Windows and some Linux setups:
      //
      //   TypeError: require() async module "...src/cli.ts" is unsupported.
      //   use "await import()" instead.
      //
      // The .cjs shim is require-safe and spawns bun via child_process,
      // bypassing the PM2 require hook entirely.
      // See scripts/maw-boot.launcher.cjs.
      script: 'scripts/maw-boot.launcher.cjs',
      args: ['wake', 'all', '--resume'],
      interpreter: 'node',
      // One-shot: spawn fleet after server starts, don't restart
      autorestart: false,
      // Give maw server time to come up
      restart_delay: 5000,
    },
    // maw-dev moved to Soul-Brews-Studio/maw-ui (bun run dev)
    // maw-broker removed — MQTT layer deleted in 3b71daa (WebSocket handles broadcast)
  ],
};
