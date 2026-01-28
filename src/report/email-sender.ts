import nodemailer from "nodemailer";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

function getSmtpConfig(): SmtpConfig {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      "Missing SMTP credentials. Set SMTP_HOST, SMTP_USER, and SMTP_PASS."
    );
  }

  return {
    host,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    user,
    pass,
    from: process.env.SMTP_FROM || `"MAS Reports" <${user}>`,
  };
}

function getRecipient(): string {
  const recipient = process.env.REPORT_RECIPIENT;
  if (!recipient) {
    throw new Error("Missing REPORT_RECIPIENT environment variable.");
  }
  return recipient;
}

export async function sendReportEmail(
  subject: string,
  html: string,
  to?: string
): Promise<void> {
  const config = getSmtpConfig();
  const recipient = to || getRecipient();

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  await transporter.sendMail({
    from: config.from,
    to: recipient,
    subject,
    html,
  });

  console.log(`Report email sent to ${recipient}`);
}

export async function testSmtpConnection(): Promise<boolean> {
  try {
    const config = getSmtpConfig();

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    await transporter.verify();
    console.log("SMTP connection verified successfully");
    return true;
  } catch (error) {
    console.error("SMTP connection failed:", error);
    return false;
  }
}
