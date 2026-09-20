import { createHash } from "node:crypto";
import { verificationTierForPaymentState } from "./reconciliation.js";
import { describeEvent, eventCategory } from "./timeline.js";

/**
 * Evidence pack — a professional, factual export for an overdue or disputed
 * project (Session 15).
 *
 * Pure + DB-free. The store/route layers gather records; this module turns
 * them into a canonical snapshot with stable hashing and a clean printable
 * rendering.
 *
 * Hard rules (enforced by tests):
 * - Factual record only. Every statement says what happened, when, and who
 *   recorded it ("On <date>, <actor> approved <deliverable> version 4").
 * - No legal conclusions. The builder never writes words like fraud, guilty,
 *   liable, breach, theft, sue, or court-threat phrasing, and
 *   `assertFactualCopy()` rejects them if they ever appear.
 * - No guarantee of dispute success. Every rendering carries the
 *   no-guarantee notice next to the disclaimer.
 * - Money is integer cents with ISO currency; only provider-confirmed
 *   receipts count as paid (claims never do).
 */

export const EVIDENCE_PACK_VERSION = "v1";
export const EVIDENCE_PACK_DISCLAIMER_VERSION = "v1";
export const EVIDENCE_PACK_DISCLAIMER =
  "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.";
export const EVIDENCE_PACK_NO_GUARANTEE =
  "This pack is a factual record of project events. It does not predict or guarantee any outcome in a dispute, mediation, collections process, or court/tribunal review.";

const BANNED_PHRASES = [
  "fraud",
  "fraudulent",
  "guilty",
  "liable",
  "liability",
  "breach of contract",
  "proves the client",
  "proof that the client",
  "committed",
  "criminal",
  "sue you",
  "we will sue",
  "going to sue",
  "take you to court",
  "see you in court",
  "guarantees success",
  "guarantee success",
  "guaranteed to win",
  "will win the dispute",
  "theft",
  "stole",
];

/** Throws when copy drifts into legal conclusions or outcome guarantees. */
export function assertFactualCopy(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(`Evidence-pack copy must stay factual; found banned phrase: "${phrase}"`);
    }
  }
}

export interface EvidencePackPartyInput {
  readonly workspaceName: string;
  readonly clientName: string;
  readonly clientCompany?: string | undefined;
  readonly clientEmail: string;
}

export interface EvidencePackProjectInput {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly currency: string;
  readonly totalValueCents: number;
  readonly status: string;
  readonly paymentTerms?: string | undefined;
  readonly startDate?: Date | undefined;
  readonly expectedCompletion?: Date | undefined;
  readonly createdAt: Date;
}

export interface EvidencePackAgreementInput {
  readonly version: number;
  readonly status: string;
  readonly hash: string;
  readonly totalAmountCents: number;
  readonly currency: string;
  readonly depositAmountCents: number;
  readonly paymentDueDays: number;
  readonly graceDays: number;
  readonly acceptedPaymentMethods: readonly string[];
  readonly sentAt?: Date | undefined;
  readonly acceptedAt?: Date | undefined;
  readonly acceptedBy?: string | undefined;
}

export interface EvidencePackMilestoneInput {
  readonly id: string;
  readonly title: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly dueDate?: Date | undefined;
  readonly workState: string;
  readonly paymentState: string;
  readonly approvalState: string;
  readonly orderIndex: number;
}

export interface EvidencePackPaymentInput {
  readonly id: string;
  readonly milestoneId?: string | undefined;
  readonly amountCents: number;
  readonly currency: string;
  readonly state: string;
  readonly provider: string;
  readonly createdAt: Date;
  readonly receivedAt?: Date | undefined;
}

export interface EvidencePackDeliverableInput {
  readonly id: string;
  readonly milestoneId: string;
  readonly milestoneTitle: string;
  readonly title: string;
  readonly status: string;
  readonly currentVersionNo: number;
  readonly approvedVersionNo?: number | undefined;
  readonly versions: readonly {
    readonly versionNo: number;
    readonly createdAt: Date;
    readonly fileCount: number;
    readonly linkCount: number;
  }[];
}

export interface EvidencePackApprovalInput {
  readonly milestoneId: string;
  readonly milestoneTitle: string;
  readonly decision: string;
  readonly versionNo?: number | undefined;
  readonly versionRef?: string | undefined;
  readonly note?: string | undefined;
  readonly actorType: string;
  readonly createdAt: Date;
}

