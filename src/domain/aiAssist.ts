/**
 * AI-assisted payment-protection helpers (Session 17).
 *
 * Scope decision: AI is used ONLY where it materially improves the
 * payment-protection workflow — and never as a marketing chatbot. The five
 * supported functions mirror the session task:
 *
 *  1. Contract/terms extraction (payment terms, milestones, deadlines,
 *     late-fee language, revision terms, final-delivery conditions).
 *  2. Communication extraction (approval, revision request, promised payment
 *     date, payment-plan discussion, deliverable acceptance).
 *  3. Reminder drafting (professional payment messages built from project
 *     facts — amounts/dates come from the database, never from free text).
 *  4. Evidence summarization (factual timeline restatement, no conclusions).
 *  5. Agreement consistency check (invoice/agreement/milestone contradictions).
 *
 * Safety model (enforced by tests + the route layer):
 * - EXTRACTIVE, not generative. Every extracted candidate carries a verbatim
 *   `quote` that is a substring of the caller's source text. When nothing
 *   matches, the field reports `found: false` — the module never invents
 *   terms, dates, payments, or rights.
 * - No financial writes. This module has no store access; the routes that
 *   call it never create payments, reminders, or events. Drafts are returned
 *   with `reviewRequired: true` and must be reviewed before being sent or
 *   recorded anywhere.
 * - No character judgements (`assertAssistCopy()` rejects scammer/fraud/…).
 * - No legal conclusions or outcome guarantees (rejects sue/liable/breach/
 *   "guarantee" phrasing). Every output carries the informational disclaimer.
 *
 * Engine note: the implementation is a local deterministic extractor
 * (`assistive-v1`). It is deliberately boring: given the hallucination risk
 * of generative models around money and contracts, extractive matching with
 * verbatim quotes is the honest default. A future LLM provider could sit
 * behind the same review-required envelope, but must keep every guarantee
 * above (quotes, no silent writes, no legal advice).
 */

export const AI_ASSIST_ENGINE = "assistive-v1 (extractive, local)";
export const AI_ASSIST_DISCLAIMER =
  "AI-assisted draft from project records and pasted text. Review before sending or recording. Informational workflow record — not legal advice. Enforcement is jurisdiction-dependent.";
export const AI_ASSIST_REVIEW_NOTE =
  "No financial records were changed. Nothing was sent. Review this draft before using it.";

const BANNED_ASSIST_PHRASES = [
  "scammer",
  "scam",
  "bad client",
  "dishonest",
  "fraudulent",
  "fraud",
  "untrustworthy",
  "shady",
  "cheat",
  "guilty",
  "liable",
  "liability",
  "breach of contract",
  "theft",
  "stole",
  "sue you",
  "we will sue",
  "going to sue",
  "take you to court",
  "see you in court",
  "lawsuit",
  "legal action",
  "guarantees success",
  "guarantee success",
  "guaranteed to win",
  "will win the dispute",
];

/** Throws when assistive copy drifts into labelling, legal threats, or outcome guarantees. */
export function assertAssistCopy(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_ASSIST_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(`AI-assist copy must stay professional and factual (found "${phrase}")`);
    }
  }
}

export const AI_ASSIST_MAX_SOURCE_CHARS = 20000;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function matchingQuotes(text: string, patterns: readonly RegExp[], maxQuotes = 3): string[] {
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length > 500) continue;
    if (patterns.some((p) => p.test(sentence))) {
      if (!out.includes(sentence)) out.push(sentence);
      if (out.length >= maxQuotes) break;
    }
  }
  // Paranoia: every quote must be a verbatim substring of the source.
  return out.filter((q) => text.includes(q));
}

const DATE_PATTERN =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{1,2}(?:st|nd|rd|th)?(?:,?\s\d{4})?)\b/i;
const MONEY_PATTERN =
  /\$[\d,]+(?:\.\d{2})?|\b\d+(?:,\d{3})*(?:\.\d{2})?\s?(?:USD|EUR|GBP|INR|CAD|AUD)\b/i;

// ---------------------------------------------------------------------------
// 1. Contract/terms extraction
// ---------------------------------------------------------------------------

export type ContractFieldKey =
  "payment_terms" | "milestones" | "deadlines" | "late_fee" | "revision_terms" | "final_delivery";

