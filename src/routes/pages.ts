import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildProjectSummary } from "../domain/projectView.js";
import { buildProtectionChecks } from "../domain/protection.js";
import {
  TIMELINE_CATEGORIES,
  describeEvent,
  eventCategory,
  filterTimeline,
} from "../domain/timeline.js";
import {
  APP_CSS,
  APP_JS,
  automationNote,
  card,
  emptyState,
  errorState,
  escapeHtml,
  formatMoney,
  kv,
  layout,
  moneyBand,
  onboardingSteps,
  pageHeader,
  progressBar,
  rowTable,
  statCard,
  statGrid,
  statusPill,
  unauthenticatedPage,
} from "../ui/components.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import type { RouteDeps } from "./requestAuth.js";
import { extractSessionToken, verifySessionToken } from "../lib/session.js";

/**
 * Server-rendered workspace pages (Session 04).
 * Same ownership rules as the JSON API: the workspace comes from the query
 * string, the identity from the session cookie/Bearer, membership is checked
 * server-side, and cross-tenant rows render generic 403/404 — never the row.
 * Calm styling lives in /app/styles.css; forms POST as JSON via /app/app.js
 * (CSP-safe: no inline style/script).
 */

const workspaceQuery = z.object({ workspaceId: uuidSchema });

async function pageIdentity(
  request: { headers: { authorization?: unknown; cookie?: unknown }; query: unknown },
  deps: RouteDeps,
): Promise<{ userId: string; workspaceId: string } | null> {
  const headers = request.headers;
  const token = extractSessionToken({
    authorization: headers.authorization,
    cookie: headers.cookie,
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

function clientForm(workspaceId: string, redirect: string): string {
  const ws = escapeHtml(workspaceId);
  return card(
    "New client",
    `<form class="form" data-api-form data-method="POST" action="/api/v1/workspaces/${ws}/clients" data-redirect="${escapeHtml(redirect)}">
<div class="field"><label for="c-name">Name</label><input id="c-name" name="name" required maxlength="120" /></div>
<div class="field"><label for="c-email">Email</label><input id="c-email" name="email" type="email" required maxlength="254" /></div>
<div class="field"><label for="c-company">Company</label><input id="c-company" name="company" maxlength="120" /></div>
<div class="field"><label for="c-phone">Phone</label><input id="c-phone" name="phone" maxlength="40" /></div>
<div class="field"><label for="c-tz">Timezone</label><input id="c-tz" name="timezone" maxlength="64" placeholder="e.g. America/New_York" /></div>
<div class="field"><label for="c-country">Country (2 letters)</label><input id="c-country" name="country" maxlength="2" placeholder="US" /></div>
<div class="field"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes" rows="3" maxlength="2000"></textarea></div>
<div><button class="btn" type="submit">Create client</button> <span data-status class="stat-hint"></span></div>
</form>`,
  );
}

function projectForm(
  workspaceId: string,
  clients: { id: string; name: string }[],
  redirect: string,
): string {
  const ws = escapeHtml(workspaceId);
  const options = clients
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
    .join("");
  return card(
    "New project",
    `<form class="form" data-api-form data-method="POST" action="/api/v1/workspaces/${ws}/projects" data-redirect="${escapeHtml(redirect)}">
<div class="field"><label for="p-client">Client</label><select id="p-client" name="clientId">${options}</select></div>
<div class="field"><label for="p-title">Title</label><input id="p-title" name="title" required maxlength="120" /></div>
<div class="field"><label for="p-desc">Description</label><textarea id="p-desc" name="description" rows="3" maxlength="2000"></textarea></div>
<div class="field"><label for="p-total">Total value (cents)</label><input id="p-total" name="totalValueCents" inputmode="numeric" required placeholder="500000" /></div>
<div class="field"><label for="p-cur">Currency (3 letters)</label><input id="p-cur" name="currency" maxlength="3" value="USD" /></div>
<div class="field"><label for="p-terms">Payment terms</label><input id="p-terms" name="paymentTerms" maxlength="1000" placeholder="e.g. Milestone 1 on approval, balance on delivery" /></div>
<div><button class="btn" type="submit">Create project</button> <span data-status class="stat-hint"></span></div>
</form>`,
  );
}

export function registerPageRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/app/styles.css", async (_req, reply) => {
    // Static, versioned-with-deploy asset: safe for short public caching.
    // Markup is server-rendered per request and stays private (no caching).
    return reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(APP_CSS);
  });
  app.get("/app/app.js", async (_req, reply) => {
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(APP_JS);
  });

  app.get("/app", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const ws = typeof query.workspaceId === "string" ? query.workspaceId : "";
    if (ws) return reply.redirect(`/app/projects?workspaceId=${encodeURIComponent(ws)}`);
    // Signed-in visitor with no workspace in the URL: land them in their
    // first workspace instead of the static intro. Any failure (no session,
    // no memberships) falls through to the intro page below.
    try {
      const token = extractSessionToken({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      if (token) {
        const { userId } = verifySessionToken({ token, sessionSecret: deps.sessionSecret });
        const owned = await deps.store.listWorkspacesForUser(userId);
        const first = owned[0];
        if (first)
          return await reply.redirect(`/app/projects?workspaceId=${encodeURIComponent(first.id)}`);
      }
    } catch {
      // Fall through to the static landing page.
    }
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="description" content="FreelancePaymentProtection — payment protection for freelancers: milestones, approvals, verified payments and evidence." /><meta name="theme-color" content="#090909" /><title>FreelancePaymentProtection</title><link rel="stylesheet" href="/app/styles.css" /></head>
<body><a class="skip" href="#main-content">Skip to content</a><main class="wrap narrow" id="main-content" tabindex="-1"><div class="spot spot-violet reveal"><p class="spot-kicker">Workspace</p><p class="spot-title">Payment protection, calmly.</p></div><div class="card"><div class="card-body"><h1 class="h1">Four answers, always visible.</h1>
<p class="sub">What money is safe, what is owed, what you should do next, and what happens automatically. Open your workspace projects or clients with <code>?workspaceId=…</code>.</p>${onboardingSteps(
      [
        {
          title: "Add a client",
          body: "Name + email is enough. Billing details stay private to you.",
        },
        {
          title: "Create a project with milestones",
          body: "Each milestone is progress with an amount — never a deposit label.",
        },
        {
          title: "Share previews, collect approval",
          body: "The client reviews previews; approval is pinned to that version.",
        },
        {
          title: "Get paid, then finals unlock",
          body: "Only verified provider receipts count. Finals release automatically on approval + payment.",
        },
      ],
    )}<p class="sub">No threatening language anywhere: overdue reads as a calm follow-up, never a collection notice. Every money number cites verified receipts.</p></div></div></main><script src="/app/app.js" defer></script></body></html>`;
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Client list ----
  app.get("/app/clients", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const clients = await deps.store.listClients(identity.workspaceId);
    const onboarding =
      clients.length === 0
        ? card(
            "How clients fit",
            `${onboardingSteps([
              { title: "Add the client", body: "They never see your notes or billing contacts." },
              { title: "Create their project", body: "Milestones, amounts and due dates follow." },
              {
                title: "Invite them with a portal link",
                body: "They review, approve and pay — you keep leverage until then.",
              },
            ])}${automationNote("Portal invitations, approvals and payment receipts are recorded in the evidence timeline automatically.")}`,
          )
        : "";
    const rows =
      clients.length === 0
        ? emptyState(
            "No clients yet",
            "Add your first client below — name and email is enough to start. Details stay editable.",
          )
        : `<div class="list">${clients
            .map(
              (c) =>
                `<a class="row" href="/app/clients/${escapeHtml(c.id)}?workspaceId=${escapeHtml(identity.workspaceId)}"><div class="row-title">${escapeHtml(c.name)} ${statusPill(c.status)}</div><div class="row-meta">${escapeHtml(c.company ?? c.email)} · ${escapeHtml(c.email)}</div></a>`,
            )
            .join("")}</div>`;
    const html = layout({
      title: "Clients",
      active: "clients",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Workspace", title: "Clients", sub: "People who pay you. Calm records, no CRM noise." })}${rows}${onboarding}${clientForm(identity.workspaceId, `/app/clients?workspaceId=${escapeHtml(identity.workspaceId)}`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Client detail ----
  app.get("/app/clients/:clientId", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ clientId: uuidSchema }),
      request.params,
      "Invalid client id",
    );
    const client = await deps.store.findClient(params.clientId);
    if (client?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "clients",
            workspaceId: identity.workspaceId,
            body: emptyState("Not found", "This client is not in your workspace."),
          }),
        );
    }
    const projects = (await deps.store.listProjects(identity.workspaceId)).filter(
      (p) => p.clientId === client.id,
    );
    const ws = escapeHtml(identity.workspaceId);
    const detail = rowTable([
      kv("Email", escapeHtml(client.email)),
      ...(client.company ? [kv("Company", escapeHtml(client.company))] : []),
      ...(client.phone ? [kv("Phone", escapeHtml(client.phone))] : []),
      ...(client.billingEmail ? [kv("Billing email", escapeHtml(client.billingEmail))] : []),
      ...(client.billingAddress ? [kv("Billing address", escapeHtml(client.billingAddress))] : []),
      ...(client.timezone ? [kv("Timezone", escapeHtml(client.timezone))] : []),
      ...(client.country ? [kv("Country", escapeHtml(client.country))] : []),
      ...(client.notes ? [kv("Notes", escapeHtml(client.notes))] : []),
      kv("Status", statusPill(client.status)),
    ]);
    const projectRows =
      projects.length === 0
        ? `<p class="sub">No projects for this client yet.</p>`
        : `<div class="list">${projects
            .map(
              (p) =>
                `<a class="row" href="/app/projects/${escapeHtml(p.id)}?workspaceId=${ws}"><div class="row-title">${escapeHtml(p.title)} ${statusPill(p.status)}</div><div class="row-meta">${formatMoney(p.totalValueCents, p.currency)} ${escapeHtml(p.currency)}</div></a>`,
            )
            .join("")}</div>`;
    const html = layout({
      title: client.name,
      active: "clients",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Client", title: client.name, sub: client.company ?? client.email })}
${card("Contact & billing", detail, statusPill(client.status))}
${card("Projects", projectRows)}
${card("Edit client", `<form class="form" data-api-form data-method="PATCH" action="/api/v1/workspaces/${ws}/clients/${escapeHtml(client.id)}"><div class="field"><label for="e-phone">Phone</label><input id="e-phone" name="phone" maxlength="40" value="${escapeHtml(client.phone ?? "")}" /></div><div class="field"><label for="e-notes">Notes</label><textarea id="e-notes" name="notes" rows="3" maxlength="2000">${escapeHtml(client.notes ?? "")}</textarea></div><div><button class="btn" type="submit">Save changes</button> <span data-status class="stat-hint"></span></div></form>`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Project list ----
  app.get("/app/projects", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const [projects, clients] = await Promise.all([
      deps.store.listProjects(identity.workspaceId),
      deps.store.listClients(identity.workspaceId),
    ]);
    const clientName = new Map(clients.map((c) => [c.id, c.name] as const));
    const moneyTotals = ((): { pipeline: number; currency: string } => {
      let pipeline = 0;
      for (const p of projects) pipeline += p.totalValueCents;
      return { pipeline, currency: projects[0]?.currency ?? "USD" };
    })();
    const moneyOverview =
      projects.length === 0
        ? ""
        : moneyBand([
            {
              label: "Pipeline under protection",
              value: formatMoney(moneyTotals.pipeline, moneyTotals.currency),
              hint: `${projects.length} project${projects.length === 1 ? "" : "s"} · totals stay authoritative`,
              tone: "info",
            },
            {
              label: "What to watch",
              value: `${projects.filter((p) => p.status === "active").length} active`,
              hint: "Open a project for safe / owed / next",
            },
          ]);
    const starter =
      projects.length === 0
        ? card(
            "Start in four steps",
            `${onboardingSteps([
              {
                title: "Project + milestones",
                body: "One milestone per payment. Amounts sum to the total.",
              },
              { title: "Agreement", body: "Send terms, client accepts the version — hash-pinned." },
              {
                title: "Preview + approval",
                body: "Client reviews previews; approval pins that version.",
              },
              {
                title: "Verified payment unlocks finals",
                body: "Claims never count. Receipts release files.",
              },
            ])}${automationNote("Reminders, receipts and the evidence timeline run automatically once milestones have due dates.")}`,
          )
        : "";
    const rows =
      projects.length === 0
        ? emptyState(
            "No projects yet",
            "Create your first protected project below. Milestones, approvals and verified payments will live here.",
          )
        : `<div class="list">${projects
            .map(
              (p) =>
                `<a class="row" href="/app/projects/${escapeHtml(p.id)}?workspaceId=${escapeHtml(identity.workspaceId)}"><div class="row-title">${escapeHtml(p.title)} ${statusPill(p.status)}</div><div class="row-meta">${escapeHtml(clientName.get(p.clientId) ?? "Client")} · ${formatMoney(p.totalValueCents, p.currency)} · open the command center for safe / owed / next</div></a>`,
            )
            .join("")}</div>`;
    const automation =
      projects.length === 0
        ? ""
        : card(
            "What happens automatically",
            `<p class="sub">Due-date reminders, verified-receipt checks, overdue follow-ups and the evidence timeline run for every project. You only act on approvals, revisions and payment plans.</p>${automationNote("Nothing here sends threats or labels clients — overdue reads as a calm, system-voiced follow-up.")}`,
          );
    const html = layout({
      title: "Projects",
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Workspace", title: "Projects", sub: "Each project is a command center: value, payments, next action." })}${moneyOverview}${rows}${starter}${automation}${
        clients.length > 0
          ? projectForm(
              identity.workspaceId,
              clients.map((c) => ({ id: c.id, name: c.name })),
              `/app/projects?workspaceId=${escapeHtml(identity.workspaceId)}`,
            )
          : card(
              "New project",
              `<p class="sub">Add a client first, then create a project.</p>${onboardingSteps([
                { title: "Add a client", body: "Name + email is enough." },
                { title: "Return here", body: "The project form appears automatically." },
              ])}`,
            )
      }`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Project detail: command center ----
  app.get("/app/projects/:projectId", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema }),
      request.params,
      "Invalid project id",
    );
    const project = await deps.store.findProject(params.projectId);
    if (project?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: errorState(
              "Not found",
              "This project is not in your workspace.",
              "Return to Projects and open a project from the list — links carry your workspace automatically.",
            ),
          }),
        );
    }
    const [client, milestones, payments, events, agreements, deliverables, approvals] =
      await Promise.all([
        deps.store.findClient(project.clientId),
        deps.store.listMilestones(project.id),
        deps.store.listPayments(project.id),
        deps.store.listProjectEvents(project.id, 8),
        deps.store.listAgreements(project.id),
        deps.store.listDeliverablesByProject(project.id),
        deps.store.listApprovalsByProject(project.id),
      ]);
    const summary = buildProjectSummary({ project, milestones, payments, events });
    const ws = escapeHtml(identity.workspaceId);
    const money = (cents: number): string => formatMoney(cents, project.currency);

    const moneyOverview = moneyBand([
      {
        label: "Safe — verified paid",
        value: money(summary.amountPaidCents),
        hint: "Provider receipts only · claims never count",
        tone: "ok",
      },
      {
        label: "Owed — outstanding",
        value: money(summary.outstandingCents),
        hint:
          summary.paymentStatus === "overdue"
            ? "Past due — calm follow-up is running"
            : "Across open milestones",
        tone: summary.paymentStatus === "overdue" ? "warn" : "info",
      },
      {
        label: "Due next",
        value: summary.currentMilestone ? money(summary.currentMilestone.amountCents) : money(0),
        hint: summary.currentMilestone ? summary.currentMilestone.title : "Nothing open",
      },
    ]);

    const stats = statGrid([
      statCard("Total project value", money(summary.totalValueCents)),
      statCard("Amount paid", money(summary.amountPaidCents), "Verified receipts only"),
      statCard("Amount outstanding", money(summary.outstandingCents)),
      statCard(
        "Progress",
        `${summary.progressPercent}%`,
        `${summary.paidMilestoneCount}/${summary.milestoneCount} milestones paid`,
      ),
    ]);

    const current = summary.currentMilestone
      ? rowTable([
          kv("Milestone", escapeHtml(summary.currentMilestone.title)),
          kv("Amount", money(summary.currentMilestone.amountCents)),
          kv("Work", statusPill(summary.currentMilestone.workState)),
          kv("Payment", statusPill(summary.currentMilestone.paymentState)),
        ])
      : `<p class="sub">No open milestones — everything is settled.</p>`;
    const currentDue = ((): string => {
      if (!summary.currentMilestone) return "";
      const row = milestones.find((m) => m.id === summary.currentMilestone?.id);
      if (!row?.dueDate)
        return `<p class="sub">No due date set — add one so reminders and overdue can run.</p>`;
      const due = row.dueDate.toISOString().slice(0, 10);
      const overdue = summary.paymentStatus === "overdue";
      return overdue
        ? `<p class="sub">Was due ${escapeHtml(due)}. The system keeps a calm follow-up going — you do not need to chase personally.</p>`
        : `<p class="sub">Due ${escapeHtml(due)}. Reminders go out automatically; you act only on approval or payment.</p>`;
    })();

    const activity =
      summary.recentActivity.length === 0
        ? `<p class="sub">No activity yet. Agreement, approvals and payments will appear here.</p>`
        : `<ul class="timeline">${summary.recentActivity
            .map(
              (a) =>
                `<li><time>${escapeHtml(a.occurredAt.slice(0, 10))}</time><span><strong>${escapeHtml(a.label)}</strong> <span class="stat-hint">· ${escapeHtml(a.actorType)}</span></span></li>`,
            )
            .join("")}</ul>`;

    const milestoneAction = (m: (typeof milestones)[number]): string => {
      if (m.paymentState === "paid") return "Settled — finals released once approved.";
      if (m.paymentState === "overdue")
        return "Calm follow-up running — consider a payment plan if they need time.";
      if (m.workState === "revision_requested") return "Address the feedback, then resubmit.";
      if (m.workState === "submitted" || m.workState === "viewed")
        return "Waiting on client review — approval or changes.";
      if (m.workState === "approved") return "Approved — payment completes it.";
      if (m.workState === "draft") return "Share a preview to start review.";
      return "In progress — no action needed yet.";
    };
    const milestoneList =
      milestones.length === 0
        ? emptyState(
            "No milestones yet",
            "Add milestones so each payment has progress attached. The total above stays authoritative.",
          )
        : `<table class="table"><thead><tr><th>Milestone</th><th>Amount</th><th>Due</th><th>Work</th><th>Payment</th><th>What you should do</th></tr></thead><tbody>${milestones
            .map(
              (m) =>
                `<tr><td><strong>${escapeHtml(m.title)}</strong><div class="stat-hint">Approval: ${escapeHtml(m.approvalState)} · Delivery: ${escapeHtml(m.deliverableState)}</div></td><td>${money(m.amountCents)}</td><td>${m.dueDate ? escapeHtml(m.dueDate.toISOString().slice(0, 10)) : `<span class="stat-hint">no date</span>`}</td><td>${statusPill(m.workState)}</td><td>${statusPill(m.paymentState)}</td><td><span class="stat-hint">${escapeHtml(milestoneAction(m))}</span></td></tr>`,
            )
            .join(
              "",
            )}</tbody></table>${automationNote("Approval pins the preview version; verified payment unlocks finals. Claims never unlock anything.")}`;

    const accepted = agreements.filter((a) => a.status === "accepted").length;
    const reviewable = deliverables.filter((d) =>
      ["preview_available", "client_review"].includes(d.status),
    ).length;
    const approvedCount = approvals.filter((a) => a.decision === "approved").length;
    const operations = card(
      "Operations — approvals, payments, reminders",
      rowTable([
        kv(
          "Agreement",
          accepted > 0
            ? `${accepted} accepted version${accepted === 1 ? "" : "s"} — milestones follow it`
            : "No accepted version yet — send terms, client accepts the hash-pinned version",
        ),
        kv(
          "Deliverable review",
          reviewable > 0
            ? `${reviewable} preview${reviewable === 1 ? "" : "s"} waiting on client review — previews are review-only, finals stay locked`
            : "No previews waiting — share one to start approval",
        ),
        kv(
          "Approvals",
          approvedCount > 0
            ? `${approvedCount} approval${approvedCount === 1 ? "" : "s"} recorded, pinned to versions`
            : "No approvals yet — client approval pins the current preview version",
        ),
        kv(
          "Reminders",
          "Set due dates, then schedule: T-3 / due / T+3 / T+7 automatic, escalation only by hand",
        ),
        kv(
          "Overdue workflow",
          "Calm follow-ups first — then offer a payment plan, pause work, export evidence. Never threats.",
        ),
      ]),
    );

    const html = layout({
      title: project.title,
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: client ? `Project · ${client.name}` : "Project", title: project.title, sub: project.description ?? "" })}
${moneyOverview}
<div class="nextaction"><strong>Next action:</strong> ${escapeHtml(summary.nextAction)}</div>
${currentDue}
${stats}
<div class="grid2">
${card("Current milestone", current)}
${card("Status", rowTable([kv("Project status", statusPill(summary.projectStatus)), kv("Payment status", statusPill(summary.paymentStatus)), kv("Payment terms", escapeHtml(project.paymentTerms ?? "—")), kv("Expected completion", escapeHtml(project.expectedCompletion ? project.expectedCompletion.toISOString().slice(0, 10) : "—"))]) + progressBar(summary.progressPercent))}
</div>
${card("Milestone timeline", milestoneList)}
${operations}
${card("Recent activity", `${activity}<p class="sub"><a href="/app/projects/${escapeHtml(project.id)}/protection?workspaceId=${ws}">Open Project health →</a> 12 observable protection checks, each citing its evidence. · <a href="/app/projects/${escapeHtml(project.id)}/timeline?workspaceId=${ws}">Open the full evidence timeline →</a> Chronological, filterable, immutable. · <a href="/app/projects/${escapeHtml(project.id)}/evidence?workspaceId=${ws}">Evidence packs →</a> Factual exports for records, mediation, or review. · <a href="/app/projects/${escapeHtml(project.id)}/ai?workspaceId=${ws}">AI drafts →</a> Extractive helpers (terms, messages, reminders, summary, consistency) — every output needs review. · <a href="/app/notifications?workspaceId=${ws}">Notification center →</a> Inbox, preferences, delivery status.</p>`)}
${card("Edit project", `<form class="form" data-api-form data-method="PATCH" action="/api/v1/workspaces/${ws}/projects/${escapeHtml(project.id)}"><div class="field"><label for="pe-title">Title</label><input id="pe-title" name="title" maxlength="120" value="${escapeHtml(project.title)}" /></div><div class="field"><label for="pe-terms">Payment terms</label><input id="pe-terms" name="paymentTerms" maxlength="1000" value="${escapeHtml(project.paymentTerms ?? "")}" /></div><div><button class="btn" type="submit">Save changes</button> <span data-status class="stat-hint"></span></div></form>`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Evidence timeline: full chronological history + filters ----
  app.get("/app/projects/:projectId/timeline", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema }),
      request.params,
      "Invalid project id",
    );
    const project = await deps.store.findProject(params.projectId);
    if (project?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: errorState(
              "Not found",
              "This project is not in your workspace.",
              "Return to Projects and open a project from the list — links carry your workspace automatically.",
            ),
          }),
        );
    }
    const q = request.query as Record<string, unknown>;
    const category = typeof q.category === "string" ? q.category : "";
    const actorType = typeof q.actorType === "string" ? q.actorType : "";
    const search = typeof q.search === "string" ? q.search : "";
    const order = q.order === "desc" ? "desc" : "asc";
    const ws = escapeHtml(identity.workspaceId);
    const pid = escapeHtml(project.id);

    const [milestones, all] = await Promise.all([
      deps.store.listMilestones(project.id),
      deps.store.listProjectEvents(project.id, 500),
    ]);
    const titleById = new Map(milestones.map((m) => [m.id, m.title] as const));
    const categories =
      category && (TIMELINE_CATEGORIES as readonly string[]).includes(category)
        ? [category as (typeof TIMELINE_CATEGORIES)[number]]
        : [];
    const filtered = filterTimeline(
      all.map((e) => ({
        id: e.id,
        type: e.type,
        actorType: e.actorType,
        ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
        occurredAt: e.occurredAt,
        payload: e.payload,
      })),
      {
        ...(categories.length > 0 ? { categories } : {}),
        ...(actorType ? { actorTypes: [actorType] } : {}),
        ...(search ? { search } : {}),
      },
    );
    const byId = new Map(all.map((e) => [e.id, e] as const));
    const rows = filtered
      .map((f) => byId.get(f.id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined);
    const ordered = order === "desc" ? [...rows].reverse() : rows;

    const options = (values: readonly string[], current: string): string =>
      [`<option value="">All</option>`]
        .concat(
          values.map(
            (v) =>
              `<option value="${escapeHtml(v)}"${v === current ? " selected" : ""}>${escapeHtml(v)}</option>`,
          ),
        )
        .join("");
    const filterForm = `<form class="form" method="get" action="/app/projects/${pid}/timeline">
<input type="hidden" name="workspaceId" value="${ws}" />
<div class="field"><label for="f-cat">Category</label><select id="f-cat" name="category">${options(TIMELINE_CATEGORIES, category)}</select></div>
<div class="field"><label for="f-actor">Actor</label><select id="f-actor" name="actorType">${options(["freelancer", "client", "system", "provider"], actorType)}</select></div>
<div class="field"><label for="f-q">Search</label><input id="f-q" name="search" maxlength="200" value="${escapeHtml(search)}" placeholder="e.g. payment, approval" /></div>
<div class="field"><label for="f-order">Order</label><select id="f-order" name="order">${options(["asc", "desc"], order)}</select></div>
<div><button class="btn" type="submit">Filter timeline</button> <span class="stat-hint">${ordered.length} of ${all.length} events · oldest first when asc</span></div>
</form>`;

    const list =
      ordered.length === 0
        ? all.length === 0
          ? emptyState(
              "History starts here",
              "Agreement versions, approvals, payments, reminders and pauses will appear in order. Nothing to do — recording is automatic.",
            )
          : emptyState(
              "No events match",
              "Clear the filters to see the full history. Filters never delete anything.",
            )
        : `<ul class="timeline">${ordered
            .map((e) => {
              const milestoneTitle =
                e.milestoneId !== undefined ? titleById.get(e.milestoneId) : undefined;
              const d = describeEvent({
                type: e.type,
                ...(milestoneTitle !== undefined ? { milestoneTitle } : {}),
                payload: e.payload,
              });
              return `<li><time>${escapeHtml(e.occurredAt.toISOString().slice(0, 16).replace("T", " "))}</time><span><strong>${escapeHtml(d.headline)}</strong><br /><span class="stat-hint">${escapeHtml(d.label)} · ${escapeHtml(eventCategory(e.type))} · ${escapeHtml(e.actorType)} · <a href="/app/projects/${pid}/timeline/${escapeHtml(e.id)}?workspaceId=${ws}">detail →</a></span></span></li>`;
            })
            .join(
              "",
            )}</ul>${automationNote("New approvals, payments, reminders and pauses append here automatically. Corrections arrive as new events, never edits.")}`;

    const html = layout({
      title: `Timeline — ${project.title}`,
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Evidence timeline", title: project.title, sub: "Every important project event, oldest first. Append-only — history cannot be edited or deleted." })}
<p class="sub"><a href="/app/projects/${pid}?workspaceId=${ws}">← Back to project</a></p>
${card("How to read this", `<p class="sub">Newest context at the bottom when oldest-first. Filter by who acted or what happened; each row links to its recorded facts. If a client asks “what happened?”, point them to their portal updates — this page is your complete record.</p>`)}
${card("Filter", filterForm)}
${card(`History (${ordered.length})`, list)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Evidence timeline: single event detail ----
  app.get("/app/projects/:projectId/timeline/:eventId", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema, eventId: uuidSchema }),
      request.params,
      "Invalid ids",
    );
    const project = await deps.store.findProject(params.projectId);
    if (project?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: errorState(
              "Not found",
              "This project is not in your workspace.",
              "Return to Projects and open a project from the list — links carry your workspace automatically.",
            ),
          }),
        );
    }
    const row = await deps.store.findProjectEventById(params.eventId);
    if (row?.projectId !== project.id || row.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: emptyState("Event not found", "This event is not part of this project."),
          }),
        );
    }
    const ws = escapeHtml(identity.workspaceId);
    const pid = escapeHtml(project.id);
    const milestones = await deps.store.listMilestones(project.id);
    const milestone = milestones.find((m) => m.id === row.milestoneId);
    const d = describeEvent({
      type: row.type,
      ...(milestone ? { milestoneTitle: milestone.title } : {}),
      payload: row.payload,
    });
    const facts = Object.entries(row.payload)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => kv(k, escapeHtml(String(v))));
    const html = layout({
      title: d.label,
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: `Event · ${d.category} · ${d.label}`, title: d.headline, sub: d.detail })}
<p class="sub"><a href="/app/projects/${pid}/timeline?workspaceId=${ws}">← Back to timeline</a></p>
${card("What happened", rowTable([kv("Type", escapeHtml(row.type)), kv("Category", escapeHtml(d.category)), kv("Actor", escapeHtml(row.actorType)), ...(row.milestoneId ? [kv("Milestone", escapeHtml(milestone?.title ?? row.milestoneId))] : []), kv("Occurred at", escapeHtml(row.occurredAt.toISOString())), kv("Record", statusPill("immutable"))]))}
${card("Recorded facts", facts.length > 0 ? rowTable(facts) : `<p class="sub">No extra facts recorded.</p>`)}
${card("Integrity", `<p class="sub">Event records are append-only: they cannot be edited or deleted through the UI or API. Corrections arrive as new events, so this page always shows what actually happened.</p>`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Evidence packs: factual exports for overdue/disputed projects ----
  app.get("/app/projects/:projectId/evidence", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema }),
      request.params,
      "Invalid project id",
    );
    const project = await deps.store.findProject(params.projectId);
    if (project?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: errorState(
              "Not found",
              "This project is not in your workspace.",
              "Return to Projects and open a project from the list — links carry your workspace automatically.",
            ),
          }),
        );
    }
    const ws = escapeHtml(identity.workspaceId);
    const pid = escapeHtml(project.id);
    const packs = await deps.store.listEvidencePacksByProject(project.id);
    const list =
      packs.length === 0
        ? emptyState(
            "No evidence packs yet",
            "Generate one below when a project is overdue or disputed. Each export is a new immutable record.",
          )
        : `<div class="list">${packs
            .map(
              (p) =>
                `<a class="row" href="/app/projects/${pid}/evidence/${escapeHtml(p.id)}?workspaceId=${ws}"><div class="row-title">Export ${escapeHtml(p.generatedAt.toISOString().slice(0, 16).replace("T", " "))} UTC ${statusPill("immutable")}</div><div class="row-meta">${p.eventSeqTo} events · sha ${escapeHtml(p.sha256.slice(0, 12))} · ${escapeHtml(p.agreementVersionHashes.length)} agreement hash(es)</div></a>`,
            )
            .join("")}</div>`;
    const overdueGuide = card(
      "When to use this",
      onboardingSteps([
        { title: "Calm follow-ups first", body: "Automatic reminders + one personal note." },
        { title: "Offer a payment plan", body: "Exact-sum schedule if cash flow is the issue." },
        { title: "Pause work if needed", body: "Recorded as an event — history stays intact." },
        {
          title: "Export evidence",
          body: "Factual pack for your records or a mediator — never a threat.",
        },
      ]),
    );
    const generate = card(
      "New evidence pack",
      `<form class="form" data-api-form data-method="POST" action="/api/v1/workspaces/${ws}/projects/${pid}/evidence-packs" data-redirect="/app/projects/${pid}/evidence?workspaceId=${ws}">
<div><button class="btn" type="submit">Generate evidence pack</button> <span data-status class="stat-hint"></span></div>
<p class="sub">Factual record only: parties, project, agreement, milestones, payments, deliverables, approvals, revisions, timeline, reminders, payment plans. Not legal advice; it does not guarantee any dispute outcome. To keep as PDF, open the export and print → “Save as PDF”.</p>
</form>`,
    );
    const html = layout({
      title: `Evidence — ${project.title}`,
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Evidence pack", title: project.title, sub: "Factual exports for your records, accountant, mediator, collections professional, lawyer, or court/tribunal review. Each generation is immutable." })}
<p class="sub"><a href="/app/projects/${pid}?workspaceId=${ws}">← Back to project</a></p>
${list}${overdueGuide}${generate}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Evidence pack: single export detail ----
  app.get("/app/projects/:projectId/evidence/:packId", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema, packId: uuidSchema }),
      request.params,
      "Invalid ids",
    );
    const project = await deps.store.findProject(params.projectId);
    if (project?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: errorState(
              "Not found",
              "This project is not in your workspace.",
              "Return to Projects and open a project from the list — links carry your workspace automatically.",
            ),
          }),
        );
    }
    const pack = await deps.store.findEvidencePack(params.packId);
    if (pack?.projectId !== project.id || pack.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: emptyState("Export not found", "This evidence pack is not part of this project."),
          }),
        );
    }
    const ws = escapeHtml(identity.workspaceId);
    const pid = escapeHtml(project.id);
    const eid = escapeHtml(pack.id);
    const html = layout({
      title: "Evidence pack",
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Evidence pack", title: `Export ${pack.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`, sub: "Factual record. Not legal advice. It does not guarantee any dispute outcome." })}
<p class="sub"><a href="/app/projects/${pid}/evidence?workspaceId=${ws}">← Back to evidence packs</a></p>
${card("Integrity", rowTable([kv("Pack id", escapeHtml(pack.id)), kv("Generated at", escapeHtml(pack.generatedAt.toISOString())), kv("Events covered", escapeHtml(String(pack.eventSeqTo))), kv("Canonical sha256", `<code>${escapeHtml(pack.sha256)}</code>`), kv("Agreement hashes", pack.agreementVersionHashes.length > 0 ? pack.agreementVersionHashes.map((h) => `<code>${escapeHtml(h.slice(0, 16))}</code>`).join(" ") : "None recorded")]))}
${card("Exports", `<p class="sub"><a href="/api/v1/workspaces/${ws}/projects/${pid}/evidence-packs/${eid}">Open as JSON →</a> Machine-readable snapshot with the same sha256 pin.</p><p class="sub"><a href="/api/v1/workspaces/${ws}/projects/${pid}/evidence-packs/${eid}?format=html">Open printable export →</a> Clean layout for records, mediation, or review — print → “Save as PDF” to keep a PDF copy.</p>`)}
${card("Integrity note", `<p class="sub">Exports are immutable: corrections arrive as new project events and new pack generations, never edits. If records changed after generation, the JSON view reports the drift factually.</p>`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Project health: observable protection checks ----
  app.get("/app/projects/:projectId/protection", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema }),
      request.params,
      "Invalid project id",
    );
    const project = await deps.store.findProject(params.projectId);
    if (project?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: errorState(
              "Not found",
              "This project is not in your workspace.",
              "Return to Projects and open a project from the list — links carry your workspace automatically.",
            ),
          }),
        );
    }
    const ws = escapeHtml(identity.workspaceId);
    const pid = escapeHtml(project.id);
    const [milestones, payments, agreements, deliverables, approvals, events, plans] =
      await Promise.all([
        deps.store.listMilestones(project.id),
        deps.store.listPayments(project.id),
        deps.store.listAgreements(project.id),
        deps.store.listDeliverablesByProject(project.id),
        deps.store.listApprovalsByProject(project.id),
        deps.store.listProjectEvents(project.id, 500),
        deps.store.listPaymentPlansByProject(project.id),
      ]);
    const report = buildProtectionChecks({
      project: {
        id: project.id,
        title: project.title,
        currency: project.currency,
        totalValueCents: project.totalValueCents,
        ...(project.paymentTerms !== undefined ? { paymentTerms: project.paymentTerms } : {}),
      },
      milestones: milestones.map((m) => ({
        id: m.id,
        title: m.title,
        amountCents: m.amountCents,
        ...(m.dueDate !== undefined ? { dueDate: m.dueDate } : {}),
        paymentState: m.paymentState,
        approvalState: m.approvalState,
        deliverableState: m.deliverableState,
        orderIndex: m.orderIndex,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
        amountCents: p.amountCents,
        state: p.state,
      })),
      agreements: agreements.map((a) => ({
        id: a.id,
        version: a.version,
        status: a.status,
        acceptedPaymentMethods: [...a.acceptedPaymentMethods],
      })),
      deliverables: deliverables.map((d) => ({
        id: d.id,
        milestoneId: d.milestoneId,
        title: d.title,
        status: d.status,
      })),
      approvals: approvals.map((a) => ({
        milestoneId: a.milestoneId,
        ...(a.deliverableId !== undefined ? { deliverableId: a.deliverableId } : {}),
        decision: a.decision,
      })),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        actorType: e.actorType,
        occurredAt: e.occurredAt,
        ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
      })),
      paymentPlans: plans.map((p) => ({
        id: p.id,
        milestoneId: p.milestoneId,
        state: p.state,
        installments: p.installments.map((i) => ({
          seq: i.seq,
          amountCents: i.amountCents,
          dueDate: i.dueDate,
          status: i.status,
        })),
      })),
    });
    const needsAttention = report.checks.filter((c) => c.status === "needs_attention");
    const clear = report.checks.filter((c) => c.status !== "needs_attention");
    const renderRow = (c: (typeof report.checks)[number]): string =>
      `<div class="row"><div class="row-title">${escapeHtml(c.title)} ${statusPill(c.status === "needs_attention" ? "needs attention" : "clear")}</div><div class="row-meta">${escapeHtml(c.detail)}</div><div class="row-meta"><strong>Next:</strong> ${escapeHtml(c.nextStep)}</div><div class="row-meta stat-hint">Evidence: amounts, dates and ids are attached in the JSON view.</div></div>`;
    const items =
      report.checks.length === 0
        ? emptyState("No checks", "Protection checks will appear here.")
        : `${
            needsAttention.length > 0
              ? card(
                  `Needs attention (${needsAttention.length})`,
                  `<div class="list">${needsAttention.map(renderRow).join("")}</div>`,
                )
              : card(
                  "Needs attention (0)",
                  `<p class="sub">Nothing needs you right now. The system keeps watching due dates, approvals and receipts.</p>`,
                )
          }${
            clear.length > 0
              ? card(
                  `Clear (${clear.length})`,
                  `<div class="list">${clear.map(renderRow).join("")}</div>`,
                )
              : ""
          }${automationNote("Checks recompute from live records on every visit. Fix the workflow step — the check clears itself.")}`;
    const html = layout({
      title: `Project health — ${project.title}`,
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Protection checks", title: project.title, sub: `Project health: ${report.attentionCount} need attention · ${report.clearCount} clear. Every warning cites the project data behind it — there is no automated risk score.` })}
<p class="sub"><a href="/app/projects/${pid}?workspaceId=${ws}">← Back to project</a> · <a href="/api/v1/workspaces/${ws}/projects/${pid}/protection">Open as JSON →</a></p>
${items}
${card("About these checks", `<p class="sub">These checks describe observable workflow conditions (missing deposit, overdue milestone, unsigned agreement, gated finals). They never label the client and never predict outcomes. Informational workflow record. Not legal advice.</p>`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- AI drafts: workflow-scoped extractive helpers (no chatbot) ----
  app.get("/app/projects/:projectId/ai", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema }),
      request.params,
      "Invalid project id",
    );
    const project = await deps.store.findProject(params.projectId);
    if (project?.workspaceId !== identity.workspaceId) {
      return reply
        .status(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          layout({
            title: "Not found",
            active: "projects",
            workspaceId: identity.workspaceId,
            body: errorState(
              "Not found",
              "This project is not in your workspace.",
              "Return to Projects and open a project from the list — links carry your workspace automatically.",
            ),
          }),
        );
    }
    const ws = escapeHtml(identity.workspaceId);
    const pid = escapeHtml(project.id);
    const milestones = await deps.store.listMilestones(project.id);
    const milestoneOptions =
      milestones.length === 0
        ? `<p class="sub">No milestones yet — drafts that need a milestone (reminder draft) will work once one exists.</p>`
        : `<div class="field"><label for="ai-milestone">Milestone (for reminder draft)</label><select id="ai-milestone" name="milestoneId">${milestones
            .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.title)}</option>`)
            .join("")}</select></div>`;
    const html = layout({
      title: `AI drafts — ${project.title}`,
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "AI drafts", title: project.title, sub: "Extractive helpers only: terms, messages, reminders, summary, consistency. Every output is a review-required draft — nothing is sent or recorded automatically." })}
<p class="sub"><a href="/app/projects/${pid}?workspaceId=${ws}">← Back to project</a> · <a href="/api/v1/workspaces/${ws}/projects/${pid}/ai/consistency">Consistency JSON →</a></p>
${card("1 · Contract/terms extraction", `<p class="sub">Paste agreement or scope text. Returns verbatim quotes for payment terms, milestones, deadlines, late-fee language, revision terms, and final-delivery conditions — missing fields are reported, never invented.</p><form class="form" data-api-form data-method="POST" action="/api/v1/workspaces/${ws}/projects/${pid}/ai/extract-terms"><div class="field"><label for="ai-terms">Pasted text</label><textarea id="ai-terms" name="sourceText" rows="5" maxlength="20000" required placeholder="Paste the agreement or scope text…"></textarea></div><div><button class="btn" type="submit">Extract terms</button> <span data-status class="stat-hint"></span></div></form>`)}
${card("2 · Communication extraction", `<p class="sub">Paste client messages. Flags approvals, revision requests, promised payment dates, payment-plan discussion, and acceptance — each with a verbatim quote. Recording still requires the normal flows.</p><form class="form" data-api-form data-method="POST" action="/api/v1/workspaces/${ws}/projects/${pid}/ai/extract-communications"><div class="field"><label for="ai-comms">Pasted messages</label><textarea id="ai-comms" name="sourceText" rows="5" maxlength="20000" required placeholder="Paste the client message…"></textarea></div><div><button class="btn" type="submit">Extract events</button> <span data-status class="stat-hint"></span></div></form>`)}
${card("3 · Reminder draft", `<p class="sub">Builds professional copy strictly from milestone + project facts (amounts/dates from records). Sending still goes through the manual reminder flow.</p><form class="form" data-api-form data-method="POST" action="/api/v1/workspaces/${ws}/projects/${pid}/ai/draft-reminder">${milestoneOptions}<div class="field"><label for="ai-tone">Tone</label><select id="ai-tone" name="tone"><option value="friendly">friendly</option><option value="firm">firm</option></select></div><div><button class="btn" type="submit">Draft reminder</button> <span data-status class="stat-hint"></span></div></form>`)}
${card("4 · Evidence summary", `<p class="sub">Restates the recorded event trail as dated bullets — a reading aid, never a verdict.</p><form class="form" data-api-form data-method="POST" action="/api/v1/workspaces/${ws}/projects/${pid}/ai/summarize"><div class="field"><label for="ai-max">Max events</label><input id="ai-max" name="maxEvents" inputmode="numeric" placeholder="50" /></div><div><button class="btn" type="submit">Summarize timeline</button> <span data-status class="stat-hint"></span></div></form>`)}
${card("5 · Agreement consistency", `<p class="sub">Compares the current agreement against live milestones and the project total (amount mismatches, missing due dates, missing final-delivery condition). Read-only.</p><p class="sub"><a href="/api/v1/workspaces/${ws}/projects/${pid}/ai/consistency">Run consistency check (JSON) →</a></p>`)}
${card("Safety rules", `<p class="sub">Drafts quote verbatim sources, never invent payments, never label anyone, never give legal advice, and never change financial records. Review every draft before sending or recording it. Informational workflow record. Not legal advice.</p>`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- Notification center: inbox + preferences + opt-outs ----
  app.get("/app/notifications", async (request, reply) => {
    const identity = await pageIdentity({ headers: request.headers, query: request.query }, deps);
    if (!identity) {
      return reply
        .status(401)
        .header("content-type", "text/html; charset=utf-8")
        .send(unauthenticatedPage());
    }
    const ws = escapeHtml(identity.workspaceId);
    const [rows, prefs, optOuts] = await Promise.all([
      deps.store.listWorkspaceNotifications(identity.workspaceId, 50),
      deps.store.getNotificationPreferences(identity.workspaceId, identity.userId),
      deps.store.listNotificationOptOuts(identity.workspaceId),
    ]);
    const prefByKey = new Map(prefs.map((p) => [`${p.category}:${p.channel}`, p.enabled] as const));
    const mine = rows.filter((r) => r.channel === "inapp" && r.recipient === identity.userId);
    const inbox =
      mine.length === 0
        ? emptyState(
            "All caught up",
            "Payment, approval, pause, plan and release notices will appear here.",
          )
        : `<div class="list">${mine
            .slice(0, 20)
            .map(
              (r) =>
                `<div class="row"><div class="row-title">${escapeHtml(r.subject ?? r.template)} ${statusPill(r.readAt ? "read" : "unread")}</div><div class="row-meta">${escapeHtml(r.category ?? r.trigger)} · ${escapeHtml(r.createdAt.toISOString().slice(0, 16).replace("T", " "))} UTC</div></div>`,
            )
            .join("")}</div>`;
    const categories = [
      "payments",
      "approvals",
      "reminders",
      "overdue",
      "pauses",
      "plans",
      "deliverables",
    ];
    const prefRows = categories
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c)}</td><td>${prefByKey.get(`${c}:email`) === false ? "off" : "on"}</td><td>${prefByKey.get(`${c}:inapp`) === false ? "off" : "on"}</td></tr>`,
      )
      .join("");
    const optOutRows =
      optOuts.length === 0
        ? `<p class="sub">No unsubscribed addresses. Every client email carries a manage-preferences link.</p>`
        : `<div class="list">${optOuts
            .map(
              (o) =>
                `<div class="row"><div class="row-title">${escapeHtml(o.email)}</div><div class="row-meta">unsubscribed: ${escapeHtml(o.category)}</div></div>`,
            )
            .join("")}</div>`;
    const html = layout({
      title: "Notifications",
      active: "projects",
      workspaceId: identity.workspaceId,
      body: `${pageHeader({ eyebrow: "Notification center", title: "Notifications", sub: "One reliable inbox for payments, approvals, overdue, pauses, plans and releases — email + in-app, with preferences and unsubscribe built in." })}
${card(
  "Set up reminders once",
  `<p class="sub">Reminders run per milestone from its due date. Default: friendly T-3, due-day, calm T+3 / T+7, then manual-only escalation. Tune at workspace level, override per project, preview with dry-run before scheduling.</p>${onboardingSteps(
    [
      { title: "Add a due date", body: "Every reminder anchors to it." },
      { title: "Preview the plan", body: "POST …/reminders/plan — no writes." },
      { title: "Schedule", body: "POST …/reminders/schedule — idempotent repeats." },
    ],
  )}${automationNote("Paid milestones stop automatically. Manual-only escalation never sends on its own.")}`,
)}
${card("Inbox (yours)", `${inbox}<p class="sub"><a href="/api/v1/workspaces/${ws}/notifications">Open as JSON →</a> Full delivery status per notice: queued / sent / failed with retries / canceled. Failed rows show what went wrong and what retry does — never a dead end.</p>`)}
${card("Your preferences", `<table class="table"><thead><tr><th>Category</th><th>Email</th><th>In-app</th></tr></thead><tbody>${prefRows}</tbody></table><p class="sub">Tune via <code>PUT /api/v1/workspaces/${ws}/notification-preferences</code> with [{category, channel, enabled}]. Disabling stops that mail for you only — the audit trail is preserved.</p>`)}
${card("Unsubscribed client addresses", `${optOutRows}<p class="sub">Manage via the opt-out API. Unsubscribed addresses never receive that category by email; your in-app notices continue.</p>`)}`,
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });
}