export interface EvidencePackReminderInput {
  readonly id: string;
  readonly milestoneId?: string | undefined;
  readonly template: string;
  readonly state: string;
  readonly recipient: string;
  readonly scheduledFor: Date;
  readonly sentAt?: Date | undefined;
}

export interface EvidencePackPlanInput {
  readonly id: string;
  readonly milestoneId: string;
  readonly milestoneTitle: string;
  readonly version: number;
  readonly state: string;
  readonly originalAmountCents: number;
  readonly currency: string;
  readonly offeredAt: Date;
  readonly acceptedAt?: Date | undefined;
  readonly installments: readonly {
    readonly seq: number;
    readonly amountCents: number;
    readonly dueDate: Date;
    readonly status: string;
  }[];
}

export interface EvidencePackEventInput {
  readonly id: string;
  readonly type: string;
  readonly actorType: string;
  readonly milestoneId?: string | undefined;
  readonly milestoneTitle?: string | undefined;
  readonly occurredAt: Date;
  readonly payload?: Record<string, unknown> | undefined;
}

export interface EvidencePackBuilderInput {
  readonly generatedBy: string;
  readonly generatedAt: Date;
  readonly parties: EvidencePackPartyInput;
  readonly project: EvidencePackProjectInput;
  readonly agreements: readonly EvidencePackAgreementInput[];
  readonly milestones: readonly EvidencePackMilestoneInput[];
  readonly payments: readonly EvidencePackPaymentInput[];
  readonly deliverables: readonly EvidencePackDeliverableInput[];
  readonly approvals: readonly EvidencePackApprovalInput[];
  readonly reminders: readonly EvidencePackReminderInput[];
  readonly paymentPlans: readonly EvidencePackPlanInput[];
  /** Chronological (oldest-first). The route passes the full trail. */
  readonly events: readonly EvidencePackEventInput[];
}

/** Canonical snapshot: JSON-safe, stable key order, factual strings only. */
export interface EvidencePackSnapshot {
  readonly packVersion: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly parties: {
    readonly freelancerWorkspace: string;
    readonly clientName: string;
    readonly clientCompany?: string | undefined;
    readonly clientEmail: string;
  };
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly description?: string | undefined;
    readonly currency: string;
    readonly totalValueCents: number;
    readonly status: string;
    readonly paymentTerms?: string | undefined;
    readonly startDate?: string | undefined;
    readonly expectedCompletion?: string | undefined;
    readonly createdAt: string;
  };
  readonly agreement: {
    readonly currentVersion?: number | undefined;
    readonly currentStatus?: string | undefined;
    readonly versionHashes: readonly string[];
    readonly versions: readonly {
      readonly version: number;
      readonly status: string;
      readonly hash: string;
      readonly totalAmountCents: number;
      readonly currency: string;
      readonly depositAmountCents: number;
      readonly paymentDueDays: number;
      readonly graceDays: number;
      readonly acceptedPaymentMethods: readonly string[];
      readonly sentAt?: string | undefined;
      readonly acceptedAt?: string | undefined;
      readonly acceptedBy?: string | undefined;
    }[];
  };
  readonly milestones: readonly {
    readonly id: string;
    readonly title: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly dueDate?: string | undefined;
    readonly workState: string;
    readonly paymentState: string;
    readonly approvalState: string;
    readonly orderIndex: number;
  }[];
  readonly financialSummary: {
    readonly currency: string;
    readonly milestonesTotalCents: number;
    readonly verifiedPaidCents: number;
    readonly outstandingCents: number;
    readonly verifiedOnlyNote: string;
  };
  readonly payments: readonly {
    readonly id: string;
    readonly milestoneId?: string | undefined;
    readonly amountCents: number;
    readonly currency: string;
    readonly state: string;
    readonly verificationTier: string;
    readonly verified: boolean;
    readonly provider: string;
    readonly createdAt: string;
    readonly receivedAt?: string | undefined;
  }[];
  readonly deliverables: readonly {
    readonly id: string;
    readonly milestoneId: string;
    readonly milestoneTitle: string;
    readonly title: string;
    readonly status: string;
    readonly currentVersionNo: number;
    readonly approvedVersionNo?: number | undefined;
    readonly versions: readonly {
      readonly versionNo: number;
      readonly createdAt: string;
      readonly fileCount: number;
      readonly linkCount: number;
    }[];
  }[];
  readonly approvals: readonly {
    readonly milestoneId: string;
    readonly milestoneTitle: string;
    readonly decision: string;
    readonly versionNo?: number | undefined;
    readonly versionRef?: string | undefined;
    readonly note?: string | undefined;
    readonly actorType: string;
    readonly createdAt: string;
    readonly statement: string;
  }[];
  readonly revisions: readonly {
    readonly milestoneId?: string | undefined;
    readonly milestoneTitle?: string | undefined;
    readonly type: string;
    readonly occurredAt: string;
    readonly statement: string;
  }[];
  readonly reminders: readonly {
    readonly id: string;
    readonly milestoneId?: string | undefined;
    readonly template: string;
    readonly state: string;
    readonly recipient: string;
    readonly scheduledFor: string;
    readonly sentAt?: string | undefined;
  }[];
  readonly paymentPlans: readonly {
    readonly id: string;
    readonly milestoneId: string;
    readonly milestoneTitle: string;
    readonly version: number;
    readonly state: string;
    readonly originalAmountCents: number;
    readonly currency: string;
    readonly offeredAt: string;
    readonly acceptedAt?: string | undefined;
    readonly installments: readonly {
      readonly seq: number;
      readonly amountCents: number;
      readonly dueDate: string;
      readonly status: string;
    }[];
  }[];
  readonly timeline: readonly {
    readonly id: string;
    readonly type: string;
    readonly category: string;
    readonly headline: string;
    readonly detail: string;
    readonly actorType: string;
    readonly milestoneId?: string | undefined;
    readonly milestoneTitle?: string | undefined;
    readonly occurredAt: string;
  }[];
  readonly integrity: {
    readonly eventCount: number;
    readonly oldestEventAt?: string | undefined;
    readonly newestEventAt?: string | undefined;
    readonly agreementVersionHashes: readonly string[];
  };
  readonly disclaimer: string;
  readonly disclaimerVersion: string;
  readonly noGuarantee: string;
}

