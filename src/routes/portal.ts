import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AGREEMENT_DISCLAIMER,
  acceptAgreement as acceptDomain,
  hashAgreementTerms,
} from "../domain/agreement.js";
import { eventTypeForDecision, validateApprovalInput } from "../domain/approvals.js";
import {
  approveWork,
  deriveUnlockStates,
  disputeMilestone,
  markClaimed,
  rejectWork,
  requestFunding,
  requestRevision,
  type MilestoneState,
} from "../domain/milestone.js";
import { buildPortalView, toPortalClient } from "../domain/portal.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import { hashToken, issueMagicLink, verifyMagicLink } from "../lib/magicLink.js";
import { FakePaymentProvider, NoopPaymentProvider } from "../lib/providers.js";
import type { MilestoneRecord, ProjectRecord, Store } from "../lib/store.js";
import { escapeHtml, formatMoney } from "../ui/components.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { notifyLifecycle } from "./notifications.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Client-facing portal (Session 07).
 *
 * Two audiences, strictly separated:
 * - Freelancer (session auth): issue / list / revoke magic links.
 * - Client (magic-link auth, NO session): overview JSON + calm HTML page +
 *   approval / revision / payment-intent / agreement-accept actions.
 *
 * Security rules:
 * - Identity for freelancer routes comes from the verified session only.
 * - Identity for client routes comes from the verified magic link only:
 *   single-project scope, expiry, sha256-stored hash, revocation checked.
 * - Client-supplied IDs (milestoneId, agreementId) are NEVER trusted:
 *   each is re-loaded and its projectId must equal the portal projectId,
 *   otherwise generic 404. Cross-project tokens fail closed with 401.
 * - Freelancer-only fields (client.notes, billing contacts, IP/UA hashes,
 *   amountHistory internals) never leave the server: the portal view is
 *   built by `domain/portal.ts` from an explicit safe subset.
 * - Client claims never mark paid (invariant): the pay action records a
 *   `PaymentRequested` event and moves unpaid work to `payment_pending`
 *   only; `paid` comes from verified provider receipts in a later slice.
 * - Language is professional, never adversarial: "ready for review",
 *   "payment completes it", never collection threats.
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});
const workspaceProjectLinkParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  linkId: uuidSchema,
});
const portalProjectParam = z.object({ projectId: uuidSchema });
const portalAgreementParam = z.object({ projectId: uuidSchema, agreementId: uuidSchema });
const portalPaymentParam = z.object({ projectId: uuidSchema, paymentId: uuidSchema });

const issueLinkSchema = z.object({
  ttlHours: z.coerce.number().int().min(1).max(720).optional(),
});
const tokenQuerySchema = z.object({ token: z.string().min(1, "required") });
const portalStatusQuerySchema = z.object({
  token: z.string().min(1, "required"),
});
const portalSuccessQuerySchema = z.object({
  token: z.string().min(1, "required"),
  paymentId: uuidSchema,
});
const approveSchema = z.object({
  token: z.string().min(1, "required"),
  milestoneId: uuidSchema,
});
const revisionSchema = z.object({
  token: z.string().min(1, "required"),
  milestoneId: uuidSchema,
  note: z.string().trim().min(3, "Tell us what to change (at least 3 characters)").max(2000),
});
const decisionSchema = z.object({
  token: z.string().min(1, "required"),
  milestoneId: uuidSchema,
  note: z.string().trim().min(3, "Please add a short note (at least 3 characters)").max(2000),
});
const paySchema = z.object({
  token: z.string().min(1, "required"),
  milestoneId: uuidSchema,
});
const claimSchema = z.object({
  token: z.string().min(1, "required"),
  milestoneId: uuidSchema,
  note: z.string().trim().max(500).optional(),
});
const portalAcceptSchema = z.object({
  token: z.string().min(1, "required"),
  acceptedBy: z.string().trim().min(1, "required").max(120),
});

const PORTAL_LINK_INVALID =
  "This link is invalid or has expired. Ask your studio for a fresh link.";

function strField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function numField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function toDomain(r: MilestoneRecord): MilestoneState {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    ...(r.description !== undefined ? { description: r.description } : {}),
    amountCents: r.amountCents,
    currency: r.currency,
    orderIndex: r.orderIndex,
    ...(r.dueDate !== undefined ? { dueDate: r.dueDate } : {}),
    work: r.workState as MilestoneState["work"],
    payment: r.paymentState as MilestoneState["payment"],
    approval: r.approvalState as MilestoneState["approval"],
    deliverable: r.deliverableState as MilestoneState["deliverable"],
    unlock: r.unlockState as MilestoneState["unlock"],
    appliedPaymentIds: [...r.appliedPaymentIds],
    amountHistory: r.amountHistory.map((h) => ({
      milestoneId: strField(h.milestoneId, r.id),
      oldAmountCents: numField(h.oldAmountCents, 0),
      newAmountCents: numField(h.newAmountCents, 0),
      reason: strField(h.reason, ""),
      actorId: strField(h.actorId, ""),
      changedAt:
        h.changedAt instanceof Date
          ? h.changedAt
          : new Date(strField(h.changedAt, new Date().toISOString())),
    })),
    ...(r.approvedVersionId !== undefined
      ? { approvedVersionId: r.approvedVersionId }
      : { approvedVersionId: null }),
    ...(r.currentVersionId !== undefined
      ? { currentVersionId: r.currentVersionId }
      : { currentVersionId: null }),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function refreshUnlocks(store: Store, projectId: string): Promise<void> {
  const rows = await store.listMilestones(projectId);
  const derived = deriveUnlockStates(rows.map(toDomain));
  for (const d of derived) {
    const current = rows.find((r) => r.id === d.id);
    if (current?.unlockState !== d.unlock) {
      await store.updateMilestone(d.id, { unlockState: d.unlock });
    }
  }
}

function hashRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Device metadata for approval audit rows: sha256 hashes ONLY. Raw IPs and
 * user-agents are never persisted — the hashes prove "same client, same
 * device family" for evidence without creating a PII store.
 */
function deviceHashes(request: { headers: Record<string, unknown>; ip: string }): {
  ipHash?: string | undefined;
  uaHash?: string | undefined;
} {
  const forwarded = request.headers["x-forwarded-for"];
  const ip =
    Array.isArray(forwarded) && typeof forwarded[0] === "string"
      ? forwarded[0]
      : typeof forwarded === "string"
        ? forwarded
        : request.ip;
  const ua = request.headers["user-agent"];
  const out: { ipHash?: string | undefined; uaHash?: string | undefined } = {};
  const ipHash = hashRef(ip);
  if (ipHash) out.ipHash = ipHash;
  if (typeof ua === "string") {
    const uaHash = hashRef(ua);
    if (uaHash) out.uaHash = uaHash;
  }
  return out;
}

async function authorizePortal(
  store: Store,
  sessionSecret: string,
  projectId: string,
  rawToken: unknown,
): Promise<{ project: ProjectRecord; linkId: string }> {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw AppError.unauthorized(PORTAL_LINK_INVALID);
  }
  try {
    verifyMagicLink({ token: rawToken, expectedProjectId: projectId, sessionSecret });
  } catch {
    throw AppError.unauthorized(PORTAL_LINK_INVALID);
  }
  const link = await store.findPortalLinkByTokenHash(hashToken(rawToken));
  if (link?.projectId !== projectId) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  if (link.revokedAt) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  if (link.expiresAt.getTime() <= Date.now()) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  const project = await store.findProject(projectId);
  if (!project) throw AppError.notFound("Not found");
  if (link.workspaceId !== project.workspaceId) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  return { project, linkId: link.id };
}

