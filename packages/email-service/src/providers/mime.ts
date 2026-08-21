import MailComposer from 'mailcomposer';
import { Attachment, EmailAddress } from '../types';
import { formatSender, toAddressList } from './shared';

export interface MimeMessageInput {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject?: string;
  html?: string;
  text?: string;
  attachments?: Attachment[];
}

function addressString(addresses: EmailAddress[]): string | undefined {
  if (addresses.length === 0) {
    return undefined;
  }
  return addresses.map((a) => `${a.name} <${a.email}>`).join(', ');
}

/**
 * Builds a raw MIME document. cc/bcc headers are omitted entirely when empty
 * (spec §1.3.3) rather than sent as empty headers.
 */
export function buildMimeMessage(input: MimeMessageInput): Promise<Buffer> {
  const cc = toAddressList(input.cc);
  const bcc = toAddressList(input.bcc);

  const mail = new MailComposer({
    from: formatSender(input.from),
    to: addressString(input.to),
    cc: addressString(cc),
    bcc: addressString(bcc),
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: (input.attachments ?? []).map((a) => ({
      filename: a.fileName,
      contentType: a.contentType,
      content: a.content,
    })),
  });

  return new Promise((resolve, reject) => {
    mail.build((err: Error | null, message: Buffer) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(message);
    });
  });
}
