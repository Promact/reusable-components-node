const sendMailMock = jest.fn();
const closeMock = jest.fn();
const createTransportMock = jest.fn((..._args: unknown[]) => ({ sendMail: sendMailMock, close: closeMock }));

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: (...args: unknown[]) => createTransportMock(...args),
  },
}));

import { createSmtpEmailService } from './smtp';

describe('SmtpEmailService', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    closeMock.mockReset();
    createTransportMock.mockClear();
  });

  it.each(['host', 'port', 'userName', 'password'])('rejects at construction time when %s is missing', (field) => {
    const options = { host: 'smtp.example.com', port: 587, userName: 'user', password: 'pass' } as Record<
      string,
      unknown
    >;
    delete options[field];
    expect(() => createSmtpEmailService(options as never)).toThrow();
  });

  it('opens one connection per send with opportunistic STARTTLS, no pooling', async () => {
    sendMailMock.mockResolvedValue({});
    const service = createSmtpEmailService({ host: 'smtp.example.com', port: 587, userName: 'user', password: 'pass' });

    await service.sendEmail({
      from: { email: 'from@example.com', name: 'From' },
      to: [{ email: 'to@example.com', name: 'To' }],
      subject: 'Hi',
      body: 'Hello',
    });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: true }),
    );
    // nodemailer defaults `pool` to false (one connection per send) when omitted.
    expect(createTransportMock.mock.calls[0][0]).not.toHaveProperty('pool', true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects sendTemplatedEmail immediately as not supported, without touching the transport', async () => {
    const service = createSmtpEmailService({ host: 'smtp.example.com', port: 587, userName: 'user', password: 'pass' });

    await expect(
      service.sendTemplatedEmail({
        from: { email: 'from@example.com', name: 'From' },
        to: [{ email: 'to@example.com', name: 'To' }],
        templateNameOrId: 'x',
        templateData: {},
      }),
    ).rejects.toThrow(/not supported/i);

    expect(createTransportMock).not.toHaveBeenCalled();
  });
});
