const sendMock = jest.fn();
const setApiKeyMock = jest.fn();

jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: {
    setApiKey: (...args: unknown[]) => setApiKeyMock(...args),
    send: (...args: unknown[]) => sendMock(...args),
  },
}));

import { createSendGridEmailService } from './sendgrid';

describe('SendGridEmailService', () => {
  beforeEach(() => {
    sendMock.mockReset();
    setApiKeyMock.mockReset();
  });

  it('rejects at construction time when apiKey is missing', () => {
    expect(() => createSendGridEmailService({} as never)).toThrow(/apiKey/i);
  });

  it('constructs successfully with an apiKey', () => {
    expect(() => createSendGridEmailService({ apiKey: 'SG.test' })).not.toThrow();
  });

  it('omits cc/bcc entirely when empty', async () => {
    sendMock.mockResolvedValue([{}]);
    const service = createSendGridEmailService({ apiKey: 'SG.test' });

    await service.sendEmail({
      from: { email: 'from@example.com', name: 'From' },
      to: [{ email: 'to@example.com', name: 'To' }],
      subject: 'Hi',
      body: 'Hello',
    });

    const message = sendMock.mock.calls[0][0];
    expect(message.cc).toEqual([]);
    expect(message.bcc).toEqual([]);
  });

  it('base64-encodes attachment content', async () => {
    sendMock.mockResolvedValue([{}]);
    const service = createSendGridEmailService({ apiKey: 'SG.test' });

    await service.sendEmail({
      from: { email: 'from@example.com', name: 'From' },
      to: [{ email: 'to@example.com', name: 'To' }],
      subject: 'Hi',
      body: 'Hello',
      attachments: [{ content: Buffer.from('file-bytes'), fileName: 'a.pdf', contentType: 'application/pdf' }],
    });

    const message = sendMock.mock.calls[0][0];
    expect(message.attachments[0].content).toBe(Buffer.from('file-bytes').toString('base64'));
  });

  it('sets templateId and dynamicTemplateData for templated sends, with no separate subject', async () => {
    sendMock.mockResolvedValue([{}]);
    const service = createSendGridEmailService({ apiKey: 'SG.test' });

    await service.sendTemplatedEmail({
      from: { email: 'from@example.com', name: 'From' },
      to: [{ email: 'to@example.com', name: 'To' }],
      templateNameOrId: 'd-abc123',
      templateData: { name: 'Jane' },
    });

    const message = sendMock.mock.calls[0][0];
    expect(message.templateId).toBe('d-abc123');
    expect(message.dynamicTemplateData).toEqual({ name: 'Jane' });
    expect(message.subject).toBeUndefined();
  });

  it('rejects null input immediately', async () => {
    const service = createSendGridEmailService({ apiKey: 'SG.test' });
    await expect(service.sendEmail(null as never)).rejects.toThrow(/required argument missing/i);
  });
});
