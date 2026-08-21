export interface EmailAddress {
  email: string;
  name: string;
}

export interface Attachment {
  content: Buffer;
  fileName: string;
  contentType: string;
}

export interface EmailBase {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  attachments?: Attachment[];
  isBodyHtml?: boolean;
}

export interface Email extends EmailBase {
  subject: string;
  body: string;
}

export interface TemplatedEmailRequest extends EmailBase {
  templateNameOrId: string;
  templateData: Record<string, unknown>;
  subject?: string;
}

export interface IEmailService {
  sendEmail(email: Email): Promise<void>;
  sendTemplatedEmail(request: TemplatedEmailRequest): Promise<void>;
}

export interface SesEmailServiceOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
  region: string;
}

export interface SendGridEmailServiceOptions {
  apiKey: string;
}

export interface SmtpEmailServiceOptions {
  host: string;
  port: number;
  userName: string;
  password: string;
}

export interface AzureEmailServiceOptions {
  connectionString: string;
}