async function loadPortalMilestone(
  store: Store,
  projectId: string,
  milestoneId: string,
): Promise<MilestoneRecord> {
  const row = await store.findMilestone(milestoneId);
  if (row?.projectId !== projectId) throw AppError.notFound("Not found");
  return row;
}

export const PORTAL_JS = `// Client portal interactions: approve / revision / pay / accept plus
// Framer-style scroll reveal. Token travels as a hidden form field; the
// page itself was loaded with ?token=. No framework, no tracking.
(function () {
  document.documentElement.classList.add("js");
  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {}
  function initReveal() {
    var els = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
    if (els.length === 0) return;
    if (reduceMotion || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    els.forEach(function (el) { io.observe(el); });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initReveal);
  } else {
    initReveal();
  }
  function portalToken(form) {
    var input = form.querySelector('input[name="token"]');
    return input ? input.value : "";
  }
  async function submit(form) {
    var status = form.querySelector("[data-status]");
    try {
      if (status) status.textContent = "Sending…";
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = String(v); });
      if (!data.token) data.token = portalToken(form);
      var res = await fetch(form.action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error((body && body.error && body.error.message) || ("Request failed (" + res.status + ")"));
      if (status) status.textContent = (body && body.message) || "Done — thank you.";
      setTimeout(function () { window.location.reload(); }, 900);
    } catch (err) {
      if (status) status.textContent = String((err && err.message) || err);
    }
    return false;
  }
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (form && form.hasAttribute("data-portal-form")) {
      e.preventDefault();
      submit(form);
    }
  });
})();
`;

