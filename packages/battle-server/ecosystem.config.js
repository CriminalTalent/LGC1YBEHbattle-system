/**
 * PYXIS Battle System - PM2 통합 설정 (ESM)
 */
const config = {
  apps: [
    {
      name: 'pyxis-battle-system',
      cwd: '/root/battle-system',
      script: 'packages/battle-server/index.js',
      exec_mode: 'fork',
      instances: 1,

      watch: false,
      autorestart: true,
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 500,
      kill_timeout: 15000,
      listen_timeout: 10000,
      max_memory_restart: '1G',

      node_args: [
        '--max-old-space-size=1024',
        '--optimize-for-size',
        '--enable-source-maps'
      ],

      env_file: '/root/battle-system/.env',

      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: '/root/battle-system/logs/out.log',
      error_file: '/root/battle-system/logs/error.log',
      pid_file: '/root/battle-system/logs/battle-system.pid',

      ignore_watch: [
        'node_modules',
        'logs',
        'uploads',
        'packages/battle-server/public/uploads',
        '.git',
        '*.log'
      ],

      vizion: false,
      source_map_support: true,
      instance_var: 'INSTANCE_ID',

      cron_restart: '0 2 * * *',

      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 3001,
        CORS_ORIGIN: 'https://pyxisbattlesystem.monster,http://65.21.147.119:3001,*',
        LOG_LEVEL: 'info'
      },

      env_development: {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: 3001,
        CORS_ORIGIN: 'http://localhost:3000,http://127.0.0.1:3000',
        LOG_LEVEL: 'debug'
      },

      env_production: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 3001,
        CORS_ORIGIN: 'https://pyxisbattlesystem.monster,http://65.21.147.119:3001',
        LOG_LEVEL: 'info'
      }
    }
  ],

  deploy: {
    production: {
      user: 'root',
      host: ['65.21.147.119'],
      ref: 'origin/main',
      repo: 'git@github.com:CriminalTalent/battle-system.git',
      path: '/root/battle-system',

      'pre-deploy-local': '',

      'post-deploy': [
        'mkdir -p /root/battle-system/logs',
        'mkdir -p /root/battle-system/uploads',
        'mkdir -p /root/battle-system/current/packages/battle-server/public/uploads/avatars || true',
        'cd /root/battle-system/current && npm ci --omit=dev',
        'cd /root/battle-system/current/packages/battle-server && npm ci --omit=dev',
        'pm2 startOrReload /root/battle-system/current/packages/battle-server/ecosystem.config.js --env production',
        'pm2 save'
      ].join(' && '),

      'pre-setup': ''
    }
  }
};

export default config;
