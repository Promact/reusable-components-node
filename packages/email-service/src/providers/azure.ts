import { EmailClient } from '@azure/communication-email';
import { AzureEmailServiceOptions, Email, EmailAddress, IEmailService, TemplatedEmailRequest } from '../types';
import { formatSender, notSupported, requireField, toAddressList, validateEmailBase } from './shared';

function toAzureRecipient(address: EmailAddress): { address: string; displayName: string } {
  return { address: address.email, displayName: address.name };
}

/**
 * Azure Communication Services adapter (spec §1.6.4). Waits for the send
 * operation to report completion rather than firing-and-forgetting.
 * Templated sends are not supported by this provider.
 */
export class AzureEmailService implements IEmailService {
  private readonly client: EmailClient;

  constructor(options: AzureEmailServiceOptions) {
    requireField(options.connectionString, 'connectionString');
    this.client = new EmailClient(options.connectionString);
  }

  async sendEmail(email: Email): Promise<void> {
    validateEmailBase(email);

    const poller = await this.client.beginSend({
      // Sender formatted as "{Name} <email>", not the bare address — spec
      // §1.6.4 requires this literal parity with the other three providers.
      senderAddress: formatSender(email.from),
      content: email.isBodyHtml
        ? { subject: email.subject, html: email.body }
        : { subject: email.subject, plainText: email.body },
      recipients: {
        to: email.to.map(toAzureRecipient),
        cc: toAddressList(email.cc).map(toAzureRecipient),
        bcc: toAddressList(email.bcc).map(toAzureRecipient),
      },
      attachments: (email.attachments ?? []).map((a) => ({
        name: a.fileName,
        contentType: a.contentType,
        contentInBase64: a.content.toString('base64'),
      })),
    });

    await poller.pollUntilDone();
  }

  async sendTemplatedEmail(_request: TemplatedEmailRequest): Promise<void> {
    notSupported('sendTemplatedEmail', 'Azure Communication Services');
  }
}

export function createAzureEmailService(options: AzureEmailServiceOptions): IEmailService {
  return new AzureEmailService(options);
}
