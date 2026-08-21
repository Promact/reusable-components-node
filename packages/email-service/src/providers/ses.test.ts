const sendMock = jest.fn();

jest.mock('@aws-sdk/client-ses', () => {
  return {
    SESClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
    SendRawEmailCommand: jest.fn().mockImplementation((input) => ({ __type: 'SendRawEmailCommand', input })),
    GetTemplateCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetTemplateCommand', input })),
  };
});

import { createSesEmailService } from './ses';

describe('SesEmailService', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('rejects at construction time when region is missing', () => {
    expect(() => createSesEmailService({} as never)).toThrow(/region/i);
  });

  it('rejects at construction time when region is invalid', () => {
    expect(() => createSesEmailService({ region: 'not-a-region' })).toThrow(/invalid.*region/i);
  });

  it('constructs successfully with a valid region and no explicit credentials', () => {
    expect(() => createSesEmailService({ region: 'us-east-1' })).not.toThrow();
  });

  it('sends a raw MIME message omitting cc/bcc headers when empty', async () => {
    sendMock.mockResolvedValue({});
    const service = createSesEmailService({ region: 'us-east-1' });

    await service.sendEmail({
      from: { email: 'from@example.com', name: 'From' },
      to: [{ email: 'to@example.com', name: 'To' }],
      subject: 'Hi',
      body: 'Hello',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    const rawMessage: Buffer = command.input.RawMessage.Data;
    const mimeText = rawMessage.toString('utf-8');
    expect(mimeText).not.toMatch(/^Cc:/im);
    expect(mimeText).not.toMatch(/^Bcc:/im);
  });

  it('sends a templated email without a subject header (spec §8.1 documented gap)', async () => {
    sendMock.mockImplementation((command) => {
      if (command.__type === 'GetTemplateCommand') {
        return Promise.resolve({ Template: { HtmlPart: '<p>Hello {{name}}</p>' } });
      }
      return Promise.resolve({});
    });

    const service = createSesEmailService({ region: 'us-east-1' });

    await service.sendTemplatedEmail({
      from: { email: 'from@example.com', name: 'From' },
      to: [{ email: 'to@example.com', name: 'To' }],
      templateNameOrId: 'welcome-template',
      templateData: { name: 'Jane' },
      subject: 'This subject must be dropped',
    });

    const rawSendCall = sendMock.mock.calls.find((call) => call[0].__type === 'SendRawEmailCommand');
    expect(rawSendCall).toBeDefined();
    const mimeText: string = rawSendCall![0].input.RawMessage.Data.toString('utf-8');
    expect(mimeText).not.toMatch(/^Subject:.*must be dropped/im);
    expect(mimeText).toContain('Hello Jane');
  });

  it('rejects null input immediately', async () => {
    const service = createSesEmailService({ region: 'us-east-1' });
    await expect(service.sendEmail(null as never)).rejects.toThrow(/required argument missing/i);
  });
});
