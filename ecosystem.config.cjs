require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'maw',
      script: 'src/server.ts',
      interpreter: '/root/.bun/bin/bun',
      watch: ['src'],
      watch_delay: 500,
      ignore_watch: ['node_modules', 'ui'],
      env: {
        MAW_HOST: 'local',
        MAW_PORT: '3456',
        PULSE_WEBHOOK_URL: process.env.PULSE_WEBHOOK_URL,
        DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
        DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
        DISCORD_CHAT_WEBHOOK_URL: process.env.DISCORD_CHAT_WEBHOOK_URL,
      },
    },
    {
      name: 'maw-boot',
      script: 'src/cli.ts',
      args: 'wake all --resume',
      interpreter: '/root/.bun/bin/bun',
      // One-shot: spawn fleet after server starts, don't restart
      autorestart: false,
      // Give maw server time to come up
      restart_delay: 5000,
    },
    // maw-dev moved to Soul-Brews-Studio/maw-ui (bun run dev)
    {
      name: 'maw-broker',
      script: 'src/broker.ts',
      cwd: '/root/projects/maw-js',
      interpreter: '/root/.bun/bin/bun',
      autorestart: true,
      watch: false,
      env: {
        MAW_BROKER: '1',
      },
    },
  ],
};
