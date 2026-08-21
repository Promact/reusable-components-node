import { GetTemplateCommand, SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import Mustache from 'mustache';
import { Email, IEmailService, SesEmailServiceOptions, TemplatedEmailRequest } from '../types';
import { buildMimeMessage } from './mime';
import { requireField, toAddressList, validateEmailBase } from './shared';

const VALID_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

function destinations(request: Pick<Email, 'to' | 'cc' | 'bcc'>): string[] {
  return [
    ...request.to.map((a) => a.email),
    ...toAddressList(request.cc).map((a) => a.email),
    ...toAddressList(request.bcc).map((a) => a.email),
  ];
}

/**
 * SES adapter. Both sendEmail and sendTemplatedEmail submit a hand-built raw
 * MIME document via SendRawEmailCommand (spec §1.6.1) — SES's structured
 * "simple" send API is intentionally not used, to preserve MIME-level control
 * (attachments, HTML/text exclusivity) identical to the .NET original.
 */
export class SesEmailService implements IEmailService {
  private readonly client: SESClient;

  constructor(options: SesEmailServiceOptions) {
    const region = requireField(options.region, 'region');
    if (!VALID_REGION_PATTERN.test(region)) {
      throw new Error(`Invalid AWS region: ${region}`);
    }

    this.client = new SESClient({
      region,
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  async sendEmail(email: Email): Promise<void> {
    validateEmailBase(email);

    const message = await buildMimeMessage({
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      subject: email.subject,
      html: email.isBodyHtml ? email.body : undefined,
      text: email.isBodyHtml ? undefined : email.body,
      attachments: email.attachments,
    });

    await this.submitRaw(email, message);
  }

  async sendTemplatedEmail(request: TemplatedEmailRequest): Promise<void> {
    validateEmailBase(request);
    requireField(request.templateNameOrId, 'templateNameOrId');
    requireField(request.templateData, 'templateData');

    const templateHtml = await this.fetchTemplateHtml(request.templateNameOrId);
    const renderedHtml = Mustache.render(templateHtml, request.templateData);

    // Deliberate parity gap with the .NET original (spec §8.1): the `subject`
    // field on TemplatedEmailRequest is intentionally NOT applied here — the
    // raw MIME message built for templated sends omits the subject header.
    const message = await buildMimeMessage({
      from: request.from,
      to: request.to,
      cc: request.cc,
      bcc: request.bcc,
      html: renderedHtml,
      attachments: request.attachments,
    });

    await this.submitRaw(request, message);
  }

  private async submitRaw(request: Pick<Email, 'to' | 'cc' | 'bcc'>, message: Buffer): Promise<void> {
    await this.client.send(
      new SendRawEmailCommand({
        Destinations: destinations(request),
        RawMessage: { Data: message },
      }),
    );
  }

  /**
   * Fetches only the HTML part of an SES server-side template (spec §1.6.1
   * step 1). The template must already exist in SES; this library does not
   * create or manage templates.
   */
  private async fetchTemplateHtml(templateName: string): Promise<string> {
    const result = await this.client.send(new GetTemplateCommand({ TemplateName: templateName }));
    const html = result.Template?.HtmlPart;
    if (!html) {
      throw new Error(`SES template "${templateName}" has no HTML part`);
    }
    return html;
  }
}

export function createSesEmailService(options: SesEmailServiceOptions): IEmailService {
  return new SesEmailService(options);
}
