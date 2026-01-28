#!/bin/bash
# Run report with proper timezone handling and failure notifications
# Usage: ./run-report.sh [morning|daily]

# Set timezone to EST/EDT (handles daylight saving automatically)
export TZ="America/New_York"

# Change to app directory
SCRIPT_DIR="$(dirname "$0")"
cd "$SCRIPT_DIR/.."

# Load environment
set -a
source .env
set +a

REPORT_TYPE="${1:-daily}"
LOG_FILE="/var/log/mas-report-${REPORT_TYPE}.log"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S %Z")

# Function to send failure notification
send_failure_email() {
    local error_msg="$1"
    local subject="[ALERT] MAS Report Failed: ${REPORT_TYPE} - ${TIMESTAMP}"
    local body="The ${REPORT_TYPE} report failed at ${TIMESTAMP}.

Error:
${error_msg}

Server: $(hostname)
Log file: ${LOG_FILE}

Please check the logs for more details."

    # Use the app's email sender via a simple node script
    node -e "
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false }
});
transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: process.env.REPORT_RECIPIENT,
    subject: '${subject}',
    text: \`${body}\`
}).then(() => console.log('Failure notification sent'))
  .catch(e => console.error('Failed to send notification:', e.message));
"
}

# Log start
echo "========================================" >> "$LOG_FILE"
echo "${TIMESTAMP}: Starting ${REPORT_TYPE} report" >> "$LOG_FILE"

# Capture output and errors
{
    # Sync emails first
    echo "Syncing emails..."
    npm run sync

    # Run appropriate report
    if [ "$REPORT_TYPE" = "morning" ]; then
        echo "Generating morning report..."
        npm run report:morning
    else
        echo "Generating daily summary..."
        npm run report
    fi

    echo "${TIMESTAMP}: Report complete"

} >> "$LOG_FILE" 2>&1

# Check exit status
if [ $? -ne 0 ]; then
    ERROR_MSG=$(tail -20 "$LOG_FILE")
    echo "$(date "+%Y-%m-%d %H:%M:%S %Z"): FAILED" >> "$LOG_FILE"
    send_failure_email "$ERROR_MSG"
    exit 1
fi

echo "$(date "+%Y-%m-%d %H:%M:%S %Z"): SUCCESS" >> "$LOG_FILE"
