declare module 'mailcomposer' {
  interface MailComposerAttachment {
    filename?: string;
    contentType?: string;
    content?: Buffer | string;
  }

  interface MailComposerOptions {
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    html?: string;
    text?: string;
    attachments?: MailComposerAttachment[];
  }

  class MailComposer {
    constructor(options: MailComposerOptions);
    build(callback: (err: Error | null, message: Buffer) => void): void;
  }

  export = MailComposer;
}
