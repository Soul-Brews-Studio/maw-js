module.exports = {
  apps: [
    {
      name: 'maw-js',
      script: 'src/server.ts',
      interpreter: '/home/lfz/.bun/bin/bun',
      // Watch intentionally disabled. Bastion ran the runtime disable at
      // deploy time via `pm2 restart maw-js --watch false` (see
      // sofia-reply-bastion-watch-disable.md). This config-level false
      // makes the disable durable across `pm2 reload ecosystem.config.cjs`,
      // which would otherwise re-enable watch from the previous `watch:
      // ['src']` declaration. To re-enable locally for development, set
      // watch: ['src'] temporarily — do not commit that.
      watch: false,
      env: {
        MAW_HOST: 'local',
        MAW_PORT: '3456',
      },
    },
    {
      name: 'maw-boot',
      script: 'src/cli.ts',
      args: 'wake all --resume',
      interpreter: '/home/lfz/.bun/bin/bun',
      // One-shot: spawn fleet after server starts, don't restart
      autorestart: false,
      // Give maw server time to come up
      restart_delay: 5000,
    },
    // maw-dev moved to Soul-Brews-Studio/maw-ui (bun run dev)
    {
      name: 'maw-broker',
      script: 'src/broker.ts',
      interpreter: '/home/lfz/.bun/bin/bun',
      autorestart: true,
      watch: false,
      env: {
        MAW_BROKER: '1',
      },
    },
  ],
};
