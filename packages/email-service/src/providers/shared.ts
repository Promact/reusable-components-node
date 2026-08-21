import { Email, EmailAddress, EmailBase, TemplatedEmailRequest } from '../types';

/** Canonical "{Name} <email>" sender format shared by all four providers (spec §1.6.4). */
export function formatSender(from: EmailAddress): string {
  return `${from.name} <${from.email}>`;
}

export function requireField<T>(value: T | undefined | null, fieldName: string): T {
  if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
    throw new Error(`Missing required configuration field: ${fieldName}`);
  }
  return value;
}

export function requireInput<T>(value: T | undefined | null, argumentName: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Required argument missing: ${argumentName}`);
  }
  return value;
}

export function notSupported(operation: string, provider: string): never {
  throw new Error(`${operation} is not supported by this provider: ${provider}`);
}

export function toAddressList(addresses: EmailAddress[] | undefined): EmailAddress[] {
  return addresses ?? [];
}

export function validateEmailBase(input: EmailBase | Email | TemplatedEmailRequest): void {
  requireInput(input, 'email');
  requireInput(input.from, 'from');
  requireInput(input.to, 'to');
}