function iso(d: Date): string {
  return d.toISOString();
}

function dateOnly(occurredAt: Date): string {
  return occurredAt.toISOString().slice(0, 10);
}

function actorLabel(actorType: string): string {
  if (actorType === "client") return "the client";
  if (actorType === "freelancer") return "the freelancer";
  if (actorType === "provider") return "the payment provider";
  return "the system";
}

function approvalStatement(input: {
  actorType: string;
  decision: string;
  milestoneTitle: string;
  versionNo?: number | undefined;
  versionRef?: string | undefined;
  occurredAt: Date;
}): string {
  const when = dateOnly(input.occurredAt);
  const who = actorLabel(input.actorType);
  const pinned =
    input.versionNo !== undefined
      ? ` version ${input.versionNo}`
      : input.versionRef !== undefined
        ? ` version ${input.versionRef}`
        : "";
  switch (input.decision) {
    case "approved":
      return `On ${when}, ${who} approved ${input.milestoneTitle}${pinned}.`.trim();
    case "revision_requested":
      return `On ${when}, ${who} requested a revision on ${input.milestoneTitle}${pinned}.`.trim();
    case "rejected":
      return `On ${when}, ${who} recorded a rejection on ${input.milestoneTitle}${pinned}.`.trim();
    case "disputed":
      return `On ${when}, ${who} recorded a dispute on ${input.milestoneTitle}${pinned}.`.trim();
    default:
      return `On ${when}, ${who} recorded a ${input.decision} decision on ${input.milestoneTitle}${pinned}.`.trim();
  }
}

