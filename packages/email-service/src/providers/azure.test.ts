const pollUntilDoneMock = jest.fn().mockResolvedValue({ status: 'Succeeded' });
const beginSendMock = jest.fn().mockResolvedValue({ pollUntilDone: pollUntilDoneMock });

jest.mock('@azure/communication-email', () => ({
  EmailClient: jest.fn().mockImplementation(() => ({ beginSend: beginSendMock })),
}));

import { createAzureEmailService } from './azure';

describe('AzureEmailService', () => {
  beforeEach(() => {
    beginSendMock.mockClear();
    pollUntilDoneMock.mockClear();
  });

  it('rejects at construction time when connectionString is missing', () => {
    expect(() => createAzureEmailService({} as never)).toThrow(/connectionString/i);
  });

  it('formats the sender as "{name} <email>", not the bare address', async () => {
    const service = createAzureEmailService({ connectionString: 'endpoint=https://x;accesskey=y' });

    await service.sendEmail({
      from: { email: 'from@example.com', name: 'From Name' },
      to: [{ email: 'to@example.com', name: 'To' }],
      subject: 'Hi',
      body: 'Hello',
    });

    const request = beginSendMock.mock.calls[0][0];
    expect(request.senderAddress).toBe('From Name <from@example.com>');
  });

  it('waits for the send operation to reach completion rather than firing-and-forgetting', async () => {
    const service = createAzureEmailService({ connectionString: 'endpoint=https://x;accesskey=y' });

    await service.sendEmail({
      from: { email: 'from@example.com', name: 'From' },
      to: [{ email: 'to@example.com', name: 'To' }],
      subject: 'Hi',
      body: 'Hello',
    });

    expect(pollUntilDoneMock).toHaveBeenCalledTimes(1);
  });

  it('rejects sendTemplatedEmail immediately as not supported', async () => {
    const service = createAzureEmailService({ connectionString: 'endpoint=https://x;accesskey=y' });

    await expect(
      service.sendTemplatedEmail({
        from: { email: 'from@example.com', name: 'From' },
        to: [{ email: 'to@example.com', name: 'To' }],
        templateNameOrId: 'x',
        templateData: {},
      }),
    ).rejects.toThrow(/not supported/i);

    expect(beginSendMock).not.toHaveBeenCalled();
  });
});
