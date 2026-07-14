// PM2 process config for the WhatsApp backend (production, Windows server).
// Usage (from the backend/ folder, after `npm run build`):
//   pm2 start ecosystem.config.cjs
//   pm2 save
// Env comes from ./.env (loaded by dotenv in src/config.ts) — keep it beside
// this file. Prefer NSSM for boot-persistence on Windows (see DEPLOYMENT.md);
// this file is the alternative for teams that prefer PM2's DX.
module.exports = {
  apps: [
    {
      name: 'wpp-backend',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // WPPConnect owns a single Chromium — never cluster it.
      autorestart: true,
      max_restarts: 20,
      restart_delay: 4000,
      // Safety valve for a leak only — Chromium legitimately uses several hundred MB.
      max_memory_restart: '2G',
      env: { NODE_ENV: 'production' },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