function renderPortalPage(args: {
  projectId: string;
  token: string;
  view: ReturnType<typeof buildPortalView>;
}): string {
  const { projectId, token, view } = args;
  const t = escapeHtml(token);
  const money = (cents: number): string => formatMoney(cents, view.currency);
  const howItWorks = `<section class="card reveal"><div class="card-head"><h2>How this works</h2></div><div class="card-body"><ol class="steps">
<li class="step"><span class="step-n" aria-hidden="true">1</span><span><strong>Review the preview</strong><br /><span class="stat-hint">Previews are for review only — screenshots aside, finals stay locked.</span></span></li>
<li class="step"><span class="step-n" aria-hidden="true">2</span><span><strong>Approve, or request changes</strong><br /><span class="stat-hint">Approval pins that exact version, with your note when changes are needed.</span></span></li>
<li class="step"><span class="step-n" aria-hidden="true">3</span><span><strong>Complete payment</strong><br /><span class="stat-hint">Hosted checkout. Only verified provider receipts count — “I’ve paid” notes stay unverified until confirmed.</span></span></li>
<li class="step"><span class="step-n" aria-hidden="true">4</span><span><strong>Receive the final files</strong><br /><span class="stat-hint">Finals unlock automatically once approval + verified payment are both recorded.</span></span></li>
</ol></div></section>`;
  const stats = `<section class="moneyband" aria-label="Payment summary">
<div class="money-cell money-info"><div class="stat-label">What you are buying</div><div class="stat-value">${money(view.totalCents)}</div><div class="stat-hint">${escapeHtml(view.projectTitle)}</div></div>
<div class="money-cell money-ok"><div class="stat-label">What you have paid</div><div class="stat-value">${money(view.paidCents)}</div><div class="stat-hint">Verified receipts only</div></div>
<div class="money-cell money-warn"><div class="stat-label">What is currently due</div><div class="stat-value">${money(view.dueNowCents)}</div><div class="stat-hint">${escapeHtml(view.focusHeadline)}</div></div>
<div class="money-cell"><div class="stat-label">Remaining balance</div><div class="stat-value">${money(view.remainingCents)}</div><div class="stat-hint">${view.progressPercent}% collected</div></div>
</section>
<progress class="progress" max="100" value="${view.progressPercent}" aria-label="${view.progressPercent}% collected">${view.progressPercent}%</progress>
<div class="stat-hint">${view.progressPercent}% collected · verified receipts only</div>`;

  const approved = view.milestones.filter((m) =>
    ["Complete", "Paid", "Approved — payment due"].includes(m.stage),
  );
  const approvedCard =
    approved.length === 0
      ? `<section class="card reveal"><div class="card-head"><h2>What you have approved</h2></div><div class="card-body"><p class="sub">Nothing approved yet. When a preview is ready, approve it here — or request changes with a short note so the studio knows what to fix.</p></div></section>`
      : `<section class="card reveal"><div class="card-head"><h2>What you have approved</h2></div><div class="card-body"><table class="table"><tbody>${approved
          .map(
            (m) =>
              `<tr><th scope="row">Milestone ${m.position} — ${escapeHtml(m.title)}</th><td>${escapeHtml(m.stage)} · ${escapeHtml(m.paymentLabel)} · ${escapeHtml(m.deliveryLabel)}</td></tr>`,
          )
          .join(
            "",
          )}</tbody></table><p class="stat-hint">Approval pins the preview version you saw. Payment releases the final files.</p></div></section>`;

  const focus = `<div class="nextaction"><strong>${escapeHtml(view.focusHeadline)}.</strong> ${escapeHtml(view.focusBody)}</div>`;

  const steps =
    view.nextSteps.length === 0
      ? ""
      : `<section class="card reveal"><div class="card-head"><h2>What happens next</h2></div><div class="card-body"><ul class="timeline">${view.nextSteps
          .map((s) => `<li><span>${escapeHtml(s)}</span></li>`)
          .join("")}</ul></div></section>`;

  const milestones = `<section class="card reveal"><div class="card-head"><h2>Milestone timeline</h2></div><div class="card-body">
<table class="table"><thead><tr><th>Milestone</th><th>Amount</th><th>Status</th><th>Payment</th><th>Delivery</th><th>Your action</th></tr></thead><tbody>
${view.milestones
  .map((m) => {
    const actions: string[] = [];
    if (m.canApprove) {
      actions.push(
        `<form data-portal-form action="/api/v1/portal/${escapeHtml(projectId)}/approve" method="post"><input type="hidden" name="token" value="${t}" /><input type="hidden" name="milestoneId" value="${escapeHtml(m.id)}" /><button class="btn" type="submit">Approve</button> <span data-status class="stat-hint"></span></form>`,
      );
      actions.push(
        `<form data-portal-form action="/api/v1/portal/${escapeHtml(projectId)}/request-revision" method="post"><input type="hidden" name="token" value="${t}" /><input type="hidden" name="milestoneId" value="${escapeHtml(m.id)}" /><input name="note" maxlength="2000" placeholder="What should change?" aria-label="Revision note" /><button class="btn secondary" type="submit">Request changes</button> <span data-status class="stat-hint"></span></form>`,
      );
    } else if (m.needsAction && m.canPay) {
      actions.push(
        `<form data-portal-form action="/api/v1/portal/${escapeHtml(projectId)}/pay" method="post"><input type="hidden" name="token" value="${t}" /><input type="hidden" name="milestoneId" value="${escapeHtml(m.id)}" /><button class="btn" type="submit">Pay ${escapeHtml(money(m.amountCents))}</button> <span data-status class="stat-hint"></span></form>`,
      );
    } else if (m.lockReason) {
      actions.push(`<span class="stat-hint">${escapeHtml(m.lockReason)}</span>`);
    } else {
      actions.push(`<span class="stat-hint">No action needed</span>`);
    }
    return `<tr><td><strong>Milestone ${m.position} — ${escapeHtml(m.title)}</strong><div class="stat-hint">${escapeHtml(m.headline)}. ${escapeHtml(m.detail)}</div></td><td>${escapeHtml(money(m.amountCents))}</td><td>${escapeHtml(m.stage)}</td><td>${escapeHtml(m.paymentLabel)}</td><td>${escapeHtml(m.deliveryLabel)}</td><td>${actions.join('<div class="stack-gap"></div>')}</td></tr>`;
  })
  .join("")}</tbody></table></div></section>`;

  const payments =
    view.payments.length === 0
      ? `<section class="card reveal"><div class="card-head"><h2>What you have paid</h2></div><div class="card-body"><p class="sub">No verified payments yet. Payments appear here once confirmed by the payment provider — “I’ve paid” notes stay marked as confirming until then.</p></div></section>`
      : `<section class="card reveal"><div class="card-head"><h2>What you have paid</h2></div><div class="card-body"><table class="table"><tbody>${view.payments
          .map(
            (p) =>
              `<tr><th scope="row">${escapeHtml(p.milestoneTitle)}</th><td>${escapeHtml(money(p.amountCents))} · ${escapeHtml(p.stateLabel)}</td></tr>`,
          )
          .join(
            "",
          )}</tbody></table><p class="stat-hint">Verified receipts only. If you paid but nothing shows yet, the provider confirmation is still on its way — nothing is lost.</p></div></section>`;

  const agreement = view.agreement
    ? `<section class="card reveal"><div class="card-head"><h2>Your agreement (v${view.agreement.version})</h2><span class="pill pill-info">${escapeHtml(view.agreement.statusLabel)}</span></div><div class="card-body">
<p class="sub">${escapeHtml(view.agreement.whatItMeans)}</p>
<details><summary>Read the full terms</summary><pre class="terms-pre">${escapeHtml(view.agreement.termsText)}</pre>
<p class="stat-hint">Reference hash: ${escapeHtml(view.agreement.hash.slice(0, 16))}…</p></details>
${
  view.agreement.status === "pending_acceptance"
    ? `<form data-portal-form action="/api/v1/portal/${escapeHtml(projectId)}/agreements/${escapeHtml(view.agreement.id)}/accept" method="post"><input type="hidden" name="token" value="${t}" /><div class="field"><label for="pa-by">Your name</label><input id="pa-by" name="acceptedBy" required maxlength="120" placeholder="e.g. Alex Client" /></div><div><button class="btn" type="submit">Accept agreement</button> <span data-status class="stat-hint"></span></div></form>
<p class="stat-hint">Accept by version below if the button above does not apply. The current version is v${view.agreement.version}.</p>`
    : ""
}</div></section>`
    : "";

  const locks =
    view.lockedExplanations.length === 0
      ? ""
      : `<section class="card reveal"><div class="card-head"><h2>What is locked and why</h2></div><div class="card-body"><table class="table"><tbody>${view.lockedExplanations
          .map(
            (l) =>
              `<tr><th scope="row">${escapeHtml(l.title)}</th><td>${escapeHtml(l.why)} ${escapeHtml(l.unlocksWhen)}</td></tr>`,
          )
          .join("")}</tbody></table></div></section>`;

  const needsTime =
    view.paymentStatus === "overdue" || view.paymentStatus === "disputed"
      ? `<section class="card reveal"><div class="card-head"><h2>If you need more time</h2></div><div class="card-body"><p class="sub">Cash flow happens. Ask your studio about a payment plan — smaller dated amounts that sum exactly to what is owed. Nothing is forgiven or added silently, and every change is recorded here.</p><p class="stat-hint">No penalties are applied from this page. The next step is a conversation, not a charge.</p></div></section>`
      : "";
  const automatic = `<section class="card reveal"><div class="card-head"><h2>What happens automatically</h2></div><div class="card-body"><p class="sub">Receipts are verified with the payment provider, final files unlock on approval + payment, and calm reminders arrive before anything is overdue. You never need to ask “did it go through?” — this page updates when confirmation lands.</p></div></section>`;

  const activity =
    view.activity.length === 0
      ? `<section class="card reveal"><div class="card-head"><h2>Updates</h2></div><div class="card-body"><p class="sub">Updates from your studio will appear here.</p></div></section>`
      : `<section class="card reveal"><div class="card-head"><h2>Updates</h2></div><div class="card-body"><ul class="timeline">${view.activity
          .map(
            (a) =>
              `<li><time>${escapeHtml(a.when.slice(0, 10))}</time><span><strong>${escapeHtml(a.label)}</strong> <span class="stat-hint">· ${escapeHtml(a.actorLabel)}</span></span></li>`,
          )
          .join("")}</ul></div></section>`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="Private client portal — review previews, approve work and complete payment for your project." />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#090909" />
<title>${escapeHtml(view.projectTitle)} — Client portal</title><link rel="stylesheet" href="/app/styles.css" /></head>
<body>
<a class="skip" href="#main-content">Skip to content</a>
<header class="topbar"><div class="wrap topbar-inner"><div class="brand"><span class="brand-dot" aria-hidden="true"></span>Client portal</div><div class="stat-hint">Hello, ${escapeHtml(view.clientName)}${view.company ? ` · ${escapeHtml(view.company)}` : ""}</div></div></header>
<main class="wrap" id="main-content" tabindex="-1">
<section class="hero hero-tight"><p class="eyebrow reveal">Project · ${escapeHtml(view.projectTitle)}</p>
<h1 class="hero-display reveal" data-rv="1">${escapeHtml(view.focusHeadline)}</h1>
<p class="hero-sub reveal" data-rv="2">${escapeHtml(view.focusBody)}</p></section>
${focus}
${stats}
${howItWorks}
${steps}
${approvedCard}
${milestones}
${payments}
${agreement}
${locks}
${needsTime}
${automatic}
${activity}
<p class="stat-hint reveal">${escapeHtml(view.disclaimer)}</p>
</main>
<footer class="wrap foot"><p class="foot-links"><span class="brand-mini">Client portal</span> · Review · Approve · Pay</p><p>Informational workflow record. Not legal advice.</p></footer>
<script src="/portal/app.js" defer></script>
</body>
</html>`;
}

export function registerPortalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  app.get("/portal/app.js", async (_req, reply) => {
    // Static, versioned-with-deploy asset: safe for short public caching.
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(PORTAL_JS);
  });

  // ---- Freelancer: issue a secure invitation link ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/portal-links",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const body = parseOrThrow(issueLinkSchema, request.body ?? {}, "Invalid link request");
      const issued = issueMagicLink({
        projectId: params.projectId,
        sessionSecret: deps.sessionSecret,
        ...(body.ttlHours !== undefined ? { ttlHours: body.ttlHours } : {}),
      });
      const link = await store.createPortalLink(params.workspaceId, params.projectId, {
        tokenHash: issued.tokenHash,
        expiresAt: issued.claims.expiresAt,
      });
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        type: "PortalLinkIssued",
        actorType: "freelancer",
        actorId: user.id,
        payload: { portalLinkId: link.id, expiresAt: link.expiresAt.toISOString() },
      });
      return reply.status(201).send({
        portalLink: {
          id: link.id,
          projectId: link.projectId,
          expiresAt: link.expiresAt.toISOString(),
          createdAt: link.createdAt.toISOString(),
        },
        // Raw token is returned ONCE at issuance; only its sha256 is stored.
        token: issued.token,
        portalUrl: `/portal/${params.projectId}?token=${encodeURIComponent(issued.token)}`,
      });
    },
  );

  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/portal-links", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    const membership = await store.findMembership(user.id, params.workspaceId);
    const project = await store.findProject(params.projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, project);
    const links = await store.listPortalLinks(params.projectId);
    return {
      portalLinks: links.map((l) => ({
        id: l.id,
        projectId: l.projectId,
        expiresAt: l.expiresAt.toISOString(),
        ...(l.revokedAt ? { revokedAt: l.revokedAt.toISOString() } : {}),
        createdAt: l.createdAt.toISOString(),
        active: !l.revokedAt && l.expiresAt.getTime() > Date.now(),
      })),
    };
  });

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/portal-links/:linkId/revoke",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectLinkParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const link = await store.findPortalLinkById(params.linkId);
      if (link?.projectId !== params.projectId) throw AppError.notFound("Not found");
      assertResourceInWorkspace(params.workspaceId, membership, link);
      const revoked = await store.revokePortalLink(link.id);
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        type: "PortalLinkRevoked",
        actorType: "freelancer",
        actorId: user.id,
        payload: { portalLinkId: link.id },
      });
      return {
        portalLink: {
          id: revoked.id,
          revokedAt: revoked.revokedAt?.toISOString(),
        },
      };
    },
  );

  async function portalView(projectId: string, rawToken: string) {
    const { project } = await authorizePortal(store, deps.sessionSecret, projectId, rawToken);
    const [client, milestones, payments, events, agreements] = await Promise.all([
      store.findClient(project.clientId),
      store.listMilestones(project.id),
      store.listPayments(project.id),
      store.listProjectEvents(project.id, 30),
      store.listAgreements(project.id),
    ]);
    if (!client) throw AppError.notFound("Not found");
    return buildPortalView({
      project,
      client: toPortalClient(client),
      milestones,
      payments,
      events,
      agreements,
    });
  }

  // ---- Client: read-only overview (answers all 11 questions) ----
  app.get("/api/v1/portal/:projectId/overview", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const query = parseOrThrow(tokenQuerySchema, request.query, "A valid portal link is required");
    const view = await portalView(params.projectId, query.token);
    return { portal: view };
  });

  // ---- Client: calm HTML portal ----
  app.get("/portal/:projectId", async (request, reply) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const query = request.query as Record<string, unknown>;
    const rawToken = typeof query.token === "string" ? query.token : "";
    if (!rawToken) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex, nofollow" /><title>Client portal</title><link rel="stylesheet" href="/app/styles.css" /></head><body><main class="wrap narrow"><div class="card"><div class="card-body"><h1 class="h1">This link needs a token</h1><p class="sub">Open the full link your studio shared — it ends with <code>?token=…</code>. If it expired, ask for a fresh one.</p><p class="sub"><strong>What to do next:</strong> check you copied the whole link, no account needed. Your payments and approvals are safe — this is only the invitation link.</p></div></div></main></body></html>`,
        );
    }
    try {
      const view = await portalView(params.projectId, rawToken);
      return await reply
        .header("content-type", "text/html; charset=utf-8")
        .send(renderPortalPage({ projectId: params.projectId, token: rawToken, view }));
    } catch (err: unknown) {
      if (err instanceof AppError && (err.code === "UNAUTHORIZED" || err.code === "NOT_FOUND")) {
        return reply
          .status(401)
          .header("content-type", "text/html; charset=utf-8")
          .send(
            `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex, nofollow" /><title>Client portal</title><link rel="stylesheet" href="/app/styles.css" /></head><body><main class="wrap narrow"><div class="card"><div class="card-body"><h1 class="h1">This link is no longer valid</h1><p class="sub">${escapeHtml(PORTAL_LINK_INVALID)}</p><p class="sub"><strong>What to do next:</strong> ask your studio for a fresh link — no account needed. Nothing you approved or paid is affected; a new link shows the same project.</p></div></div></main></body></html>`,
          );
      }
      throw err;
    }
  });

  // ---- Client: approve a milestone that is ready for review ----
  // Formal approval: an append-only decision pinned to the milestone's
  // current version. Who (portal link identity + hashed device), what
  // (milestone), which version (versionRef), and when (createdAt) are all
  // recorded on the Approval row + the MilestoneApproved event.
  app.post("/api/v1/portal/:projectId/approve", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const body = parseOrThrow(approveSchema, request.body, "Invalid approval");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const row = await loadPortalMilestone(store, params.projectId, body.milestoneId);
    if (!row.currentVersionId) {
      throw AppError.unprocessable(
        "This milestone is not ready for approval yet — no preview has been shared.",
      );
    }
    try {
      validateApprovalInput({ versionRef: row.currentVersionId, decision: "approved" });
    } catch {
      throw AppError.unprocessable("This milestone cannot be approved in its current state.");
    }
    const approverRef = `portal:${linkId}`;
    // Idempotent repeat: when the LATEST decision is already this approval,
    // return the original row instead of recording a duplicate or failing the
    // version-pinned transition (the milestone is already approved).
    const priorRows = await store.listApprovalsByMilestone(row.id);
    const priorLatest = priorRows.length > 0 ? priorRows[priorRows.length - 1] : undefined;
    if (
      priorLatest?.decision === "approved" &&
      priorLatest.versionRef === row.currentVersionId &&
      priorLatest.approverRef === approverRef
    ) {
      try {
        await store.appendProjectEvent(project.workspaceId, project.id, {
          milestoneId: row.id,
          type: eventTypeForDecision("approved"),
          actorType: "client",
          idempotencyKey: `portal-approve:${row.id}:${row.currentVersionId}`,
          payload: {
            approvedVersionId: row.currentVersionId,
            versionRef: row.currentVersionId,
            decision: "approved",
            approvalId: priorLatest.id,
            approverRef,
          },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      await refreshUnlocks(store, project.id);
      const current = await store.findMilestone(row.id);
      return {
        message: `${row.title} is approved — thank you. Payment completes the milestone.`,
        milestone: {
          id: row.id,
          work: current?.workState ?? row.workState,
          approval: current?.approvalState ?? row.approvalState,
        },
        approval: {
          id: priorLatest.id,
          decision: "approved",
          versionRef: row.currentVersionId,
          createdAt: priorLatest.createdAt.toISOString(),
          duplicate: true,
        },
      };
    }
    let next: MilestoneState;
    try {
      next = approveWork(toDomain(row), {
        approvedVersionId: row.currentVersionId,
        currentVersionId: row.currentVersionId,
      });
    } catch {
      throw AppError.unprocessable("This milestone cannot be approved in its current state.");
    }
    const updated = await store.updateMilestone(row.id, {
      workState: next.work,
      approvalState: next.approval,
      approvedVersionId: next.approvedVersionId,
      currentVersionId: next.currentVersionId,
    });
    let approval = priorLatest;
    if (approval?.decision !== "approved") {
      const device = deviceHashes(request);
      approval = await store.createApproval(project.workspaceId, {
        projectId: project.id,
        milestoneId: row.id,
        versionRef: row.currentVersionId,
        decision: "approved",
        approverRef,
        actorType: "client",
        ...(device.ipHash ? { ipHash: device.ipHash } : {}),
        ...(device.uaHash ? { uaHash: device.uaHash } : {}),
      });
    }
    const approvalId = approval.id;
    const versionRef = row.currentVersionId;
    try {
      await store.appendProjectEvent(project.workspaceId, project.id, {
        milestoneId: row.id,
        type: eventTypeForDecision("approved"),
        actorType: "client",
        idempotencyKey: `portal-approve:${row.id}:${row.currentVersionId}`,
        payload: {
          approvedVersionId: row.currentVersionId,
          versionRef,
          decision: "approved",
          approvalId,
          approverRef,
        },
      });
    } catch (err: unknown) {
      if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
    }
    await refreshUnlocks(store, project.id);
    await notifyLifecycle(deps, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      milestoneId: row.id,
      kind: "approval_received",
      dedupe: `portal-approve:${approvalId}`,
    });
    return {
      message: `${updated.title} is approved — thank you. Payment completes the milestone.`,
      milestone: { id: updated.id, work: updated.workState, approval: updated.approvalState },
      approval: {
        id: approvalId,
        decision: "approved",
        versionRef,
        createdAt: approval.createdAt.toISOString(),
      },
    };
  });

  // ---- Client: request changes with a note ----
  app.post("/api/v1/portal/:projectId/request-revision", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const body = parseOrThrow(revisionSchema, request.body, "Invalid revision request");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const row = await loadPortalMilestone(store, params.projectId, body.milestoneId);
    const versionRef = row.currentVersionId ?? `milestone:${row.id}`;
    try {
      validateApprovalInput({ versionRef, decision: "revision_requested", note: body.note });
    } catch {
      throw AppError.unprocessable("This milestone cannot take a revision request right now.");
    }
    let next: MilestoneState;
    try {
      next = requestRevision(toDomain(row), body.note);
    } catch {
      throw AppError.unprocessable("This milestone cannot take a revision request right now.");
    }
    const updated = await store.updateMilestone(row.id, {
      workState: next.work,
      approvalState: next.approval,
    });
    const approverRef = `portal:${linkId}`;
    const device = deviceHashes(request);
    const approval = await store.createApproval(project.workspaceId, {
      projectId: project.id,
      milestoneId: row.id,
      versionRef,
      decision: "revision_requested",
      approverRef,
      note: body.note.slice(0, 2000),
      actorType: "client",
      ...(device.ipHash ? { ipHash: device.ipHash } : {}),
      ...(device.uaHash ? { uaHash: device.uaHash } : {}),
    });
    await store.appendProjectEvent(project.workspaceId, project.id, {
      milestoneId: row.id,
      type: eventTypeForDecision("revision_requested"),
      actorType: "client",
      payload: {
        note: body.note.slice(0, 2000),
        decision: "revision_requested",
        versionRef,
        approvalId: approval.id,
        approverRef,
      },
    });
    await notifyLifecycle(deps, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      milestoneId: row.id,
      kind: "approval_revision_requested",
      dedupe: `portal-revision:${approval.id}`,
      detail: body.note.slice(0, 500),
    });
    return {
      message: `Thanks — your feedback on ${updated.title} was shared with your studio.`,
      milestone: { id: updated.id, work: updated.workState },
      approval: {
        id: approval.id,
        decision: "revision_requested",
        versionRef,
        createdAt: approval.createdAt.toISOString(),
      },
    };
  });

  // ---- Client: reject a version (not approved — needs a new decision) ----
  app.post("/api/v1/portal/:projectId/reject", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const body = parseOrThrow(decisionSchema, request.body, "Invalid rejection");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const row = await loadPortalMilestone(store, params.projectId, body.milestoneId);
    const versionRef = row.currentVersionId ?? `milestone:${row.id}`;
    try {
      validateApprovalInput({ versionRef, decision: "rejected", note: body.note });
    } catch {
      throw AppError.unprocessable("This milestone cannot be rejected in its current state.");
    }
    let next: MilestoneState;
    try {
      next = rejectWork(toDomain(row));
    } catch {
      throw AppError.unprocessable("This milestone cannot be rejected in its current state.");
    }
    const updated = await store.updateMilestone(row.id, { approvalState: next.approval });
    const approverRef = `portal:${linkId}`;
    const device = deviceHashes(request);
    const approval = await store.createApproval(project.workspaceId, {
      projectId: project.id,
      milestoneId: row.id,
      versionRef,
      decision: "rejected",
      approverRef,
      note: body.note.slice(0, 2000),
      actorType: "client",
      ...(device.ipHash ? { ipHash: device.ipHash } : {}),
      ...(device.uaHash ? { uaHash: device.uaHash } : {}),
    });
    await store.appendProjectEvent(project.workspaceId, project.id, {
      milestoneId: row.id,
      type: eventTypeForDecision("rejected"),
      actorType: "client",
      payload: {
        note: body.note.slice(0, 2000),
        decision: "rejected",
        versionRef,
        approvalId: approval.id,
        approverRef,
      },
    });
    await notifyLifecycle(deps, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      milestoneId: row.id,
      kind: "approval_rejected",
      dedupe: `portal-reject:${approval.id}`,
      detail: body.note.slice(0, 500),
    });
    return {
      message: `Noted — ${updated.title} was marked as not approved. Your studio will follow up.`,
      milestone: { id: updated.id, approval: updated.approvalState },
      approval: {
        id: approval.id,
        decision: "rejected",
        versionRef,
        createdAt: approval.createdAt.toISOString(),
      },
    };
  });

  // ---- Client: dispute a milestone (freezes work/payment until resolved) ----
  app.post("/api/v1/portal/:projectId/dispute", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const body = parseOrThrow(decisionSchema, request.body, "Invalid dispute");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const row = await loadPortalMilestone(store, params.projectId, body.milestoneId);
    const versionRef = row.currentVersionId ?? `milestone:${row.id}`;
    try {
      validateApprovalInput({ versionRef, decision: "disputed", note: body.note });
    } catch {
      throw AppError.unprocessable("This milestone cannot be disputed in its current state.");
    }
    const next = disputeMilestone(toDomain(row));
    const updated = await store.updateMilestone(row.id, {
      workState: next.work,
      paymentState: next.payment,
    });
    const approverRef = `portal:${linkId}`;
    const device = deviceHashes(request);
    const approval = await store.createApproval(project.workspaceId, {
      projectId: project.id,
      milestoneId: row.id,
      versionRef,
      decision: "disputed",
      approverRef,
      note: body.note.slice(0, 2000),
      actorType: "client",
      ...(device.ipHash ? { ipHash: device.ipHash } : {}),
      ...(device.uaHash ? { uaHash: device.uaHash } : {}),
    });
    await store.appendProjectEvent(project.workspaceId, project.id, {
      milestoneId: row.id,
      type: eventTypeForDecision("disputed"),
      actorType: "client",
      payload: {
        note: body.note.slice(0, 2000),
        decision: "disputed",
        versionRef,
        approvalId: approval.id,
        approverRef,
      },
    });
    await notifyLifecycle(deps, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      milestoneId: row.id,
      kind: "approval_disputed",
      dedupe: `portal-dispute:${approval.id}`,
      detail: body.note.slice(0, 500),
    });
    return {
      message: `Noted — a question was recorded on ${updated.title}. Your studio will follow up.`,
      milestone: { id: updated.id, work: updated.workState },
      approval: {
        id: approval.id,
        decision: "disputed",
        versionRef,
        createdAt: approval.createdAt.toISOString(),
      },
    };
  });

  // ---- Client: start payment (intent only — never marks paid) ----
  // Creates a hosted-checkout session via the configured provider (card entry
  // happens on the provider page, never here) and returns its URL. The
  // milestone stays unpaid until a VERIFIED provider webhook confirms receipt.
  app.post("/api/v1/portal/:projectId/pay", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const body = parseOrThrow(paySchema, request.body, "Invalid payment request");
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const row = await loadPortalMilestone(store, params.projectId, body.milestoneId);
    const payments = await store.listPayments(project.id);
    const received = payments
      .filter(
        (p) =>
          p.milestoneId === row.id &&
          (p.state === "received" || p.state === "partial" || p.state === "paid"),
      )
      .reduce((s, p) => s + p.amountCents, 0);
    if (received >= row.amountCents || row.paymentState === "paid") {
      throw AppError.conflict("This milestone is already paid — thank you.");
    }
    if (row.unlockState === "locked") {
      throw AppError.unprocessable(
        "This milestone is locked for now — it unlocks once the earlier milestone is complete.",
      );
    }
    if (
      row.paymentState === "unpaid" ||
      row.paymentState === "overdue" ||
      row.paymentState === "claimed_unverified"
    ) {
      try {
        const next = requestFunding(toDomain(row));
        await store.updateMilestone(row.id, { paymentState: next.payment });
      } catch {
        // Already in a payable state; the event below is still the record.
      }
    }
    try {
      await store.appendProjectEvent(project.workspaceId, project.id, {
        milestoneId: row.id,
        type: "PaymentRequested",
        actorType: "client",
        idempotencyKey: `portal-pay:${row.id}:${received}`,
        payload: { amountCents: row.amountCents, currency: row.currency },
      });
    } catch (err: unknown) {
      if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
    }
    // Hosted checkout (provider page). Best-effort: if the provider is
    // unreachable the intent above is still recorded and the client can retry.
    const idempotencyKey = `portal-pay:${row.id}:${received}`;
    const preExisting = await store
      .findPaymentByIdempotencyKey(idempotencyKey)
      .catch(() => undefined);
    if (preExisting) {
      return {
        message: `Payment started for ${row.title}. Your studio confirms receipt, then the final files unlock automatically.`,
        amountCents: row.amountCents,
        currency: row.currency,
        paymentId: preExisting.id,
        state: preExisting.state,
        duplicate: true,
      };
    }
    try {
      const provider =
        deps.paymentProvider ??
        (process.env.NODE_ENV === "test" ? new FakePaymentProvider() : new NoopPaymentProvider());
      const paymentId = randomUUID();
      const session = await provider.createCheckoutSession({
        paymentId,
        workspaceId: project.workspaceId,
        projectId: project.id,
        milestoneId: row.id,
        amountCents: row.amountCents,
        currency: row.currency,
        idempotencyKey,
      });
      const payment = await store.createPayment(project.workspaceId, {
        id: paymentId,
        projectId: project.id,
        milestoneId: row.id,
        provider: provider.name,
        providerPaymentId: session.providerPaymentId,
        amountCents: row.amountCents,
        currency: row.currency,
        state: "pending",
        idempotencyKey,
      });
      try {
        await store.appendProjectEvent(project.workspaceId, project.id, {
          milestoneId: row.id,
          type: "PaymentCreated",
          actorType: "client",
          idempotencyKey: `pay:${payment.id}:created`,
          payload: { paymentId: payment.id, amountCents: row.amountCents, currency: row.currency },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      return {
        message: `Payment started for ${row.title}. Your studio confirms receipt, then the final files unlock automatically.`,
        amountCents: row.amountCents,
        currency: row.currency,
        paymentId: payment.id,
        state: payment.state,
        checkoutUrl: session.checkoutUrl,
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      return {
        message: `Payment started for ${row.title}. Your studio confirms receipt, then the final files unlock automatically.`,
        amountCents: row.amountCents,
        currency: row.currency,
      };
    }
  });

  // ---- Client: "I've paid" claim (recorded, NEVER verified here) ----
  // Product principle: "client says they paid" is NOT "payment is verified."
  // This records `claimed_unverified` + a `PaymentClaimed` event so the
  // freelancer sees the assertion; totals stay unchanged until a verified
  // provider receipt arrives via webhook/reconcile.
  app.post("/api/v1/portal/:projectId/claim", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const body = parseOrThrow(claimSchema, request.body, "Invalid claim");
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const row = await loadPortalMilestone(store, params.projectId, body.milestoneId);
    if (row.paymentState === "claimed_unverified") {
      return {
        duplicate: true,
        message: `Noted — your claim for ${row.title} is recorded. Your studio confirms receipt before anything unlocks.`,
        milestone: { id: row.id, payment: row.paymentState },
      };
    }
    let next: MilestoneState;
    try {
      next = markClaimed(toDomain(row));
    } catch {
      throw AppError.unprocessable("This milestone cannot take a claim in its current state.");
    }
    const updated = await store.updateMilestone(row.id, { paymentState: next.payment });
    try {
      await store.appendProjectEvent(project.workspaceId, project.id, {
        milestoneId: row.id,
        type: "PaymentClaimed",
        actorType: "client",
        idempotencyKey: `portal-claim:${row.id}`,
        payload: {
          milestoneId: row.id,
          claim: "client says paid — NOT verified",
          ...(body.note !== undefined ? { note: body.note.slice(0, 500) } : {}),
        },
      });
    } catch (err: unknown) {
      if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
    }
    return {
      message: `Thank you — your note for ${updated.title} is recorded. It stays unverified until the payment provider confirms receipt.`,
      milestone: { id: updated.id, payment: updated.paymentState },
    };
  });

  // ---- Client: poll verified payment status (read-only; never marks paid) ----
  app.get("/api/v1/portal/:projectId/payments/:paymentId/status", async (request) => {
    const params = parseOrThrow(portalPaymentParam, request.params, "Invalid ids");
    const query = parseOrThrow(
      portalStatusQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    await authorizePortal(store, deps.sessionSecret, params.projectId, query.token);
    const payment = await store.findPaymentById(params.paymentId);
    if (payment?.projectId !== params.projectId) throw AppError.notFound("Not found");
    const verified =
      payment.state === "paid" || payment.state === "received" || payment.state === "partial";
    return {
      payment: {
        id: payment.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        state: payment.state,
        verified,
      },
      note: verified
        ? "Payment confirmed by verified receipt — thank you."
        : "Confirming with the payment provider. This page proves nothing until a verified receipt arrives.",
    };
  });

  // ---- Client: return page after hosted checkout (READ-ONLY; never marks paid) ----
  // The provider redirects here after card entry. This page MUST NOT change
  // any state: the authoritative verdict arrives later via webhook.
  app.get("/portal/:projectId/success", async (request, reply) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const query = request.query as Record<string, unknown>;
    const parsed = portalSuccessQuerySchema.safeParse(query);
    if (!parsed.success) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Payment</title><link rel="stylesheet" href="/app/styles.css" /></head><body><main class="wrap narrow"><div class="card"><div class="card-body"><h1 class="h1">Confirming your payment</h1><p class="sub">Open the full link your studio shared. This page alone never confirms payment — only a verified provider receipt does.</p></div></div></main></body></html>`,
        );
    }
    try {
      await authorizePortal(store, deps.sessionSecret, params.projectId, parsed.data.token);
    } catch {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Payment</title><link rel="stylesheet" href="/app/styles.css" /></head><body><main class="wrap narrow"><div class="card"><div class="card-body"><h1 class="h1">Confirming your payment</h1><p class="sub">${escapeHtml(PORTAL_LINK_INVALID)}</p><p class="sub">This page alone never confirms payment — only a verified provider receipt does.</p></div></div></main></body></html>`,
        );
    }
    const payment = await store.findPaymentById(parsed.data.paymentId);
    const state = payment?.projectId === params.projectId ? payment.state : "unknown";
    const verified = state === "paid" || state === "received" || state === "partial";
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Payment ${verified ? "received" : "confirming"}</title><link rel="stylesheet" href="/app/styles.css" /></head><body><main class="wrap narrow"><div class="card"><div class="card-body"><h1 class="h1">${verified ? "Payment received — thank you" : "Confirming your payment…"}</h1><p class="sub">${verified ? "Your verified receipt is recorded. Final files unlock automatically." : "Your card details went to the payment provider, not to us. This page does not confirm payment — the studio's record updates only when the provider's verified confirmation arrives."}</p><p class="stat-hint">Status: ${escapeHtml(state)} · Verified receipts only.</p></div></div></main></body></html>`,
      );
  });

  // ---- Client: accept the current agreement ----
  app.post("/api/v1/portal/:projectId/agreements/:agreementId/accept", async (request) => {
    const params = parseOrThrow(portalAgreementParam, request.params, "Invalid ids");
    const body = parseOrThrow(portalAcceptSchema, request.body, "Invalid acceptance");
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const row = await store.findAgreement(params.agreementId);
    if (row?.projectId !== params.projectId) throw AppError.notFound("Not found");
    if (row.workspaceId !== project.workspaceId) throw AppError.unauthorized(PORTAL_LINK_INVALID);
    if (row.status !== "pending_acceptance") {
      throw AppError.unprocessable("This agreement version is not awaiting acceptance.");
    }
    const late = row.latePaymentPolicy;
    const storedTerms = {
      totalAmountCents: row.totalAmountCents,
      currency: row.currency,
      depositAmountCents: row.depositAmountCents,
      milestoneSchedule: row.milestoneSchedule.map((m) => ({
        title: m.title,
        amountCents: m.amountCents,
        ...(m.dueLabel !== undefined ? { dueLabel: m.dueLabel } : {}),
      })),
      paymentDueDays: row.paymentDueDays,
      graceDays: row.graceDays,
      acceptedPaymentMethods: [...row.acceptedPaymentMethods] as never[],
      latePaymentPolicy: {
        kind: (typeof late.kind === "string" ? late.kind : "none") as never,
        description: typeof late.description === "string" ? late.description : "",
      },
      pauseAfterOverdueDays: row.pauseAfterOverdueDays,
      workPauseDescription: row.workPauseDescription,
      releaseCondition: row.releaseCondition as never,
      finalDeliveryDescription: row.finalDeliveryDescription,
      ownershipMode: row.ownershipMode as never,
      ownershipDescription: row.ownershipDescription,
      maxRevisionsPerMilestone: row.maxRevisionsPerMilestone,
      extraRevisionPolicy: row.extraRevisionPolicy,
      cancellationNoticeDays: row.cancellationNoticeDays,
      ...(row.cancellationKillFeeCents !== undefined
        ? { cancellationKillFeeCents: row.cancellationKillFeeCents }
        : {}),
      cancellationPolicy: row.cancellationPolicy,
      ...(row.customClauses !== undefined ? { customClauses: row.customClauses } : {}),
    };
    if (hashAgreementTerms(storedTerms) !== row.hash) {
      throw AppError.unprocessable("Stored terms do not match the recorded hash");
    }
    const header = request.headers["x-forwarded-for"];
    const ip = Array.isArray(header) ? header[0] : typeof header === "string" ? header : request.ip;
    const ua = request.headers["user-agent"];
    const ipHash = hashRef(ip);
    const uaHash = typeof ua === "string" ? hashRef(ua) : undefined;
    let acceptedAt: Date;
    try {
      const next = acceptDomain(
        {
          id: row.id,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          version: row.version,
          status: row.status,
          isCurrent: row.isCurrent,
          terms: storedTerms,
          termsText: row.termsText,
          hash: row.hash,
          disclaimerVersion: row.disclaimerVersion,
          createdAt: row.createdAt,
        },
        {
          acceptedBy: body.acceptedBy,
          ...(ipHash ? { acceptIpHash: ipHash } : {}),
          ...(uaHash ? { acceptUaHash: uaHash } : {}),
        },
      );
      acceptedAt = next.acceptedAt ?? new Date();
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw AppError.unprocessable("This agreement cannot be accepted in its current state.");
    }
    const updated = await store.updateAgreementLifecycle(row.id, {
      status: "accepted",
      isCurrent: true,
      acceptedAt,
      acceptedBy: body.acceptedBy.trim(),
      ...(ipHash ? { acceptIpHash: ipHash } : {}),
      ...(uaHash ? { acceptUaHash: uaHash } : {}),
    });
    const siblings = await store.listAgreements(params.projectId);
    for (const sib of siblings) {
      if (sib.id !== row.id && sib.status === "accepted") {
        await store.updateAgreementLifecycle(sib.id, { status: "superseded", isCurrent: false });
        await store.appendProjectEvent(project.workspaceId, project.id, {
          type: "AgreementSuperseded",
          actorType: "system",
          payload: {
            agreementId: sib.id,
            version: sib.version,
            supersededBy: row.id,
            hash: sib.hash,
          },
        });
      } else if (sib.id !== row.id && sib.isCurrent && sib.status !== "accepted") {
        await store.updateAgreementLifecycle(sib.id, { isCurrent: false });
      }
    }
    await store.appendProjectEvent(project.workspaceId, project.id, {
      type: "AgreementAccepted",
      actorType: "client",
      payload: {
        agreementId: row.id,
        version: row.version,
        hash: row.hash,
        acceptedBy: body.acceptedBy.trim(),
      },
    });
    return {
      message: "Agreement accepted — thank you. Your milestones below follow these terms.",
      agreement: { id: updated.id, version: updated.version, status: updated.status },
      disclaimer: AGREEMENT_DISCLAIMER,
    };
  });
}
