/**
 * Reusable UI components (Session 04).
 * Calm + professional: warm paper background, ink text, one sage accent,
 * generous whitespace. No gradients, no dashboard chrome. Every page
 * composes these primitives — no duplicated markup.
 */

export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

export function statusPill(status: string): string {
  // Calm operations palette: overdue is amber (needs a calm follow-up), never
  // red. Disputed/rejected read as "needs discussion" blue. Red is reserved
  // for genuine system failures (failed delivery), never for people.
  const s = escapeHtml(status.replace(/_/g, " "));
  const ok = new Set([
    "paid",
    "active",
    "completed",
    "accepted",
    "released",
    "approved",
    "read",
    "sent",
    "delivered",
    "settled",
    "transferred",
  ]);
  const warn = new Set(["overdue", "needs attention", "needs_attention", "due"]);
  const danger = new Set(["failed", "failed_retry_scheduled", "failed_exhausted"]);
  const muted = new Set([
    "draft",
    "on_hold",
    "unpaid",
    "locked",
    "archived",
    "inactive",
    "canceled",
  ]);
  const tone = ok.has(status)
    ? "ok"
    : warn.has(status)
      ? "warn"
      : danger.has(status)
        ? "danger"
        : muted.has(status)
          ? "muted"
          : "info";
  return `<span class="pill pill-${tone}">${s}</span>`;
}

export function layout(args: {
  title: string;
  active: "projects" | "clients" | "home";
  workspaceId: string;
  body: string;
}): string {
  const { title, active, workspaceId, body } = args;
  const ws = escapeHtml(workspaceId);
  const nav = (key: string, href: string, label: string): string =>
    `<a class="navlink${active === key ? " is-active" : ""}" href="${href}">${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="FreelancePaymentProtection workspace — milestones, approvals, verified payments and evidence for one project at a time." />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)} — FreelancePaymentProtection</title>
<link rel="stylesheet" href="/app/styles.css" />
</head>
<body>
<a class="skip" href="#main-content">Skip to content</a>
<header class="topbar">
<div class="wrap topbar-inner">
<div class="brand">FreelancePaymentProtection</div>
<nav class="nav" aria-label="Workspace">
${nav("projects", `/app/projects?workspaceId=${ws}`, "Projects")}
${nav("clients", `/app/clients?workspaceId=${ws}`, "Clients")}
</nav>
</div>
</header>
<main class="wrap" id="main-content" tabindex="-1">${body}</main>
<footer class="wrap foot">Informational workflow record. Not legal advice.</footer>
<script src="/app/app.js" defer></script>
</body>
</html>`;
}

export function pageHeader(args: { eyebrow: string; title: string; sub?: string }): string {
  return `<p class="eyebrow">${escapeHtml(args.eyebrow)}</p>
<h1 class="h1">${escapeHtml(args.title)}</h1>
${args.sub ? `<p class="sub">${escapeHtml(args.sub)}</p>` : ""}`;
}

export function statGrid(cards: string[]): string {
  return `<section class="stats">${cards.join("")}</section>`;
}

export function statCard(label: string, value: string, hint?: string): string {
  return `<div class="card stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div>${hint ? `<div class="stat-hint">${escapeHtml(hint)}</div>` : ""}</div>`;
}

export function card(title: string, inner: string, aside?: string): string {
  return `<section class="card"><div class="card-head"><h2>${escapeHtml(title)}</h2>${aside ?? ""}</div><div class="card-body">${inner}</div></section>`;
}

export function progressBar(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return `<div class="progress" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${p}%"></div></div>
<div class="stat-hint">${p}% collected</div>`;
}

export function emptyState(title: string, body: string, actionHtml?: string): string {
  // Empty states always answer: what is this, what do I do next, what happens
  // automatically. Optional actionHtml holds the next-step link/button.
  return `<div class="card"><div class="card-body"><h2>${escapeHtml(title)}</h2><p class="sub">${escapeHtml(body)}</p>${actionHtml ? `<div class="empty-action">${actionHtml}</div>` : ""}</div></div>`;
}

export function errorState(title: string, body: string, nextStep: string): string {
  // Error states never blame: what happened, what it means for money, what to
  // do next. No alarming language.
  return `<div class="card"><div class="card-body"><h2>${escapeHtml(title)}</h2><p class="sub">${escapeHtml(body)}</p><p class="sub"><strong>What to do next:</strong> ${escapeHtml(nextStep)}</p></div></div>`;
}