/** Build the canonical factual snapshot. Never throws on empty inputs. */
export function buildEvidencePackSnapshot(input: EvidencePackBuilderInput): EvidencePackSnapshot {
  const orderedEvents = [...input.events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  const firstEvent = orderedEvents[0];
  const lastEvent = orderedEvents[orderedEvents.length - 1];
  const orderedAgreements = [...input.agreements].sort((a, b) => a.version - b.version);
  const orderedMilestones = [...input.milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  const currentAgreement =
    orderedAgreements.filter((a) => a.status === "accepted").at(-1) ?? orderedAgreements.at(-1);

  const milestonesTotalCents = orderedMilestones.reduce((sum, m) => sum + m.amountCents, 0);
  const verifiedPaidCents = input.payments
    .filter((p) => verificationTierForPaymentState(p.state) === "provider_confirmed")
    .reduce((sum, p) => sum + p.amountCents, 0);

  const timeline = orderedEvents.map((e) => {
    const described = describeEvent({
      type: e.type,
      ...(e.milestoneTitle !== undefined ? { milestoneTitle: e.milestoneTitle } : {}),
      payload: e.payload ?? {},
    });
    return {
      id: e.id,
      type: e.type,
      category: eventCategory(e.type),
      headline: described.headline,
      detail: described.detail,
      actorType: e.actorType,
      ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
      ...(e.milestoneTitle !== undefined ? { milestoneTitle: e.milestoneTitle } : {}),
      occurredAt: iso(e.occurredAt),
    };
  });

  const revisions = orderedEvents
    .filter((e) => e.type === "RevisionRequested" || e.type === "RevisionSubmitted")
    .map((e) => ({
      ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
      ...(e.milestoneTitle !== undefined ? { milestoneTitle: e.milestoneTitle } : {}),
      type: e.type,
      occurredAt: iso(e.occurredAt),
      statement:
        e.type === "RevisionRequested"
          ? `On ${dateOnly(e.occurredAt)}, ${actorLabel(e.actorType)} requested a revision${e.milestoneTitle ? ` on ${e.milestoneTitle}` : ""}.`
          : `On ${dateOnly(e.occurredAt)}, ${actorLabel(e.actorType)} submitted a revision${e.milestoneTitle ? ` for ${e.milestoneTitle}` : ""}.`,
    }));

  const approvals = [...input.approvals]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((a) => ({
      milestoneId: a.milestoneId,
      milestoneTitle: a.milestoneTitle,
      decision: a.decision,
      ...(a.versionNo !== undefined ? { versionNo: a.versionNo } : {}),
      ...(a.versionRef !== undefined ? { versionRef: a.versionRef } : {}),
      ...(a.note !== undefined ? { note: a.note } : {}),
      actorType: a.actorType,
      createdAt: iso(a.createdAt),
      statement: approvalStatement({
        actorType: a.actorType,
        decision: a.decision,
        milestoneTitle: a.milestoneTitle,
        ...(a.versionNo !== undefined ? { versionNo: a.versionNo } : {}),
        ...(a.versionRef !== undefined ? { versionRef: a.versionRef } : {}),
        occurredAt: a.createdAt,
      }),
    }));

  const snapshot: EvidencePackSnapshot = {
    packVersion: EVIDENCE_PACK_VERSION,
    generatedAt: iso(input.generatedAt),
    generatedBy: input.generatedBy,
    parties: {
      freelancerWorkspace: input.parties.workspaceName,
      clientName: input.parties.clientName,
      ...(input.parties.clientCompany !== undefined
        ? { clientCompany: input.parties.clientCompany }
        : {}),
      clientEmail: input.parties.clientEmail,
    },
    project: {
      id: input.project.id,
      title: input.project.title,
      ...(input.project.description !== undefined
        ? { description: input.project.description }
        : {}),
      currency: input.project.currency,
      totalValueCents: input.project.totalValueCents,
      status: input.project.status,
      ...(input.project.paymentTerms !== undefined
        ? { paymentTerms: input.project.paymentTerms }
        : {}),
      ...(input.project.startDate !== undefined ? { startDate: iso(input.project.startDate) } : {}),
      ...(input.project.expectedCompletion !== undefined
        ? { expectedCompletion: iso(input.project.expectedCompletion) }
        : {}),
      createdAt: iso(input.project.createdAt),
    },
    agreement: {
      ...(currentAgreement !== undefined ? { currentVersion: currentAgreement.version } : {}),
      ...(currentAgreement !== undefined ? { currentStatus: currentAgreement.status } : {}),
      versionHashes: orderedAgreements.map((a) => a.hash),
      versions: orderedAgreements.map((a) => ({
        version: a.version,
        status: a.status,
        hash: a.hash,
        totalAmountCents: a.totalAmountCents,
        currency: a.currency,
        depositAmountCents: a.depositAmountCents,
        paymentDueDays: a.paymentDueDays,
        graceDays: a.graceDays,
        acceptedPaymentMethods: [...a.acceptedPaymentMethods],
        ...(a.sentAt !== undefined ? { sentAt: iso(a.sentAt) } : {}),
        ...(a.acceptedAt !== undefined ? { acceptedAt: iso(a.acceptedAt) } : {}),
        ...(a.acceptedBy !== undefined ? { acceptedBy: a.acceptedBy } : {}),
      })),
    },
    milestones: orderedMilestones.map((m) => ({
      id: m.id,
      title: m.title,
      amountCents: m.amountCents,
      currency: m.currency,
      ...(m.dueDate !== undefined ? { dueDate: iso(m.dueDate) } : {}),
      workState: m.workState,
      paymentState: m.paymentState,
      approvalState: m.approvalState,
      orderIndex: m.orderIndex,
    })),
    financialSummary: {
      currency: input.project.currency,
      milestonesTotalCents,
      verifiedPaidCents,
      outstandingCents: Math.max(0, milestonesTotalCents - verifiedPaidCents),
      verifiedOnlyNote:
        "Only provider-confirmed receipts count as paid. Client claims without a provider receipt do not reduce the outstanding balance.",
    },
    payments: [...input.payments]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => {
        const tier = verificationTierForPaymentState(p.state);
        return {
          id: p.id,
          ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
          amountCents: p.amountCents,
          currency: p.currency,
          state: p.state,
          verificationTier: tier,
          verified: tier === "provider_confirmed",
          provider: p.provider,
          createdAt: iso(p.createdAt),
          ...(p.receivedAt !== undefined ? { receivedAt: iso(p.receivedAt) } : {}),
        };
      }),
    deliverables: input.deliverables.map((d) => ({
      id: d.id,
      milestoneId: d.milestoneId,
      milestoneTitle: d.milestoneTitle,
      title: d.title,
      status: d.status,
      currentVersionNo: d.currentVersionNo,
      ...(d.approvedVersionNo !== undefined ? { approvedVersionNo: d.approvedVersionNo } : {}),
      versions: d.versions.map((v) => ({
        versionNo: v.versionNo,
        createdAt: iso(v.createdAt),
        fileCount: v.fileCount,
        linkCount: v.linkCount,
      })),
    })),
    approvals,
    revisions,
    reminders: [...input.reminders]
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
      .map((r) => ({
        id: r.id,
        ...(r.milestoneId !== undefined ? { milestoneId: r.milestoneId } : {}),
        template: r.template,
        state: r.state,
        recipient: r.recipient,
        scheduledFor: iso(r.scheduledFor),
        ...(r.sentAt !== undefined ? { sentAt: iso(r.sentAt) } : {}),
      })),
    paymentPlans: [...input.paymentPlans]
      .sort((a, b) => a.version - b.version)
      .map((p) => ({
        id: p.id,
        milestoneId: p.milestoneId,
        milestoneTitle: p.milestoneTitle,
        version: p.version,
        state: p.state,
        originalAmountCents: p.originalAmountCents,
        currency: p.currency,
        offeredAt: iso(p.offeredAt),
        ...(p.acceptedAt !== undefined ? { acceptedAt: iso(p.acceptedAt) } : {}),
        installments: p.installments.map((i) => ({
          seq: i.seq,
          amountCents: i.amountCents,
          dueDate: iso(i.dueDate),
          status: i.status,
        })),
      })),
    timeline,
    integrity: {
      eventCount: orderedEvents.length,
      ...(firstEvent !== undefined ? { oldestEventAt: iso(firstEvent.occurredAt) } : {}),
      ...(lastEvent !== undefined ? { newestEventAt: iso(lastEvent.occurredAt) } : {}),
      agreementVersionHashes: orderedAgreements.map((a) => a.hash),
    },
    disclaimer: EVIDENCE_PACK_DISCLAIMER,
    disclaimerVersion: EVIDENCE_PACK_DISCLAIMER_VERSION,
    noGuarantee: EVIDENCE_PACK_NO_GUARANTEE,
  };

  assertFactualCopy(JSON.stringify(snapshot));
  return snapshot;
}

/** Stable canonical JSON (sorted keys) so the sha256 pins exact bytes. */
export function canonicalizeSnapshot(snapshot: EvidencePackSnapshot): string {
  return stableStringify(snapshot);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the canonical bytes — the integrity pin stored on the row. */
export function hashEvidencePack(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function section(title: string, inner: string): string {
  return `<section class="card"><div class="card-head"><h2>${escapeHtml(title)}</h2></div><div class="card-body">${inner}</div></section>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `<p class="sub">No records in this section.</p>`;
  return `<table class="table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

/**
 * Clean printable rendering of the snapshot. Served as HTML so the
 * freelancer can print/save-as-PDF for their records, accountant, mediator,
 * collections professional, lawyer, or court/tribunal review. Uses the same
 * calm workspace stylesheet (no inline scripts; print-friendly tables).
 */
export function renderEvidencePackHtml(
  snapshot: EvidencePackSnapshot,
  meta: { packId: string; sha256: string; artifactRef: string },
): string {
  const esc = escapeHtml;
  const timelineRows = snapshot.timeline.map((e) => [
    esc(e.occurredAt.slice(0, 16).replace("T", " ")),
    `<strong>${esc(e.headline)}</strong><br /><span class="stat-hint">${esc(e.detail)}</span>`,
    esc(e.category),
    esc(e.actorType),
  ]);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Evidence pack — ${esc(snapshot.project.title)}</title>
<link rel="stylesheet" href="/app/styles.css" />
</head>
<body>
<main class="wrap">
<p class="eyebrow">Evidence pack · generated ${esc(snapshot.generatedAt.slice(0, 16).replace("T", " "))} UTC</p>
<h1 class="h1">${esc(snapshot.project.title)}</h1>
<p class="sub">Factual workflow record for ${esc(snapshot.parties.freelancerWorkspace)} and ${esc(snapshot.parties.clientName)}. ${esc(snapshot.disclaimer)} ${esc(snapshot.noGuarantee)}</p>
${section("Parties", `<table class="table"><tbody><tr><th scope="row">Freelancer workspace</th><td>${esc(snapshot.parties.freelancerWorkspace)}</td></tr><tr><th scope="row">Client</th><td>${esc(snapshot.parties.clientName)}${snapshot.parties.clientCompany ? ` · ${esc(snapshot.parties.clientCompany)}` : ""} · ${esc(snapshot.parties.clientEmail)}</td></tr></tbody></table>`)}
${section("Project", `<table class="table"><tbody><tr><th scope="row">Title</th><td>${esc(snapshot.project.title)}</td></tr>${snapshot.project.description ? `<tr><th scope="row">Description</th><td>${esc(snapshot.project.description)}</td></tr>` : ""}<tr><th scope="row">Total value</th><td>${esc(money(snapshot.project.totalValueCents, snapshot.project.currency))} ${esc(snapshot.project.currency)}</td></tr><tr><th scope="row">Status</th><td>${esc(snapshot.project.status)}</td></tr>${snapshot.project.paymentTerms ? `<tr><th scope="row">Payment terms</th><td>${esc(snapshot.project.paymentTerms)}</td></tr>` : ""}</tbody></table>`)}
${section(
  "Agreement",
  snapshot.agreement.versions.length === 0
    ? `<p class="sub">No agreement versions recorded.</p>`
    : table(
        ["Version", "Status", "Hash (short)", "Total", "Sent", "Accepted"],
        snapshot.agreement.versions.map((a) => [
          esc(`v${a.version}`),
          esc(a.status),
          esc(a.hash.slice(0, 12)),
          esc(money(a.totalAmountCents, a.currency)),
          esc(a.sentAt?.slice(0, 10) ?? "—"),
          esc(a.acceptedAt?.slice(0, 10) ?? "—"),
        ]),
      ),
)}
${section(
  "Milestones",
  table(
    ["Order", "Milestone", "Amount", "Due", "Work", "Payment", "Approval"],
    snapshot.milestones.map((m) => [
      esc(String(m.orderIndex + 1)),
      esc(m.title),
      esc(money(m.amountCents, m.currency)),
      esc(m.dueDate?.slice(0, 10) ?? "—"),
      esc(m.workState),
      esc(m.paymentState),
      esc(m.approvalState),
    ]),
  ),
)}
${section("Financial summary", `<table class="table"><tbody><tr><th scope="row">Milestones total</th><td>${esc(money(snapshot.financialSummary.milestonesTotalCents, snapshot.financialSummary.currency))}</td></tr><tr><th scope="row">Verified paid</th><td>${esc(money(snapshot.financialSummary.verifiedPaidCents, snapshot.financialSummary.currency))}</td></tr><tr><th scope="row">Outstanding</th><td>${esc(money(snapshot.financialSummary.outstandingCents, snapshot.financialSummary.currency))}</td></tr></tbody></table><p class="sub">${esc(snapshot.financialSummary.verifiedOnlyNote)}</p>`)}
${section(
  "Payments",
  table(
    ["Date", "Milestone", "Amount", "State", "Verification"],
    snapshot.payments.map((p) => [
      esc(p.createdAt.slice(0, 10)),
      esc(p.milestoneId ?? "—"),
      esc(money(p.amountCents, p.currency)),
      esc(p.state),
      esc(
        p.verified
          ? "Provider-confirmed — verified receipt"
          : `Not counted as paid (${p.verificationTier})`,
      ),
    ]),
  ),
)}
${section(
  "Deliverables",
  table(
    ["Deliverable", "Milestone", "Status", "Current", "Approved"],
    snapshot.deliverables.map((d) => [
      esc(d.title),
      esc(d.milestoneTitle),
      esc(d.status),
      esc(`v${d.currentVersionNo}`),
      esc(d.approvedVersionNo !== undefined ? `v${d.approvedVersionNo}` : "—"),
    ]),
  ),
)}
${section("Approvals", snapshot.approvals.length === 0 ? `<p class="sub">No approval decisions recorded.</p>` : `<ul class="timeline">${snapshot.approvals.map((a) => `<li><time>${esc(a.createdAt.slice(0, 10))}</time><span>${esc(a.statement)}${a.note ? `<br /><span class="stat-hint">Note: ${esc(a.note)}</span>` : ""}</span></li>`).join("")}</ul>`)}
${section("Revisions", snapshot.revisions.length === 0 ? `<p class="sub">No revision requests or submissions recorded.</p>` : `<ul class="timeline">${snapshot.revisions.map((r) => `<li><time>${esc(r.occurredAt.slice(0, 10))}</time><span>${esc(r.statement)}</span></li>`).join("")}</ul>`)}
${section(
  "Reminder history",
  table(
    ["Scheduled", "Template", "State", "Sent"],
    snapshot.reminders.map((r) => [
      esc(r.scheduledFor.slice(0, 16).replace("T", " ")),
      esc(r.template),
      esc(r.state),
      esc(r.sentAt?.slice(0, 16).replace("T", " ") ?? "—"),
    ]),
  ),
)}
${section(
  "Payment-plan history",
  snapshot.paymentPlans.length === 0
    ? `<p class="sub">No payment plans recorded.</p>`
    : table(
        ["Plan", "Milestone", "State", "Schedule"],
        snapshot.paymentPlans.map((p) => [
          esc(`v${p.version}`),
          esc(p.milestoneTitle),
          esc(p.state),
          esc(
            p.installments
              .map(
                (i) =>
                  `#${i.seq} ${money(i.amountCents, p.currency)} due ${i.dueDate.slice(0, 10)} (${i.status})`,
              )
              .join("; "),
          ),
        ]),
      ),
)}
${section(`Timeline (${snapshot.timeline.length} events)`, timelineRows.length === 0 ? `<p class="sub">No events recorded.</p>` : table(["When (UTC)", "What happened", "Category", "Actor"], timelineRows))}
${section("Integrity", `<table class="table"><tbody><tr><th scope="row">Pack id</th><td>${esc(meta.packId)}</td></tr><tr><th scope="row">Canonical sha256</th><td><code>${esc(meta.sha256)}</code></td></tr><tr><th scope="row">Artifact ref</th><td>${esc(meta.artifactRef)}</td></tr><tr><th scope="row">Agreement hashes</th><td>${snapshot.integrity.agreementVersionHashes.length === 0 ? "None recorded" : snapshot.integrity.agreementVersionHashes.map((h) => `<code>${esc(h.slice(0, 16))}</code>`).join(" ")}</td></tr><tr><th scope="row">Event range</th><td>${esc(String(snapshot.integrity.eventCount))} events${snapshot.integrity.oldestEventAt ? ` · ${esc(snapshot.integrity.oldestEventAt)} → ${esc(snapshot.integrity.newestEventAt ?? "")}` : ""}</td></tr></tbody></table><p class="sub">To use as a PDF: print this page and choose “Save as PDF”. The sha256 above identifies these exact bytes.</p>`)}
<footer class="wrap foot">${esc(snapshot.disclaimer)} ${esc(snapshot.noGuarantee)}</footer>
</main>
</body>
</html>`;
  assertFactualCopy(html);
  return html;
}
