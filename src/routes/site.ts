import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APP_VERSION, DISCLAIMER } from "./health.js";
import { escapeHtml, onboardingSteps, card } from "../ui/components.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { extractSessionToken, verifySessionToken } from "../lib/session.js";
import type { RouteDeps } from "./requestAuth.js";

/**
 * Public launch site (Session 24).
 *
 * Smallest coherent launch product: marketing homepage, pricing, FAQ,
 * privacy, terms, contact, onboarding, and a feedback mechanism — all with
 * honest product claims (no guaranteed-payment / enforceable-everywhere /
 * stops-fraud / cannot-be-misused promises).
 *
 * Design notes:
 * - `GET /` content-negotiates: browsers (Accept: text/html) get the
 *   marketing homepage; API clients get the existing JSON envelope
 *   (backwards compatible, no breaking change).
 * - All other public pages are static HTML (no auth, no PII, short public
 *   caching). Workspace pages stay `noindex` via `ui/components.ts`.
 * - Feedback is a minimal public `POST /api/v1/feedback` (validated,
 *   logged, process-memory receipt list). Documented limitation: wire it to
 *   a ticket queue / mailbox before scale; it is a mechanism, not a sink.
 */

const HONEST_FOOTER = `Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent. This product keeps organized records and a calm workflow — it does not promise payment outcomes.`;

export interface FeedbackRecord {
  id: string;
  receivedAt: string;
  category: "feedback" | "contact" | "bug" | "idea";
  message: string;
  name?: string | undefined;
  email?: string | undefined;
  page?: string | undefined;
}

/** Process-memory receipts (launch-scale inbox; see module doc). */
export const feedbackInbox: FeedbackRecord[] = [];

export function clearFeedbackInbox(): void {
  feedbackInbox.length = 0;
}

const feedbackSchema = z.object({
  message: z.string().trim().min(10, "Tell us a little more (at least 10 characters)").max(2000),
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email("Enter a valid email").max(254).optional(),
  page: z.string().trim().max(500).optional(),
  category: z.enum(["feedback", "contact", "bug", "idea"]).optional(),
});

function publicLayout(args: {
  title: string;
  description: string;
  active?: string;
  body: string;
}): string {
  const { title, description, active, body } = args;
  const nav = (key: string, href: string, label: string): string =>
    `<a class="navlink${active === key ? " is-active" : ""}" href="${href}">${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${escapeHtml(description)}" />
<meta name="theme-color" content="#090909" />
<title>${escapeHtml(title)} — FreelancePaymentProtection</title>
<link rel="stylesheet" href="/app/styles.css" />
</head>
<body>
<a class="skip" href="#main-content">Skip to content</a>
<header class="topbar"><div class="wrap topbar-inner"><div class="brand"><a class="brand-link" href="/"><span class="brand-dot" aria-hidden="true"></span>FreelancePaymentProtection</a></div><nav class="nav" aria-label="Site">
${nav("pricing", "/pricing", "Pricing")}
${nav("faq", "/faq", "FAQ")}
${nav("onboarding", "/onboarding", "Get started")}
${nav("contact", "/contact", "Contact")}
</nav></div></header>
<main class="wrap" id="main-content" tabindex="-1">${body}</main>
<footer class="wrap foot"><p class="foot-links"><span class="brand-mini">FreelancePaymentProtection</span> · <a href="/pricing">Pricing</a> · <a href="/faq">FAQ</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/contact">Contact</a> · <a href="/onboarding">Get started</a></p><p>${escapeHtml(HONEST_FOOTER)}</p></footer>
<script src="/app/app.js" defer></script>
</body>
</html>`;
}

function pageHeader(eyebrow: string, title: string, sub: string): string {
  return `<p class="eyebrow reveal">${escapeHtml(eyebrow)}</p><h1 class="h1 reveal" data-rv="1">${escapeHtml(title)}</h1><p class="sub reveal" data-rv="2">${escapeHtml(sub)}</p>`;
}

