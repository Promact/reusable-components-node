import sgMail, { MailDataRequired } from '@sendgrid/mail';
import { Email, EmailAddress, IEmailService, SendGridEmailServiceOptions, TemplatedEmailRequest } from '../types';
import { requireField, toAddressList, validateEmailBase } from './shared';

function toSendGridAddress(address: EmailAddress): { email: string; name: string } {
  return { email: address.email, name: address.name };
}

/**
 * SendGrid adapter (spec §1.6.2). Maps fields directly onto SendGrid's
 * structured message object — no raw MIME construction.
 */
export class SendGridEmailService implements IEmailService {
  private readonly client: typeof sgMail;

  constructor(options: SendGridEmailServiceOptions) {
    requireField(options.apiKey, 'apiKey');
    sgMail.setApiKey(options.apiKey);
    this.client = sgMail;
  }

  async sendEmail(email: Email): Promise<void> {
    validateEmailBase(email);

    const message: MailDataRequired = {
      from: toSendGridAddress(email.from),
      to: email.to.map(toSendGridAddress),
      cc: toAddressList(email.cc).map(toSendGridAddress),
      bcc: toAddressList(email.bcc).map(toSendGridAddress),
      subject: email.subject,
      content: [{ type: email.isBodyHtml ? 'text/html' : 'text/plain', value: email.body }],
      attachments: (email.attachments ?? []).map((a) => ({
        filename: a.fileName,
        type: a.contentType,
        content: a.content.toString('base64'),
      })),
    };

    await this.client.send(message);
  }

  async sendTemplatedEmail(request: TemplatedEmailRequest): Promise<void> {
    validateEmailBase(request);
    requireField(request.templateNameOrId, 'templateNameOrId');
    requireField(request.templateData, 'templateData');

    const message: MailDataRequired = {
      from: toSendGridAddress(request.from),
      to: request.to.map(toSendGridAddress),
      cc: toAddressList(request.cc).map(toSendGridAddress),
      bcc: toAddressList(request.bcc).map(toSendGridAddress),
      templateId: request.templateNameOrId,
      dynamicTemplateData: request.templateData,
      attachments: (request.attachments ?? []).map((a) => ({
        filename: a.fileName,
        type: a.contentType,
        content: a.content.toString('base64'),
      })),
    } as MailDataRequired;

    await this.client.send(message);
  }
}

export function createSendGridEmailService(options: SendGridEmailServiceOptions): IEmailService {
  return new SendGridEmailService(options);
}
