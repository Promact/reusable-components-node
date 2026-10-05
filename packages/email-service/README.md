# email-service

Provider-agnostic email sending for Node.js/TypeScript — AWS SES, SendGrid, SMTP, and Azure Communication Services behind one `IEmailService` interface. Behavioral port of the .NET `nuget-packages/email-service` library; see `docs/specs/nuget-packages-spec.md` §1 for the full functional spec.

## Installation

```bash
npm install @promact/email-service
```

## Usage

```ts
import { createSesEmailService } from '@promact/email-service';

const emailService = createSesEmailService({ region: 'us-east-1' });

await emailService.sendEmail({
  from: { email: 'no-reply@example.com', name: 'Example' },
  to: [{ email: 'user@example.com', name: 'User' }],
  subject: 'Hello',
  body: '<p>Hi there</p>',
  isBodyHtml: true,
});
```

## Provider notes

- **SES / SendGrid / SMTP / Azure** all implement `sendEmail`. Only **SES** and **SendGrid** implement `sendTemplatedEmail` — SMTP and Azure reject it immediately as unsupported.
- SES's templated send drops the `subject` field onto the outgoing message (a known parity gap carried over from the .NET original — see spec §8.1).
- All providers format the sender as `"{name} <email>"`.
- `cc`/`bcc` headers are omitted entirely when empty, never sent as empty headers.