function homeBody(): string {
  return `<section class="hero"><p class="eyebrow reveal">Payment-protection workflow</p>
<h1 class="hero-display reveal" data-rv="1">Get paid for freelance work, without chasing.</h1>
<p class="hero-sub reveal" data-rv="2">Milestones, approvals, verified receipts, calm reminders, and a complete record — finals stay locked until approval + verified payment are both recorded.</p>
<div class="hero-ctas reveal" data-rv="3"><a class="btn" href="/onboarding">Start the guided setup →</a><a class="btn secondary" href="/pricing">See pricing →</a></div></section>
<div class="nextaction reveal"><strong>What this is:</strong> an organized workflow that ties payment to project progress. <strong>What it is not:</strong> a promise of payment, legal advice, or an escrow service.</div>
<div class="spot-grid"><div class="spot spot-violet reveal"><p class="spot-kicker">Milestones</p><p class="spot-title">Every payment has progress attached.</p><p class="spot-body">Terms are versioned and hash-pinned, so the amount, the work, and the approval always agree.</p></div>
<div class="spot spot-magenta reveal" data-rv="1"><p class="spot-kicker">Approvals</p><p class="spot-title">Clients approve the exact version.</p><p class="spot-body">Previews are for review; approval pins that version. New versions reset cleanly.</p></div>
<div class="spot spot-orange reveal"><p class="spot-kicker">Verified payments</p><p class="spot-title">Only provider receipts count.</p><p class="spot-body">Hosted checkout. “I’ve paid” notes stay unverified until the provider confirms.</p></div>
<div class="spot spot-coral reveal" data-rv="1"><p class="spot-kicker">Evidence</p><p class="spot-title">Finals unlock, the record stays.</p><p class="spot-body">Release needs approval + verified payment. Every step stays in an append-only timeline.</p></div></div>
<section class="card reveal"><div class="card-head"><h2>How a project flows</h2></div><div class="card-body">${onboardingSteps(
    [
      {
        title: "Agree on milestones",
        body: "Each payment has progress attached. Terms are versioned and hash-pinned.",
      },
      {
        title: "Share previews, collect approval",
        body: "The client reviews previews; approval is pinned to that exact version.",
      },
      {
        title: "Collect verified payment",
        body: "Hosted checkout; only provider-confirmed receipts count toward paid.",
      },
      {
        title: "Finals unlock, record stays",
        body: "Release needs approval + verified payment. Every step stays in an append-only timeline.",
      },
    ],
  )}<p class="sub">If payment runs late: calm automatic follow-ups first, then an exact-sum payment plan, then recorded work pause, then a factual evidence export. Each step is recorded; nothing is edited.</p><p class="btn-row"><a class="btn" href="/onboarding">Start the guided setup →</a><a class="btn secondary" href="/pricing">See pricing →</a></p></div></section>
${card("What you can check on every project", `<div class="table-scroll"><table class="table"><tbody><tr><th scope="row">Money</th><td>Verified-paid vs outstanding, per milestone and per project. Claims marked “I’ve paid” stay unverified until the provider confirms.</td></tr><tr><th scope="row">Approvals</th><td>Version-pinned decisions: approved, revision requested, rejected, or disputed — new versions reset cleanly.</td></tr><tr><th scope="row">Delivery</th><td>Previews for review early; final files only when released. Previews are a speed bump, not copy protection.</td></tr><tr><th scope="row">Record</th><td>Chronological timeline plus a factual export for your records or a mediator. Corrections arrive as new entries, never edits.</td></tr></tbody></table></div>`)}
${card("Honest limits", `<p class="sub">This product does not hold funds, does not give legal advice, and does not predict or promise dispute outcomes. Payment confirmation depends on your payment provider; record-keeping depends on using the workflow (send terms, schedule reminders, record approvals). Enforcement of any agreement depends on your jurisdiction and the facts.</p>`)}`;
}

