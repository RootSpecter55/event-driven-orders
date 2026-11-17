export type ChargeRequest = {
  /** The provider returns the first result for a repeated key instead of charging twice. */
  idempotencyKey: string;
  amountCents: number;
  /** Token from the provider's client-side SDK, never raw card data. */
  paymentToken: string;
};

export type ChargeResult =
  { status: 'succeeded'; chargeId: string } | { status: 'declined'; reason: string };

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(chargeId: string, idempotencyKey: string): Promise<void>;
}
