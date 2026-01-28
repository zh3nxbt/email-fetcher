// PM2 Ecosystem Configuration
// Usage: pm2 start ecosystem.config.cjs
//
// Note: Scheduled reports are handled by system cron (more reliable)
// Run: sudo ./scripts/setup-cron.sh to install cron jobs

module.exports = {
  apps: [
    {
      name: "mas-api",
      script: "npm",
      args: "start",
      cwd: "/var/www/email-fetcher",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        TZ: "America/New_York",
      },
      // Restart on failure
      max_restarts: 10,
      min_uptime: "10s",
      // Auto-restart on file changes (disable in production)
      watch: false,
      // Logging
      error_file: "/var/log/mas-api-error.log",
      out_file: "/var/log/mas-api-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // Memory limit - restart if exceeded
      max_memory_restart: "500M",
    },
  ],
};