export function onboardingSteps(steps: { title: string; body: string }[]): string {
  // Numbered checklist for first-run onboarding: each step names one action
  // and what happens automatically afterwards.
  const items = steps
    .map(
      (s, i) =>
        `<li class="step"><span class="step-n" aria-hidden="true">${i + 1}</span><span><strong>${escapeHtml(s.title)}</strong><br /><span class="stat-hint">${escapeHtml(s.body)}</span></span></li>`,
    )
    .join("");
  return `<ol class="steps">${items}</ol>`;
}

export function moneyBand(
  items: { label: string; value: string; hint?: string; tone?: "ok" | "warn" | "info" }[],
): string {
  // Top-of-page money hierarchy: what is safe, what is owed, what is next.
  // Verified receipts only — claims never appear here.
  const cells = items
    .map(
      (m) =>
        `<div class="money-cell${m.tone ? ` money-${m.tone}` : ""}"><div class="stat-label">${escapeHtml(m.label)}</div><div class="stat-value">${m.value}</div>${m.hint ? `<div class="stat-hint">${escapeHtml(m.hint)}</div>` : ""}</div>`,
    )
    .join("");
  return `<section class="moneyband" aria-label="Money summary">${cells}</section>`;
}

export function automationNote(text: string): string {
  // Answers "what happens automatically" wherever money or approvals appear.
  return `<p class="automation"><span class="automation-label">Automatic</span> ${escapeHtml(text)}</p>`;
}

export function rowTable(rows: string[]): string {
  return `<table class="table"><tbody>${rows.join("")}</tbody></table>`;
}

export function kv(key: string, value: string): string {
  return `<tr><th scope="row">${escapeHtml(key)}</th><td>${value}</td></tr>`;
}

