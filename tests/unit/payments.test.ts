import { describe, expect, it } from "vitest";
import {
  canCancelPayment,
  canRefundPayment,
  canTransitionPayment,
  isVerifiedPaymentState,
  PAYMENT_ALLOWED_TRANSITIONS,
  providerEventToState,
  stripeIntentStatusToState,
  transitionPayment,
  validateWebhookMoney,
  PaymentTransitionError,
} from "../../src/domain/payments.js";

describe("payment lifecycle state machine (no escrow, verified events only)", () => {
  it("walks the happy path created → pending → processing → paid", () => {
    expect(transitionPayment("created", "pending")).toBe("pending");
    expect(transitionPayment("pending", "processing")).toBe("processing");
    expect(transitionPayment("processing", "paid")).toBe("paid");
    expect(transitionPayment("pending", "paid")).toBe("paid");
  });

  it("supports failed / cancelled / refunded / disputed branches", () => {
    expect(transitionPayment("pending", "failed")).toBe("failed");
    expect(transitionPayment("processing", "cancelled")).toBe("cancelled");
    expect(transitionPayment("paid", "refunded")).toBe("refunded");
    expect(transitionPayment("paid", "disputed")).toBe("disputed");
    expect(canRefundPayment("paid")).toBe(true);
    expect(canRefundPayment("pending")).toBe(false);
    expect(canCancelPayment("pending")).toBe(true);
    expect(canCancelPayment("paid")).toBe(false);
  });

  it("rejects illegal jumps and terminal rewrites", () => {
    expect(() => transitionPayment("created", "paid")).toThrow(PaymentTransitionError);
    expect(() => transitionPayment("failed", "pending")).toThrow(PaymentTransitionError);
    expect(() => transitionPayment("refunded", "paid")).toThrow(PaymentTransitionError);
    expect(() => transitionPayment("cancelled", "paid")).toThrow(PaymentTransitionError);
    expect(canTransitionPayment("created", "paid")).toBe(false);
    expect(canTransitionPayment("pending", "paid")).toBe(true);
  });

  it("maps provider events to lifecycle states (unknown ignored)", () => {
    expect(providerEventToState("payment_intent.succeeded")).toBe("paid");
    expect(providerEventToState("checkout.session.completed")).toBe("paid");
    expect(providerEventToState("payment_intent.processing")).toBe("processing");
    expect(providerEventToState("payment_intent.payment_failed")).toBe("failed");
    expect(providerEventToState("payment_intent.canceled")).toBe("cancelled");
    expect(providerEventToState("checkout.session.expired")).toBe("cancelled");
    expect(providerEventToState("charge.refunded")).toBe("refunded");
    expect(providerEventToState("charge.dispute.created")).toBe("disputed");
    expect(providerEventToState("invoice.upcoming")).toBeNull();
    expect(stripeIntentStatusToState("succeeded")).toBe("paid");
    expect(stripeIntentStatusToState("processing")).toBe("processing");
    expect(stripeIntentStatusToState("canceled")).toBe("cancelled");
    expect(stripeIntentStatusToState("requires_payment_method")).toBe("pending");
  });

  it("validates amount/currency exactly (mismatch never marks paid)", () => {
    expect(
      validateWebhookMoney(
        { amountCents: 50000, currency: "USD" },
        { amountCents: 50000, currency: "usd" },
      ),
    ).toBeNull();
    expect(
      validateWebhookMoney(
        { amountCents: 50000, currency: "USD" },
        { amountCents: 49999, currency: "USD" },
      ),
    ).toMatch(/amount mismatch/);
    expect(
      validateWebhookMoney(
        { amountCents: 50000, currency: "USD" },
        { amountCents: 50000, currency: "EUR" },
      ),
    ).toMatch(/currency mismatch/);
  });

  it("counts only verified states toward money", () => {
    expect(isVerifiedPaymentState("paid")).toBe(true);
    expect(isVerifiedPaymentState("received")).toBe(true);
    expect(isVerifiedPaymentState("partial")).toBe(true);
    expect(isVerifiedPaymentState("pending")).toBe(false);
    expect(isVerifiedPaymentState("failed")).toBe(false);
    expect(isVerifiedPaymentState("cancelled")).toBe(false);
  });

  it("documents the transition table", () => {
    expect(Object.keys(PAYMENT_ALLOWED_TRANSITIONS).sort()).toEqual([
      "created",
      "paid",
      "pending",
      "processing",
    ]);
  });
});
