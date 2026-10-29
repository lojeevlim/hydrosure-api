import type { PaymentMethod } from '@hydrosure/shared';
import { badRequest } from '../errors';

/** All amounts are integer cents. */
export interface PaymentRequest {
  amountDue: number;
  /** Amount submitted by the client (cash tendered, or the external charge). */
  amount: number;
  externalRef?: string;
}

export interface PaymentResult {
  method: PaymentMethod;
  status: 'captured' | 'unverified';
  /** True only when funds were actually confirmed. */
  verified: boolean;
  amountApplied: number;
  tendered: number;
  change: number;
  externalRef: string | null;
}

export interface PaymentProvider {
  readonly method: PaymentMethod;
  charge(req: PaymentRequest): PaymentResult;
}

/** Cash handed over at the counter; confirmed by the cashier physically. */
export class CashProvider implements PaymentProvider {
  readonly method = 'cash' as const;
  charge(req: PaymentRequest): PaymentResult {
    if (req.amount < req.amountDue) throw badRequest('Cash tendered is less than the amount due');
    return {
      method: 'cash',
      status: 'captured',
      verified: true,
      amountApplied: req.amountDue,
      tendered: req.amount,
      change: req.amount - req.amountDue,
      externalRef: null,
    };
  }
}

/**
 * Card / e-wallet are NOT processed by this system in Phase 1. We only record
 * the reference the cashier typed from an external terminal, flagged unverified.
 * Replace with a real provider integration before claiming any processing.
 */
export class ExternalReferenceProvider implements PaymentProvider {
  constructor(readonly method: 'card' | 'ewallet') {}
  charge(req: PaymentRequest): PaymentResult {
    if (!req.externalRef) throw badRequest('externalRef is required for card/ewallet payments');
    if (req.amount !== req.amountDue) throw badRequest('Card/e-wallet amount must equal the amount due');
    return {
      method: this.method,
      status: 'unverified',
      verified: false,
      amountApplied: req.amountDue,
      tendered: req.amount,
      change: 0,
      externalRef: req.externalRef,
    };
  }
}

const providers: Record<PaymentMethod, PaymentProvider> = {
  cash: new CashProvider(),
  card: new ExternalReferenceProvider('card'),
  ewallet: new ExternalReferenceProvider('ewallet'),
};

export const getProvider = (m: PaymentMethod) => providers[m];
