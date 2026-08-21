import nodemailer, { Transporter } from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import { Email, IEmailService, SmtpEmailServiceOptions, TemplatedEmailRequest } from '../types';
import { formatSender, notSupported, requireField, toAddressList, validateEmailBase } from './shared';

function addressString(addresses: { name: string; email: string }[]): string | undefined {
  if (addresses.length === 0) {
    return undefined;
  }
  return addresses.map((a) => `${a.name} <${a.email}>`).join(', ');
}

/**
 * SMTP adapter (spec §1.6.3). Opens one connection per send (no pooling),
 * upgrades via opportunistic STARTTLS, authenticates, sends, then
 * disconnects. Templated sends are not supported by this provider.
 */
export class SmtpEmailService implements IEmailService {
  constructor(private readonly options: SmtpEmailServiceOptions) {
    requireField(options.host, 'host');
    requireField(options.port, 'port');
    requireField(options.userName, 'userName');
    requireField(options.password, 'password');
  }

  private createTransport(): Transporter<SMTPTransport.SentMessageInfo> {
    const options: SMTPTransport.Options = {
      host: this.options.host,
      port: this.options.port,
      secure: false,
      requireTLS: true,
      auth: {
        user: this.options.userName,
        pass: this.options.password,
      },
    };
    return nodemailer.createTransport(options);
  }

  async sendEmail(email: Email): Promise<void> {
    validateEmailBase(email);

    const transport = this.createTransport();
    try {
      await transport.sendMail({
        from: formatSender(email.from),
        to: addressString(email.to),
        cc: addressString(toAddressList(email.cc)),
        bcc: addressString(toAddressList(email.bcc)),
        subject: email.subject,
        html: email.isBodyHtml ? email.body : undefined,
        text: email.isBodyHtml ? undefined : email.body,
        attachments: (email.attachments ?? []).map((a) => ({
          filename: a.fileName,
          contentType: a.contentType,
          content: a.content,
        })),
      });
    } finally {
      transport.close();
    }
  }

  async sendTemplatedEmail(_request: TemplatedEmailRequest): Promise<void> {
    notSupported('sendTemplatedEmail', 'SMTP');
  }
}

export function createSmtpEmailService(options: SmtpEmailServiceOptions): IEmailService {
  return new SmtpEmailService(options);
}
