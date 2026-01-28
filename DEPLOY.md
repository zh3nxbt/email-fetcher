# Ubuntu VPS Deployment Guide

## Prerequisites

- Ubuntu 22.04+ VPS
- Node.js 20+ installed
- PostgreSQL database (can be external like Supabase/Neon)

## 1. Initial Server Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Set server timezone to EST
sudo timedatectl set-timezone America/New_York
```

## 2. Deploy Application

```bash
# Create app directory
sudo mkdir -p /var/www/email-fetcher
sudo chown $USER:$USER /var/www/email-fetcher

# Clone or copy your code
cd /var/www/email-fetcher
git clone <your-repo-url> .
# Or scp/rsync from local machine

# Install dependencies
npm install

# Create .env file
cp .env.example .env
nano .env  # Edit with your credentials
```

## 3. Environment Variables (.env)

```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# IMAP
IMAP_HOST=mail.masprecisionparts.com
IMAP_PORT=993
IMAP_USER=sales@masprecisionparts.com
IMAP_PASS=your-password

# SMTP
SMTP_HOST=smtp.masprecisionparts.com
SMTP_PORT=587
SMTP_USER=reports@masprecisionparts.com
SMTP_PASS=your-password
SMTP_FROM="MAS Reports <reports@masprecisionparts.com>"

# Reports
REPORT_TIMEZONE=America/New_York
REPORT_RECIPIENT=evgeni@masprecisionparts.com

# AI
ANTHROPIC_API_KEY=sk-ant-...
```

## 4. Build and Initialize

```bash
# Build Next.js
npm run build

# Push database schema (first time only)
npm run db:push

# Test that everything works
npm run sync
npm run report -- --preview
```

## 5. Start API Server with PM2

```bash
# Make scripts executable
chmod +x scripts/run-report.sh
chmod +x scripts/setup-cron.sh

# Start API server
pm2 start ecosystem.config.cjs

# Check status
pm2 status

# View logs
pm2 logs mas-api

# Save PM2 configuration (survives reboot)
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Run the command it outputs
```

## 5b. Setup Scheduled Reports (Cron)

```bash
# Install cron jobs for 7am and 4pm EST reports
sudo ./scripts/setup-cron.sh

# Verify cron is installed
cat /etc/cron.d/mas-reports

# View scheduled report logs
tail -f /var/log/mas-report-morning.log
tail -f /var/log/mas-report-daily.log
```

**Schedule:**
- **7:00 AM EST/EDT** - Morning reminder (syncs + sends morning report)
- **4:00 PM EST/EDT** - Daily summary (syncs + sends daily report)

**Features:**
- Automatic EST/EDT daylight saving handling
- Email notification on failure (sent to REPORT_RECIPIENT)
- Logs stored in `/var/log/mas-report-*.log`

## 6. Nginx Reverse Proxy (Optional)

If you want to expose the API on port 80/443:

```bash
sudo apt install nginx -y

# Create config
sudo nano /etc/nginx/sites-available/mas-api
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/mas-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Optional: Add SSL with Let's Encrypt
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d your-domain.com
```

## 7. API Endpoints for Lovable Frontend

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/reports` | GET | List all reports |
| `/api/reports/[id]` | GET | Get single report with HTML |
| `/api/sync` | POST | Trigger email sync |
| `/api/generate-report` | POST | Generate report (auto-detects type) |
| `/api/todos/[id]` | PATCH | Mark todo as resolved |
| `/api/todos/resolve` | PATCH | Resolve by threadKey |
| `/api/dismissed-threads` | GET | List dismissed threads |
| `/api/dismissed-threads` | DELETE | Un-dismiss a thread |

## 8. Monitoring

```bash
# Check PM2 status
pm2 status

# View real-time logs
pm2 logs

# Monitor resources
pm2 monit

# Check scheduled job status
pm2 describe mas-report-morning
pm2 describe mas-report-daily
```

## 9. Manual Report Generation

```bash
cd /var/www/email-fetcher

# Sync emails
npm run sync

# Generate morning report
npm run report:morning

# Generate daily summary
npm run report

# Preview without sending
npm run report -- --preview
```

## 10. Troubleshooting

**PM2 cron not running:**
```bash
# Check server timezone
timedatectl

# Manually trigger report
pm2 trigger mas-report-morning
```

**Database connection issues:**
```bash
# Test connection
npm run db:push
```

**IMAP/SMTP issues:**
```bash
# Test connections
npm run test:connections
```

**View detailed logs:**
```bash
tail -f /var/log/mas-api-out.log
tail -f /var/log/mas-report-out.log
```