export interface ContractFieldCandidate {
  readonly field: ContractFieldKey;
  readonly label: string;
  readonly found: boolean;
  /** Verbatim substrings of the source text (empty when not found). */
  readonly quotes: readonly string[];
  readonly note: string;
}

export interface ContractExtraction {
  readonly engine: string;
  readonly reviewRequired: true;
  readonly fields: readonly ContractFieldCandidate[];
  readonly missingFields: readonly ContractFieldKey[];
  readonly disclaimer: string;
}

const CONTRACT_PATTERNS: Record<ContractFieldKey, { label: string; patterns: RegExp[] }> = {
  payment_terms: {
    label: "Payment terms",
    patterns: [
      /payment terms?/i,
      /\bnet\s?\d+\b/i,
      /payment (is )?due (in|within|on)/i,
      /due (in|within) \d+ days?/i,
      /payable (on|within|upon)/i,
      /accepted payment methods?/i,
    ],
  },
  milestones: {
    label: "Milestones",
    patterns: [
      /\bmilestone\b/i,
      /\bphase\b/i,
      /milestone schedule/i,
      /\bdeliverable\b.*\$|\$.*\bmilestone\b/i,
    ],
  },
  deadlines: {
    label: "Deadlines",
    patterns: [
      /\bdeadline\b/i,
      /\bdue date\b/i,
      /due (on|by|before)/i,
      /deliver (by|on|before)/i,
      /completion date/i,
      DATE_PATTERN,
    ],
  },
  late_fee: {
    label: "Late-fee language",
    patterns: [
      /late[- ]?fee/i,
      /late[- ]?payment/i,
      /\bpenalty\b/i,
      /\binterest\b.*(%|per month|per annum)/i,
      /% per month/i,
      /overdue.*(fee|charge|interest)/i,
    ],
  },
  revision_terms: {
    label: "Revision terms",
    patterns: [
      /\brevision\b/i,
      /\brework\b/i,
      /rounds? of (changes|revisions|feedback)/i,
      /change request/i,
      /extra revision/i,
      /revision limit/i,
    ],
  },
  final_delivery: {
    label: "Final-delivery conditions",
    patterns: [
      /final[- ]?deliver/i,
      /final files?/i,
      /\bhandover\b/i,
      /transfer.*(production|ownership|files?)/i,
      /ownership.*(transfer|payment)/i,
      /upon (final )?payment/i,
      /release.*(final|files?|deliverable)/i,
    ],
  },
};

