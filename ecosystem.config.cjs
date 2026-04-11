module.exports = {
  apps: [
    {
      name: 'maw',
      script: 'src/server.ts',
      interpreter: '/home/nat/.bun/bin/bun',
      watch: ['src'],
      watch_delay: 500,
      ignore_watch: ['node_modules', 'ui'],
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
    {
      name: 'maw-broker',
      script: 'src/broker.ts',
      interpreter: '/home/nat/.bun/bin/bun',
      autorestart: true,
      watch: false,
      env: {
        MAW_BROKER: '1',
      },
    },
  ],
};
