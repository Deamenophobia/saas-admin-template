// Extracted transport selection and delivery-log flow from kokoro-account/services/email.ts.
import { Resend } from "resend";
import { createTransport } from "nodemailer";
import { prisma } from "./prisma.js";
import { config } from "../config.js";
import { ApiError } from "../http.js";

export interface Mail { to: string; template: "verify" | "reset" | "invite"; token: string }
export type MailSender = (mail: Mail) => Promise<void>;
export const sendMail: MailSender = async mail => {
  const from = process.env.EMAIL_FROM;
  if (!from || (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST)) {
    throw new ApiError(503, "EMAIL_UNAVAILABLE", "Email delivery is not configured");
  }
  const log = await prisma.emailLog.create({ data: { to: mail.to, template: mail.template, status: "QUEUED" } });
  const url = new URL(`/auth/${mail.template}`, config.FRONTEND_URL);
  url.searchParams.set("token", mail.token);
  const subject = `${config.APP_NAME}: ${mail.template}`;
  const text = `Complete your ${mail.template} request: ${url.toString()}`;
  try {
    if (process.env.RESEND_API_KEY) {
      const result = await new Resend(process.env.RESEND_API_KEY).emails.send({ from, to: mail.to, subject, text });
      if (result.error) throw new Error("Email rejected");
    } else {
      const smtp = createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_PORT === "465", ...(process.env.SMTP_USER ? {
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } } : {}) });
      await smtp.sendMail({ from, to: mail.to, subject, text });
      smtp.close();
    }
    await prisma.emailLog.update({ where: { id: log.id }, data: { status: "SENT" } });
  } catch {
    await prisma.emailLog.update({ where: { id: log.id }, data: { status: "FAILED" } });
    throw new ApiError(503, "EMAIL_UNAVAILABLE", "Email delivery failed; request another link");
  }
};
