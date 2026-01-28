#!/bin/bash
# Setup cron jobs for MAS report scheduler
# Run this once during deployment: sudo ./scripts/setup-cron.sh

set -e

APP_DIR="/var/www/email-fetcher"
LOG_DIR="/var/log"
CRON_FILE="/etc/cron.d/mas-reports"

# Create log files with proper permissions
sudo touch "$LOG_DIR/mas-report-morning.log"
sudo touch "$LOG_DIR/mas-report-daily.log"
sudo chmod 666 "$LOG_DIR/mas-report-morning.log"
sudo chmod 666 "$LOG_DIR/mas-report-daily.log"

# Create cron file
# Note: Cron uses system timezone (set to America/New_York in server setup)
sudo tee "$CRON_FILE" > /dev/null << EOF
# MAS Precision Parts - Report Scheduler
# Timezone: America/New_York (set via timedatectl)
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
TZ=America/New_York

# 7:00 AM EST/EDT - Morning reminder report
0 7 * * * root cd $APP_DIR && ./scripts/run-report.sh morning

# 4:00 PM EST/EDT - Daily summary report
0 16 * * * root cd $APP_DIR && ./scripts/run-report.sh daily
EOF

# Set permissions
sudo chmod 644 "$CRON_FILE"

# Restart cron to pick up changes
sudo systemctl restart cron

echo "Cron jobs installed successfully!"
echo ""
echo "Scheduled reports:"
echo "  - 7:00 AM EST/EDT: Morning reminder"
echo "  - 4:00 PM EST/EDT: Daily summary"
echo ""
echo "View cron jobs: cat $CRON_FILE"
echo "View logs: tail -f $LOG_DIR/mas-report-*.log"