/** Extractive scan of pasted agreement/terms text. Never invents: quotes only. */
export function extractContractTerms(sourceText: string): ContractExtraction {
  if (sourceText.trim().length === 0) {
    throw new Error("sourceText must not be empty");
  }
  if (sourceText.length > AI_ASSIST_MAX_SOURCE_CHARS) {
    throw new Error(`sourceText must be ≤ ${AI_ASSIST_MAX_SOURCE_CHARS} chars`);
  }
  const fields = (Object.keys(CONTRACT_PATTERNS) as ContractFieldKey[]).map(
    (field): ContractFieldCandidate => {
      const spec = CONTRACT_PATTERNS[field];
      const quotes = matchingQuotes(sourceText, spec.patterns);
      const found = quotes.length > 0;
      const note = found
        ? `Quoted verbatim from the pasted text — confirm against the signed agreement before recording.`
        : `Not detected in the pasted text — add it to the agreement explicitly rather than assuming a default.`;
      for (const q of quotes) assertAssistCopy(q);
      return { field, label: spec.label, found, quotes, note };
    },
  );
  const missingFields = fields.filter((f) => !f.found).map((f) => f.field);
  return {
    engine: AI_ASSIST_ENGINE,
    reviewRequired: true,
    fields,
    missingFields,
    disclaimer: AI_ASSIST_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// 2. Communication extraction
// ---------------------------------------------------------------------------

export type CommunicationEventKind =
  | "approval"
  | "revision_request"
  | "promised_payment_date"
  | "payment_plan_discussion"
  | "deliverable_acceptance";

export interface CommunicationCandidate {
  readonly kind: CommunicationEventKind;
  readonly label: string;
  /** Verbatim substring of the source text. */
  readonly quote: string;
  readonly confidence: "high" | "medium";
  /** A date string found inside the quote, if any (verbatim, not parsed). */
  readonly observedDateText?: string | undefined;
  readonly note: string;
}

export interface CommunicationExtraction {
  readonly engine: string;
  readonly reviewRequired: true;
  readonly events: readonly CommunicationCandidate[];
  readonly disclaimer: string;
}

const COMMUNICATION_SPECS: {
  kind: CommunicationEventKind;
  label: string;
  patterns: RegExp[];
  confidence: "high" | "medium";
}[] = [
  {
    kind: "approval",
    label: "Approval",
    patterns: [/\bapprov/i, /\bsign[- ]?off\b/i],
    confidence: "medium",
  },
  {
    kind: "revision_request",
    label: "Revision request",
    patterns: [
      /\brevision\b/i,
      /please (change|fix|update|revise|rework)/i,
      /changes? requested/i,
      /could you (change|fix|update|tweak)/i,
    ],
    confidence: "medium",
  },
  {
    kind: "promised_payment_date",
    label: "Promised payment date",
    patterns: [
      /will pay/i,
      /pay (by|on) /i,
      /payment (on|by) /i,
      /promise(d)? to pay/i,
      /transfer (by|on) /i,
      /invoice will be (paid|cleared|settled)/i,
    ],
    confidence: "high",
  },
  {
    kind: "payment_plan_discussion",
    label: "Payment-plan discussion",
    patterns: [
      /payment plan/i,
      /\binstallments?\b/i,
      /pay in (parts|stages|installments)/i,
      /split (the )?payment/i,
      /cash[- ]?flow/i,
    ],
    confidence: "high",
  },
  {
    kind: "deliverable_acceptance",
    label: "Deliverable acceptance",
    patterns: [
      /\baccept/i,
      /looks good/i,
      /good to go/i,
      /\blgtm\b/i,
      /approved.*(deliverable|version|design|draft)/i,
      /(deliverable|version|design|draft).*approved/i,
    ],
    confidence: "medium",
  },
];

/**
 * Extractive scan of pasted client communications. Each candidate quotes the
 * source verbatim; nothing is inferred beyond the matched sentence. Recording
 * an approval/payment from this output still requires the normal flows
 * (portal approval, verified receipt) — this output only says "look here".
 */
export function extractCommunicationEvents(sourceText: string): CommunicationExtraction {
  if (sourceText.trim().length === 0) {
    throw new Error("sourceText must not be empty");
  }
  if (sourceText.length > AI_ASSIST_MAX_SOURCE_CHARS) {
    throw new Error(`sourceText must be ≤ ${AI_ASSIST_MAX_SOURCE_CHARS} chars`);
  }
  const events: CommunicationCandidate[] = [];
  for (const spec of COMMUNICATION_SPECS) {
    const quotes = matchingQuotes(sourceText, spec.patterns, 5);
    for (const quote of quotes) {
      assertAssistCopy(quote);
      const dateMatch = DATE_PATTERN.exec(quote) ?? MONEY_PATTERN.exec(quote);
      events.push({
        kind: spec.kind,
        label: spec.label,
        quote,
        confidence: spec.confidence,
        ...(dateMatch ? { observedDateText: dateMatch[0] } : {}),
        note:
          spec.kind === "promised_payment_date"
            ? "A stated date is a client assertion, not a verified payment — record payment only on provider confirmation."
            : "Candidate only — confirm in the project workflow (approval flow / verified receipt) before recording.",
      });
    }
  }
  return {
    engine: AI_ASSIST_ENGINE,
    reviewRequired: true,
    events,
    disclaimer: AI_ASSIST_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// 3. Reminder drafting (facts in, professional copy out)
// ---------------------------------------------------------------------------

export type ReminderDraftTone = "friendly" | "firm";

export interface ReminderDraftFacts {
  readonly workspaceName: string;
  readonly clientName: string;
  readonly projectTitle: string;
  readonly milestoneTitle: string;
  /** Integer cents from the milestone row — never from free text. */
  readonly amountCents: number;
  readonly currency: string;
  readonly dueDateIso: string;
  readonly daysOverdue: number;
  readonly outstandingCents: number;
  readonly portalUrl?: string | undefined;
}

export interface ReminderDraft {
  readonly engine: string;
  readonly reviewRequired: true;
  readonly tone: ReminderDraftTone;
  readonly subject: string;
  readonly body: string;
  readonly usedFacts: Record<string, string>;
  readonly financialRecordsChanged: false;
  readonly disclaimer: string;
}

function formatDraftAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/**
 * Render a review-required payment reminder strictly from database facts.
 * The caller (route) loads every fact from live rows, so the draft cannot
 * invent amounts, dates, or payment status. Sending still goes through the
 * existing manual reminder flow — this function only returns text.
 */
export function draftPaymentReminder(
  facts: ReminderDraftFacts,
  tone: ReminderDraftTone = "friendly",
): ReminderDraft {
  if (!Number.isInteger(facts.amountCents) || facts.amountCents <= 0) {
    throw new Error("amountCents must be a positive integer from the milestone record");
  }
  if (!/^[A-Za-z]{3}$/.test(facts.currency)) {
    throw new Error("currency must be a 3-letter ISO code from the project record");
  }
  const amount = formatDraftAmount(facts.amountCents, facts.currency);
  const overdueLine =
    facts.daysOverdue > 0
      ? `${facts.daysOverdue} day(s) overdue (due ${facts.dueDateIso}).`
      : `due ${facts.dueDateIso}.`;
  const portalLine = facts.portalUrl
    ? `You can review and complete payment here: ${facts.portalUrl}`
    : `Your freelancer can share a payment link on request.`;
  const subject =
    tone === "firm"
      ? `Follow-up — ${facts.milestoneTitle} ${overdueLine}`
      : `Reminder — ${facts.milestoneTitle} ${overdueLine}`;
  const body = [
    `Hello ${facts.clientName},`,
    ``,
    tone === "firm"
      ? `A follow-up from the ${facts.workspaceName} workflow on ${facts.projectTitle}: ${facts.milestoneTitle} of ${amount} is ${overdueLine}`
      : `A quick reminder from the ${facts.workspaceName} workflow on ${facts.projectTitle}: ${facts.milestoneTitle} of ${amount} is ${overdueLine}`,
    ``,
    portalLine,
    ``,
    `If payment is already on its way, no need to reply — the workflow confirms verified payments automatically.`,
    ``,
    `Thank you,`,
    `(${facts.workspaceName} workflow — review before sending. Not legal advice.)`,
  ].join("\n");
  assertAssistCopy(`${subject}\n${body}`);
  const usedFacts: Record<string, string> = {
    workspaceName: facts.workspaceName,
    clientName: facts.clientName,
    projectTitle: facts.projectTitle,
    milestoneTitle: facts.milestoneTitle,
    amount: amount,
    currency: facts.currency.toUpperCase(),
    dueDate: facts.dueDateIso,
    daysOverdue: String(facts.daysOverdue),
    outstanding: formatDraftAmount(facts.outstandingCents, facts.currency),
  };
  return {
    engine: AI_ASSIST_ENGINE,
    reviewRequired: true,
    tone,
    subject,
    body,
    usedFacts,
    financialRecordsChanged: false,
    disclaimer: AI_ASSIST_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// 4. Evidence summarization (restatement only)
// ---------------------------------------------------------------------------

export interface SummarizeEventInput {
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly headline: string;
  readonly type: string;
}

export interface EvidenceSummary {
  readonly engine: string;
  readonly reviewRequired: true;
  readonly eventCount: number;
  readonly oldestAt?: string | undefined;
  readonly newestAt?: string | undefined;
  /** One factual bullet per event, chronological. No conclusions. */
  readonly bullets: readonly string[];
  readonly countsByActor: Record<string, number>;
  readonly note: string;
  readonly financialRecordsChanged: false;
  readonly disclaimer: string;
}

function actorPhrase(actorType: string): string {
  if (actorType === "client") return "the client";
  if (actorType === "freelancer") return "the freelancer";
  if (actorType === "provider") return "the payment provider";
  return "the system";
}

/**
 * Restate a chronological event list as plain bullets. The summary adds no
 * facts: every bullet reuses the event's recorded headline + date + actor.
 * In particular it never declares fault, fraud, or legal outcomes.
 */
export function summarizeEvidenceTimeline(events: readonly SummarizeEventInput[]): EvidenceSummary {
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const bullets = ordered.map((e) => {
    const day = e.occurredAt.toISOString().slice(0, 10);
    const line = `On ${day}, ${actorPhrase(e.actorType)} — ${e.headline}`.trim();
    assertAssistCopy(line);
    return line;
  });
  const countsByActor: Record<string, number> = {};
  for (const e of ordered) {
    countsByActor[e.actorType] = (countsByActor[e.actorType] ?? 0) + 1;
  }
  return {
    engine: AI_ASSIST_ENGINE,
    reviewRequired: true,
    eventCount: ordered.length,
    ...(ordered[0] ? { oldestAt: ordered[0].occurredAt.toISOString() } : {}),
    ...(ordered[ordered.length - 1]
      ? { newestAt: ordered[ordered.length - 1]?.occurredAt.toISOString() }
      : {}),
    bullets,
    countsByActor,
    note: `${ordered.length} recorded event(s) restated. This is a reading aid — verify against the full evidence timeline before relying on it.`,
    financialRecordsChanged: false,
    disclaimer: AI_ASSIST_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// 5. Agreement consistency check
// ---------------------------------------------------------------------------

export interface ConsistencyAgreementInput {
  readonly version: number;
  readonly status: string;
  readonly totalAmountCents: number;
  readonly depositAmountCents: number;
  readonly schedule: readonly { title: string; amountCents: number }[];
  readonly finalDeliveryDescription: string;
  readonly lateFeeKind: string;
  readonly maxRevisionsPerMilestone: number;
}

export interface ConsistencyMilestoneInput {
  readonly id: string;
  readonly title: string;
  readonly amountCents: number;
  readonly orderIndex: number;
  readonly dueDate?: Date | undefined;
}

export interface ConsistencyFinding {
  readonly code: string;
  readonly severity: "attention" | "info";
  readonly detail: string;
  readonly evidence: Record<string, unknown>;
}

export interface ConsistencyReport {
  readonly engine: string;
  readonly reviewRequired: true;
  readonly attentionCount: number;
  readonly findings: readonly ConsistencyFinding[];
  readonly financialRecordsChanged: false;
  readonly disclaimer: string;
}

/**
 * Compare the accepted/current agreement against live milestones + project
 * total. Reports contradictions as observable facts (amounts, dates,
 * missing clauses) — never as legal conclusions, and never by editing rows.
 */
export function checkAgreementConsistency(input: {
  agreement?: ConsistencyAgreementInput | undefined;
  milestones: readonly ConsistencyMilestoneInput[];
  projectTotalCents: number;
}): ConsistencyReport {
  const findings: ConsistencyFinding[] = [];
  const push = (f: ConsistencyFinding): void => {
    assertAssistCopy(f.detail);
    findings.push(f);
  };

  if (!input.agreement) {
    push({
      code: "no_agreement_for_consistency",
      severity: "attention",
      detail:
        "No agreement version is on file, so invoice and delivery terms have no recorded basis.",
      evidence: {
        milestoneCount: input.milestones.length,
        projectTotalCents: input.projectTotalCents,
      },
    });
    return {
      engine: AI_ASSIST_ENGINE,
      reviewRequired: true,
      attentionCount: findings.filter((f) => f.severity === "attention").length,
      findings,
      financialRecordsChanged: false,
      disclaimer: AI_ASSIST_DISCLAIMER,
    };
  }
  const agreement = input.agreement;

  const scheduleTotal = agreement.schedule.reduce((s, m) => s + m.amountCents, 0);
  const milestoneTotal = input.milestones.reduce((s, m) => s + m.amountCents, 0);

  if (scheduleTotal !== agreement.totalAmountCents) {
    push({
      code: "agreement_schedule_total_mismatch",
      severity: "attention",
      detail: `Agreement v${agreement.version} schedule sums to ${scheduleTotal} cents but the agreement total is ${agreement.totalAmountCents} cents.`,
      evidence: {
        agreementVersion: agreement.version,
        scheduleTotalCents: scheduleTotal,
        agreementTotalCents: agreement.totalAmountCents,
      },
    });
  }
  if (milestoneTotal !== input.projectTotalCents) {
    push({
      code: "milestone_project_total_mismatch",
      severity: "attention",
      detail: `Live milestones sum to ${milestoneTotal} cents but the project total is ${input.projectTotalCents} cents.`,
      evidence: { milestoneTotalCents: milestoneTotal, projectTotalCents: input.projectTotalCents },
    });
  }
  if (milestoneTotal !== scheduleTotal) {
    push({
      code: "milestone_schedule_mismatch",
      severity: "attention",
      detail: `Live milestones sum to ${milestoneTotal} cents but agreement v${agreement.version} schedule sums to ${scheduleTotal} cents — one side changed without the other.`,
      evidence: {
        agreementVersion: agreement.version,
        milestoneTotalCents: milestoneTotal,
        scheduleTotalCents: scheduleTotal,
      },
    });
  }

  // Per-position comparison: schedule[i] vs milestone[i] by order.
  const ordered = [...input.milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  const rows = Math.max(agreement.schedule.length, ordered.length);
  for (let i = 0; i < rows; i++) {
    const expected = agreement.schedule[i];
    const actual = ordered[i];
    if (!expected || !actual) {
      push({
        code: "milestone_count_differs",
        severity: "attention",
        detail: `Agreement v${agreement.version} lists ${agreement.schedule.length} milestone(s) but the project has ${ordered.length} — counts differ at position ${i + 1}.`,
        evidence: {
          agreementVersion: agreement.version,
          scheduleCount: agreement.schedule.length,
          milestoneCount: ordered.length,
          position: i + 1,
        },
      });
      break;
    }
    if (expected.amountCents !== actual.amountCents) {
      push({
        code: "milestone_amount_mismatch",
        severity: "attention",
        detail: `Position ${i + 1}: agreement lists "${expected.title}" at ${expected.amountCents} cents but the milestone "${actual.title}" is ${actual.amountCents} cents.`,
        evidence: {
          position: i + 1,
          agreementTitle: expected.title,
          agreementAmountCents: expected.amountCents,
          milestoneId: actual.id,
          milestoneTitle: actual.title,
          milestoneAmountCents: actual.amountCents,
        },
      });
    }
  }

  const first = ordered[0];
  if (first && agreement.depositAmountCents !== first.amountCents) {
    push({
      code: "deposit_amount_mismatch",
      severity: "attention",
      detail: `Agreement deposit is ${agreement.depositAmountCents} cents but Milestone 1 ("${first.title}") is ${first.amountCents} cents.`,
      evidence: {
        agreementVersion: agreement.version,
        depositAmountCents: agreement.depositAmountCents,
        milestoneId: first.id,
        milestoneTitle: first.title,
        milestoneAmountCents: first.amountCents,
      },
    });
  }

  const noDue = ordered.filter((m) => !m.dueDate);
  if (noDue.length > 0) {
    push({
      code: "invoice_due_date_missing",
      severity: "attention",
      detail: `${noDue.length} milestone(s) have no due date, so invoice due dates cannot be derived: ${noDue.map((m) => `"${m.title}"`).join(", ")}.`,
      evidence: {
        count: noDue.length,
        milestones: noDue.map((m) => ({ milestoneId: m.id, title: m.title })),
      },
    });
  }

  if (agreement.finalDeliveryDescription.trim().length < 20) {
    push({
      code: "final_delivery_condition_missing",
      severity: "attention",
      detail: `Agreement v${agreement.version} final-delivery condition is missing or too short to act on — finals have no recorded release basis.`,
      evidence: {
        agreementVersion: agreement.version,
        descriptionLength: agreement.finalDeliveryDescription.trim().length,
      },
    });
  }

  if (agreement.lateFeeKind === "none") {
    push({
      code: "late_fee_terms_missing",
      severity: "info",
      detail: `Agreement v${agreement.version} records no late-fee terms — overdue handling falls back to reminders and work-pause policy.`,
      evidence: { agreementVersion: agreement.version, lateFeeKind: agreement.lateFeeKind },
    });
  }

  if (findings.length === 0) {
    push({
      code: "consistent",
      severity: "info",
      detail: `Agreement v${agreement.version} matches live milestones and the project total — no contradictions detected.`,
      evidence: {
        agreementVersion: agreement.version,
        milestoneCount: ordered.length,
        totalCents: input.projectTotalCents,
      },
    });
  }

  return {
    engine: AI_ASSIST_ENGINE,
    reviewRequired: true,
    attentionCount: findings.filter((f) => f.severity === "attention").length,
    findings,
    financialRecordsChanged: false,
    disclaimer: AI_ASSIST_DISCLAIMER,
  };
}