function pricingBody(): string {
  return `${pageHeader("Pricing", "One simple plan for launch.", "Early-access pricing while the first freelancers shape the product. Payment-provider fees (e.g. card processing) are separate and go to your provider, not to us.")}
${card("Launch plan — a flat monthly workspace", `<table class="table"><tbody><tr><th scope="row">Price</th><td>Contact us for current early-access pricing — published on this page before any charge.</td></tr><tr><th scope="row">Includes</th><td>Unlimited clients and projects, milestones, version-pinned approvals, hosted-checkout payment tracking, calm reminders, payment plans, timeline and factual evidence exports.</td></tr><tr><th scope="row">Not included</th><td>Card-processing or payout fees (set by your payment provider). Funds are never held by this product.</td></tr><tr><th scope="row">Cancel</th><td>Cancel any time; your exported records remain yours. Generate evidence packs before closing if you need them.</td></tr></tbody></table><p class="sub">No per-invoice fees from us. No percentage of your project value. If pricing changes, the change applies going forward and is shown here first.</p><p><a href="/contact">Ask about pricing →</a></p>`)}
${card("Why flat, not a cut", `<p class="sub">A percentage cut would need custody of your money. This product never takes custody: checkout happens on your provider's hosted page, receipts are verified read-backs, and the workflow organizes what happens around them.</p>`)}`;
}

function faqBody(): string {
  const qa: { q: string; a: string }[] = [
    {
      q: "Does this promise I will get paid?",
      a: "No. It organizes the workflow that helps: agreed milestones, recorded approvals, verified receipts, calm follow-ups, payment plans, work pause, and a complete record. Whether a client pays still depends on the client, the provider, and the facts.",
    },
    {
      q: "Is this legal advice or enforcement?",
      a: "No. Every agreement draft and every export carries the notice: informational workflow record, not legal advice, enforcement is jurisdiction-dependent. For advice about your situation, talk to a qualified professional in your jurisdiction.",
    },
    {
      q: "Do you hold my money (escrow)?",
      a: "No. There is no escrow and no custody. Clients pay through your provider's hosted checkout; this product records verified receipts and gates final delivery on them.",
    },
    {
      q: "What counts as “paid”?",
      a: "Only provider-confirmed receipts. A client note saying “I have paid” is recorded as an unverified claim and never reduces what is owed until the provider confirms.",
    },
    {
      q: "What happens when a payment is overdue?",
      a: "Calm system-voiced reminders go out on the schedule you configure (for example T-3, due day, T+3, T+7), escalation steps stay manual-only, and you can offer an exact-sum payment plan, record a work pause, and export the factual record. Paid milestones stop follow-ups automatically.",
    },
    {
      q: "Can the client see my private notes?",
      a: "No. The portal shows only what the client needs: what they are buying, what is due, previews for review, approval actions, verified payments, and updates. Notes and billing contacts never leave the server.",
    },
    {
      q: "Can previews be copied?",
      a: "Assume yes: a browser cannot prevent screenshots. Previews are a review convenience and a speed bump, not copy protection. Final files stay locked until release.",
    },
    {
      q: "Can history be edited or deleted?",
      a: "No. Events, payments, approvals, agreements and evidence packs are append-only. Corrections arrive as new entries (new agreement version, new plan version, unpause), so the timeline always shows what actually happened.",
    },
    {
      q: "What do I need to start?",
      a: "An account, one client, one project with milestones and due dates, and a portal link for the client. The guided setup walks through it in about ten minutes: see Get started.",
    },
  ];
  return (
    pageHeader(
      "FAQ",
      "Straight answers.",
      "No promises about outcomes — only what the product does and where its limits are.",
    ) + qa.map((item) => card(item.q, `<p class="sub">${escapeHtml(item.a)}</p>`)).join("")
  );
}