export function unauthenticatedPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="Sign in to FreelancePaymentProtection to open your workspace." />
<meta name="robots" content="noindex, nofollow" />
<title>Sign in — FreelancePaymentProtection</title><link rel="stylesheet" href="/app/styles.css" /></head>
<body><a class="skip" href="#main-content">Skip to content</a><main class="wrap narrow" id="main-content" tabindex="-1"><div class="card"><div class="card-body">
<h1 class="h1">Sign in to continue</h1>
<p class="sub">These pages read your workspace over the same session you use for the API. Sign in first, then come back.</p>
<p class="sub"><strong>What to do next:</strong> <code>POST /api/v1/auth/signin</code> with email + password, or open with a <code>Bearer</code> session token. Your projects, money and timeline are unchanged — this is only the sign-in step.</p>
</div></div></main></body></html>`;
}

export const APP_CSS = `:root{--paper:#faf9f7;--card:#fff;--ink:#22201b;--muted:#6f6a60;--line:#e7e2d9;--sage:#51644f;--sage-soft:#edf1ea;--amber:#8a5a17;--amber-soft:#faf0dc;--red:#8c2f22;--red-soft:#f9e8e4;--blue:#2f4a6b;--blue-soft:#e8eef6}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
.wrap{max-width:1020px;margin:0 auto;padding:0 20px}.wrap.narrow{max-width:640px;padding-top:64px}
.topbar{background:var(--card);border-bottom:1px solid var(--line)}.topbar-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 20px}
.brand{font-weight:650;letter-spacing:.1px}.nav{display:flex;gap:6px}.navlink{padding:8px 12px;border-radius:999px;color:var(--muted);text-decoration:none}.navlink.is-active{background:var(--sage-soft);color:var(--ink)}
main.wrap{padding-top:28px;padding-bottom:48px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:var(--muted);margin:0 0 6px}.h1{font-size:30px;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}.sub{color:var(--muted);margin:6px 0 18px;max-width:68ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:0 0 14px}.card-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 0}.card-head h2{font-size:15px;margin:0}.card-body{padding:12px 18px 18px}.stat{margin:0;padding:16px 18px}.stat-label{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}.stat-value{font-size:24px;font-weight:650;margin-top:4px}.stat-hint{font-size:13px;color:var(--muted);margin-top:4px}
.nextaction{background:var(--sage-soft);border:1px solid #d8e0d4;border-radius:12px;padding:12px 14px;margin-top:4px}
.moneyband{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:18px 0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.money-cell{border-left:3px solid var(--line);padding-left:12px}.money-ok{border-color:#9db89a}.money-warn{border-color:#d9b26a}.money-info{border-color:#9fb4cc}
.automation{display:flex;gap:8px;align-items:baseline;background:var(--blue-soft);border-radius:10px;padding:8px 12px;font-size:13px;color:var(--blue)}.automation-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border:1px solid currentColor;border-radius:999px;padding:1px 8px;white-space:nowrap}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:10px}.step{display:flex;gap:12px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.step-n{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:999px;background:var(--sage-soft);color:var(--ink);font-weight:700;font-size:13px;flex:none}
.empty-action{margin-top:6px}
.table{width:100%;border-collapse:collapse;font-size:14px}.table th,.table td{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}.table tr:first-child th,.table tr:first-child td{border-top:0}.table th{color:var(--muted);font-weight:600;width:200px}
.list{display:grid;gap:10px}.row{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;text-decoration:none;color:inherit;display:block}.row:hover{border-color:#c9c2b2}.row-title{font-weight:650}.row-meta{color:var(--muted);font-size:13px;margin-top:2px}
.pill{display:inline-block;font-size:12px;font-weight:650;padding:2px 10px;border-radius:999px;border:1px solid transparent}.pill-ok{background:#e9f2e7;color:#2f5230}.pill-warn{background:var(--amber-soft);color:var(--amber)}.pill-muted{background:#f1ede6;color:var(--muted)}.pill-info{background:#e8eef6;color:#2f4a6b}.pill-danger{background:var(--red-soft);color:var(--red)}
.progress{height:8px;border-radius:999px;background:#efe9dd;overflow:hidden}.progress-fill{height:100%;background:var(--sage);border-radius:999px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:760px){.grid2{grid-template-columns:1fr}.moneyband{grid-template-columns:1fr}.table th{width:130px}}
.form{display:grid;gap:10px;max-width:560px}.field{display:grid;gap:4px}.field label{font-size:13px;font-weight:600}.field input,.field select,.field textarea{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit;background:#fff}.btn{background:var(--sage);color:#fff;border:0;border-radius:999px;padding:10px 18px;font:inherit;font-weight:650;cursor:pointer}.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--sage);outline-offset:2px}
.timeline{list-style:none;margin:0;padding:0;display:grid;gap:8px}.timeline li{display:flex;gap:10px;align-items:baseline;font-size:14px}.timeline time{color:var(--muted);font-size:12px;white-space:nowrap}
details summary{cursor:pointer;font-weight:600}
.foot{color:var(--muted);font-size:12px;padding-bottom:32px}
.skip{position:absolute;left:-9999px;top:0;background:var(--sage);color:#fff;padding:10px 18px;border-radius:0 0 12px 0;z-index:10}.skip:focus{left:0}
code{background:#f1ede6;padding:1px 6px;border-radius:6px;font-size:13px}`;

export const APP_JS = `// Session 04 page interactions: progressive enhancement for create/edit forms.
// Pages render server-side; this file only handles form POST/PATCH as JSON
// with same-origin session cookies. No framework, no tracking.
(function () {
  async function submitForm(form) {
    const status = form.querySelector("[data-status]");
    try {
      if (status) status.textContent = "Saving…";
      const data = {};
      new FormData(form).forEach((v, k) => {
        const s = String(v).trim();
        if (s === "") return; // leave unset so PATCH keeps prior value
        data[k] = s;
      });
      // Coerce known numerics.
      if (data.totalValueCents !== undefined) data.totalValueCents = Number(data.totalValueCents);
      const res = await fetch(form.action, {
        method: form.dataset.method || "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body && body.error && body.error.message) || ("Request failed (" + res.status + ")"));
      if (status) status.textContent = "Saved.";
      const next = form.dataset.redirect;
      if (next) window.location.assign(next);
      else window.location.reload();
    } catch (err) {
      if (status) status.textContent = String((err && err.message) || err);
    }
    return false;
  }
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (form && form.hasAttribute("data-api-form")) {
      e.preventDefault();
      submitForm(form);
    }
  });
})();
`;