function privacyBody(): string {
  return `${pageHeader("Privacy", "What we store, and why.", "Last updated: 2026-09-18. This page describes the launch product; it is not legal advice.")}
${card("Data we keep", `<table class="table"><tbody><tr><th scope="row">Account</th><td>Email, display name, salted password hash (scrypt). Passwords are never stored in readable form.</td></tr><tr><th scope="row">Workspace</th><td>Clients, projects, milestones, agreements, deliverable metadata, approvals, payments, reminders, plans, timeline events — the records you create to run the workflow.</td></tr><tr><th scope="row">Client portal</th><td>Single-project magic links stored as hashes; raw tokens are shown once at issuance. Approval audit rows store hashed device references only, never raw IPs or user agents.</td></tr><tr><th scope="row">Files</th><td>Deliverable files live in your configured object storage; this service keeps references and signed, expiring download URLs — never public links.</td></tr><tr><th scope="row">Feedback</th><td>Messages you send via Contact / feedback, kept to respond and improve the product.</td></tr></tbody></table>`)}
${card("What we do not do", `<p class="sub">We do not sell personal data. We do not read card numbers (checkout happens on your provider's hosted page). We do not use your project records for advertising. Session cookies exist only to keep you signed in.</p>`)}
${card("Your choices", `<p class="sub">Ask for a copy or deletion of your account data via Contact. Deletion removes workspace rows subject to any retention the law requires; append-only financial rows are never rewritten, only closed. Evidence packs you already exported remain yours.</p>`)}`;
}

function termsBody(): string {
  return `${pageHeader("Terms", "Rules for using the product.", "Last updated: 2026-09-18. Informational page, not legal advice.")}
${card("The service", `<p class="sub">FreelancePaymentProtection provides a payment-protection workflow: milestones, agreements, client portal, payment tracking, deliverables, approvals, reminders, payment plans, timelines, and factual exports. It does not hold funds, does not process card payments itself, and does not act as a party to your client contracts.</p>`)}
${card("Your responsibilities", `<p class="sub">You keep your sign-in safe, only invite your own clients, use accurate project records, and follow the law where you work — including tax, invoicing, and consumer rules. Do not use reminders or exports to threaten anyone; the product's language stays neutral by design and you agree to keep it that way.</p>`)}
${card("Limits", `<p class="sub">The service is provided as-is for launch. We do not promise payment outcomes, dispute outcomes, availability targets, or fitness for a particular purpose beyond organizing the workflow. To the extent the law allows, liability is limited to the fees paid for the current period.</p>`)}
${card("Changes", `<p class="sub">If these terms or the pricing change, the new version is published on this site first with a new date. Continued use after publication means you accept the updated version.</p>`)}`;
}

function contactBody(): string {
  return `${pageHeader("Contact", "Talk to a human.", "Questions about pricing, onboarding, or a project workflow — send a note. We reply from the workspace mailbox.")}
${card(
  "Send a message",
  `<form class="form" data-api-form data-method="POST" action="/api/v1/feedback" data-redirect="/contact?sent=1">
<input type="hidden" name="category" value="contact" />
<input type="hidden" name="page" value="/contact" />
<div class="field"><label for="ct-name">Name</label><input id="ct-name" name="name" maxlength="120" autocomplete="name" /></div>
<div class="field"><label for="ct-email">Email</label><input id="ct-email" name="email" type="email" required maxlength="254" autocomplete="email" /></div>
<div class="field"><label for="ct-msg">Message</label><textarea id="ct-msg" name="message" rows="5" required minlength="10" maxlength="2000" placeholder="What are you trying to set up?"></textarea></div>
<div><button class="btn" type="submit">Send message</button> <span data-status class="stat-hint"></span></div>
<p class="sub">Prefer email later? This form is the fastest route during launch — every message is logged with a receipt id.</p>
</form>`,
)}
${card(
  "Send feedback",
  `<p class="sub">Found a rough edge, a confusing step, or an idea that would help your next project? The same inbox reads product feedback.</p><form class="form" data-api-form data-method="POST" action="/api/v1/feedback" data-redirect="/contact?sent=1">
<input type="hidden" name="category" value="feedback" />
<input type="hidden" name="page" value="/contact" />
<div class="field"><label for="fb-email">Email (optional)</label><input id="fb-email" name="email" type="email" maxlength="254" autocomplete="email" /></div>
<div class="field"><label for="fb-msg">Feedback</label><textarea id="fb-msg" name="message" rows="4" required minlength="10" maxlength="2000" placeholder="What worked, what confused you, what should change?"></textarea></div>
<div><button class="btn" type="submit">Send feedback</button> <span data-status class="stat-hint"></span></div>
</form>`,
)}`;
}

function onboardingPublicBody(): string {
  return `${pageHeader("Get started", "First payment-ready project in about ten minutes.", "Five steps. Each one leaves a record the rest of the workflow can use.")}
<section class="card"><div class="card-head"><h2>The five steps</h2></div><div class="card-body">${onboardingSteps(
    [
      {
        title: "1 · Create your account",
        body: "Sign up with email + password (12+ characters). A workspace is created for you automatically.",
      },
      {
        title: "2 · Add your client",
        body: "Name + email is enough. Billing details stay private to you.",
      },
      {
        title: "3 · Create the project + milestones",
        body: "One milestone per payment; amounts sum to the project total. Add a due date per milestone so reminders can run.",
      },
      {
        title: "4 · Send terms + portal link",
        body: "Send the agreement version, issue a magic link. The client accepts, reviews previews, approves, and pays — no account needed.",
      },
      {
        title: "5 · Submit, approve, collect, release",
        body: "Share a preview → client approves that version → verified payment arrives → finals unlock. Late payers get calm follow-ups, an exact-sum plan, or a recorded pause.",
      },
    ],
  )}<p class="btn-row"><a class="btn" href="/app/onboarding">Open the guided checklist →</a></p><p class="sub">Signed in? The checklist reads your workspace live and shows what is done. New here? Create an account via <code>POST /api/v1/auth/signup</code>, then open the checklist with <code>?workspaceId=…</code>.</p></div></section>
${card("What happens automatically", `<p class="sub">Due-date reminders, verified-receipt checks, overdue follow-ups, and the evidence timeline run once milestones have due dates. You act only on approvals, revisions, and payment plans.</p>`, `<span class="pill pill-info">Automatic</span>`)}
${card("If a payment runs late", `<p class="sub">Follow-ups stay calm and system-voiced. Offer an exact-sum plan if cash flow is the issue, pause work with a recorded reason if the terms allow, and export the factual record when you need it for your files or a mediator.</p>`)}`;
}

const workspaceQuery = z.object({ workspaceId: uuidSchema });

async function onboardingIdentity(
  request: { headers: { authorization?: unknown; cookie?: unknown }; query: unknown },
  deps: RouteDeps,
): Promise<{ userId: string; workspaceId: string } | null> {
  const token = extractSessionToken({
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
  });
  if (!token) return null;
  const parsed = parseOrThrow(workspaceQuery, request.query, "Invalid workspace");
  let userId: string;
  try {
    userId = verifySessionToken({ token, sessionSecret: deps.sessionSecret }).userId;
  } catch {
    return null;
  }
  const membership = await deps.store.findMembership(userId, parsed.workspaceId);
  if (!membership) return null;
  return { userId, workspaceId: parsed.workspaceId };
}

export function registerSiteRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // Marketing homepage with API backwards-compat: browsers get HTML, API
  // clients (Accept: application/json or no html) keep the JSON envelope.
  app.get("/", async (request, reply) => {
    const accept = request.headers.accept ?? "";
    if (!accept.includes("text/html")) {
      return reply.send({
        name: "FreelancePaymentProtection API",
        version: APP_VERSION,
        docs: "/health",
        disclaimer: DISCLAIMER,
      });
    }
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(publicLayout({ title: "Home", description: HONEST_FOOTER, body: homeBody() }));
  });

  const page = (
    url: string,
    key: string,
    title: string,
    description: string,
    body: () => string,
  ): void => {
    app.get(url, async (_request, reply) => {
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "public, max-age=300")
        .send(publicLayout({ title, description, active: key, body: body() }));
    });
  };

  page(
    "/pricing",
    "pricing",
    "Pricing",
    "Simple flat pricing for the launch workspace.",
    pricingBody,
  );
  page(
    "/faq",
    "faq",
    "FAQ",
    "Honest answers about payments, escrow, approvals and records.",
    faqBody,
  );
  page("/privacy", "", "Privacy", "What the launch product stores and why.", privacyBody);
  page("/terms", "", "Terms", "Rules for using the launch product.", termsBody);
  page(
    "/contact",
    "contact",
    "Contact",
    "Contact and feedback for the launch product.",
    contactBody,
  );
  page(
    "/onboarding",
    "onboarding",
    "Get started",
    "Five-step guided setup: account, client, project, portal, payment.",
    onboardingPublicBody,
  );

  // ---- Feedback mechanism (public, validated, logged) ----
  app.post("/api/v1/feedback", async (request, reply) => {
    const body = parseOrThrow(feedbackSchema, request.body ?? {}, "Invalid feedback");
    const record: FeedbackRecord = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      category: body.category ?? "feedback",
      message: body.message.slice(0, 2000),
      ...(body.name !== undefined ? { name: body.name.slice(0, 120) } : {}),
      ...(body.email !== undefined ? { email: body.email.slice(0, 254) } : {}),
      ...(body.page !== undefined ? { page: body.page.slice(0, 500) } : {}),
    };
    feedbackInbox.push(record);
    request.log.info({ feedbackId: record.id, category: record.category }, "feedback received");
    return reply.status(201).send({
      feedback: { id: record.id, receivedAt: record.receivedAt, category: record.category },
      message: "Thank you — your note was received.",
    });
  });

  // ---- Authenticated onboarding checklist (reads the workspace live) ----
  app.get("/app/onboarding", async (request, reply) => {
    const identity = await onboardingIdentity(
      { headers: request.headers, query: request.query },
      deps,
    );
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          publicLayout({
            title: "Get started",
            description: "Sign in to open your guided setup checklist.",
            active: "onboarding",
            body: `${pageHeader("Get started", "Sign in to see your checklist.", "The guided checklist reads your workspace live. Sign in first, then reopen it with your workspace.")}<p class="sub"><strong>What to do next:</strong> <code>POST /api/v1/auth/signin</code> with email + password, or open <code>/app/onboarding?workspaceId=…</code> with a Bearer session token. Nothing is lost — your clients and projects are unchanged.</p>`,
          }),
        );
    }
    const [clients, projects] = await Promise.all([
      deps.store.listClients(identity.workspaceId),
      deps.store.listProjects(identity.workspaceId),
    ]);
    const firstProject = projects[0];
    const [milestones, payments, links] = firstProject
      ? await Promise.all([
          deps.store.listMilestones(firstProject.id),
          deps.store.listPayments(firstProject.id),
          deps.store.listPortalLinks(firstProject.id),
        ])
      : [[], [], []];
    const verifiedPaid = payments.filter(
      (p) => p.state === "paid" || p.state === "received" || p.state === "partial",
    ).length;
    const ws = escapeHtml(identity.workspaceId);
    const step = (done: boolean, title: string, bodyText: string, href?: string): string =>
      `<div class="row reveal"><div class="row-title">${done ? "✓" : "○"} ${escapeHtml(title)}</div><div class="row-meta">${escapeHtml(bodyText)}</div>${href ? `<div class="row-meta"><a href="${href}">Open →</a></div>` : ""}</div>`;
    const html = publicLayout({
      title: "Your setup checklist",
      description: "Guided setup checklist reading your workspace live.",
      active: "onboarding",
      body: `${pageHeader("Get started", "Your setup checklist.", "Live from your workspace — complete each step once. Reminders and the timeline start working as soon as milestones have due dates.")}
<div class="list">
${step(clients.length > 0, "1 · Create account", "Done automatically when you signed up — you are here.", undefined)}
${step(clients.length > 0, "2 · Add your client", clients.length > 0 ? `${clients.length} client(s) — add more any time.` : "Name + email is enough to start.", `/app/clients?workspaceId=${ws}`)}
${step(projects.length > 0, "3 · Create the project", projects.length > 0 ? `${projects.length} project(s); first: ${firstProject?.title ?? ""}.` : "Title + total + currency, attached to a client.", `/app/projects?workspaceId=${ws}`)}
${step(milestones.length > 0, "4 · Define milestones + due dates", milestones.length > 0 ? `${milestones.length} milestone(s) on the first project.` : "One milestone per payment; amounts sum to the total.", firstProject ? `/app/projects/${escapeHtml(firstProject.id)}?workspaceId=${ws}` : `/app/projects?workspaceId=${ws}`)}
${step(links.length > 0, "5 · Send the client portal", links.length > 0 ? "Portal link issued — client can review, approve and pay." : "Issue a magic link from the project API, share the URL.", undefined)}
${step(verifiedPaid > 0, "6 · Collect verified payment", verifiedPaid > 0 ? `${verifiedPaid} verified receipt(s). Finals unlock on approval + payment.` : "Hosted checkout; only provider-confirmed receipts count.", undefined)}
</div>
${card("What happens automatically", `<p class="sub">Due-date reminders, overdue follow-ups, and the evidence timeline run once milestones have due dates. Paid milestones stop follow-ups on their own.</p>`)}
<p class="sub"><a href="/app/projects?workspaceId=${ws}">Open projects →</a> · <a href="/app/clients?workspaceId=${ws}">Open clients →</a> · <a href="/faq">How overdue works →</a></p>`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });
}
