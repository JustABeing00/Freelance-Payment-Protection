/**
 * Reusable UI components — Framer canvas edition.
 * Dark artboard (#090909), white display type with poster-grade negative
 * tracking, Inter body with OpenType character variants, white-pill CTAs,
 * charcoal cards, and 1–2 gradient spotlight tiles per page. Every page
 * composes these primitives — no duplicated markup. All styling lives in
 * /app/styles.css and all behaviour in /app/app.js so CSP
 * (styleSrc/scriptSrc 'self') holds with zero inline style/script.
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
<meta name="theme-color" content="#090909" />
<title>${escapeHtml(title)} — FreelancePaymentProtection</title>
<link rel="stylesheet" href="/app/styles.css" />
</head>
<body>
<a class="skip" href="#main-content">Skip to content</a>
<header class="topbar">
<div class="wrap topbar-inner">
<div class="brand"><span class="brand-dot" aria-hidden="true"></span>FreelancePaymentProtection</div>
<nav class="nav" aria-label="Workspace">
${nav("projects", `/app/projects?workspaceId=${ws}`, "Projects")}
${nav("clients", `/app/clients?workspaceId=${ws}`, "Clients")}
</nav>
</div>
</header>
<main class="wrap" id="main-content" tabindex="-1">${body}</main>
<footer class="wrap foot"><p class="foot-links"><span class="brand-mini">FreelancePaymentProtection</span> · Milestones · Approvals · Verified payments · Evidence</p><p>Informational workflow record. Not legal advice.</p></footer>
<script src="/app/app.js" defer></script>
</body>
</html>`;
}

export function pageHeader(args: { eyebrow: string; title: string; sub?: string }): string {
  return `<p class="eyebrow reveal">${escapeHtml(args.eyebrow)}</p>
<h1 class="h1 reveal" data-rv="1">${escapeHtml(args.title)}</h1>
${args.sub ? `<p class="sub reveal" data-rv="2">${escapeHtml(args.sub)}</p>` : ""}`;
}

export function statGrid(cards: string[]): string {
  return `<section class="stats">${cards.join("")}</section>`;
}

export function statCard(label: string, value: string, hint?: string): string {
  return `<div class="card stat reveal"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div>${hint ? `<div class="stat-hint">${escapeHtml(hint)}</div>` : ""}</div>`;
}

export function card(title: string, inner: string, aside?: string): string {
  return `<section class="card reveal"><div class="card-head"><h2>${escapeHtml(title)}</h2>${aside ?? ""}</div><div class="card-body">${inner}</div></section>`;
}

export function progressBar(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return `<progress class="progress" max="100" value="${p}" aria-label="${p}% collected">${p}%</progress>
<div class="stat-hint">${p}% collected</div>`;
}

export function emptyState(title: string, body: string, actionHtml?: string): string {
  // Empty states always answer: what is this, what do I do next, what happens
  // automatically. Optional actionHtml holds the next-step link/button.
  return `<div class="card reveal"><div class="card-body"><h2>${escapeHtml(title)}</h2><p class="sub">${escapeHtml(body)}</p>${actionHtml ? `<div class="empty-action">${actionHtml}</div>` : ""}</div></div>`;
}

export function errorState(title: string, body: string, nextStep: string): string {
  // Error states never blame: what happened, what it means for money, what to
  // do next. No alarming language.
  return `<div class="card reveal"><div class="card-body"><h2>${escapeHtml(title)}</h2><p class="sub">${escapeHtml(body)}</p><p class="sub"><strong>What to do next:</strong> ${escapeHtml(nextStep)}</p></div></div>`;
}

export function onboardingSteps(steps: { title: string; body: string }[]): string {
  // Numbered checklist for first-run onboarding: each step names one action
  // and what happens automatically afterwards.
  const items = steps
    .map(
      (s, i) =>
        `<li class="step reveal" data-rv="${String(i % 4)}"><span class="step-n" aria-hidden="true">${i + 1}</span><span><strong>${escapeHtml(s.title)}</strong><br /><span class="stat-hint">${escapeHtml(s.body)}</span></span></li>`,
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
      (m, i) =>
        `<div class="money-cell${m.tone ? ` money-${m.tone}` : ""} reveal" data-rv="${String(i % 4)}"><div class="stat-label">${escapeHtml(m.label)}</div><div class="stat-value">${m.value}</div>${m.hint ? `<div class="stat-hint">${escapeHtml(m.hint)}</div>` : ""}</div>`,
    )
    .join("");
  return `<section class="moneyband" aria-label="Money summary">${cells}</section>`;
}

export function automationNote(text: string): string {
  // Answers "what happens automatically" wherever money or approvals appear.
  return `<p class="automation reveal"><span class="automation-label">Automatic</span> ${escapeHtml(text)}</p>`;
}

export function rowTable(rows: string[]): string {
  return `<div class="table-scroll"><table class="table"><tbody>${rows.join("")}</tbody></table></div>`;
}

export function kv(key: string, value: string): string {
  return `<tr><th scope="row">${escapeHtml(key)}</th><td>${value}</td></tr>`;
}

export function unauthenticatedPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="Sign in to FreelancePaymentProtection to open your workspace." />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#090909" />
<title>Sign in — FreelancePaymentProtection</title><link rel="stylesheet" href="/app/styles.css" /></head>
<body><a class="skip" href="#main-content">Skip to content</a><main class="wrap narrow" id="main-content" tabindex="-1"><div class="spot spot-violet reveal"><p class="spot-kicker">Sign in</p><p class="spot-title">Your workspace is waiting.</p></div><div class="card"><div class="card-body">
<h1 class="h1">Sign in to continue</h1>
<p class="sub">These pages read your workspace over the same session you use for the API. Sign in first, then come back.</p>
<p class="btn-row"><a class="btn" href="/signin">Sign in →</a><a class="btn secondary" href="/signup">Create an account →</a></p>
<p class="sub">Your projects, money and timeline are unchanged — this is only the sign-in step.</p>
</div></div></main><script src="/app/app.js" defer></script></body></html>`;
}

export const APP_CSS = `
:root{
--canvas:#090909;--surface-1:#141414;--surface-2:#1c1c1c;
--hairline:#262626;--hairline-soft:#1a1a1a;
--ink:#ffffff;--muted:#999999;
--primary:#ffffff;--on-primary:#000000;--accent:#0099ff;
--magenta:#d44df0;--violet:#6a4cf5;--orange:#ff7a3d;--coral:#ff5577;
--success:#22c55e;--warn:#e8a33d;--danger:#ff7070;
--ok-soft:rgba(34,197,94,.13);--warn-soft:rgba(232,163,61,.13);
--danger-soft:rgba(255,112,112,.13);--info-soft:rgba(0,153,255,.13);
--muted-soft:rgba(153,153,153,.13);
--display:"GT Walsheim Medium","GT Walsheim Framer Medium","Mona Sans","Geist",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
--body:"Inter Variable",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
--r-xs:4px;--r-sm:6px;--r-md:10px;--r-lg:15px;--r-xl:20px;--r-xxl:30px;--r-pill:100px;--r-full:9999px;
--rv-d:0ms;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--canvas);color:var(--ink);font-family:var(--body);font-size:15px;font-weight:400;line-height:1.3;letter-spacing:-.15px;font-feature-settings:"cv01","cv05","cv09","cv11","ss03","ss07","dlig";font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:rgba(0,153,255,.38);color:#fff}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:var(--canvas)}::-webkit-scrollbar-thumb{background:#2c2c2c;border-radius:99px;border:2px solid var(--canvas)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1200px;margin:0 auto;padding:0 30px}.wrap.narrow{max-width:640px;padding-top:64px}
.topbar{position:sticky;top:0;z-index:50;background:rgba(9,9,9,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--hairline-soft)}
.topbar-inner{display:flex;align-items:center;justify-content:space-between;min-height:56px;padding-top:8px;padding-bottom:8px;gap:12px}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--display);font-weight:500;font-size:15px;letter-spacing:-.3px;color:var(--ink);white-space:nowrap}
.brand-dot{width:10px;height:10px;border-radius:var(--r-full);background:linear-gradient(135deg,var(--violet),var(--magenta) 60%,var(--orange));flex:none;box-shadow:0 0 18px rgba(212,77,240,.55)}
.brand-mini{color:var(--ink);font-weight:500}
.brand-link{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:10px}.brand-link:hover{text-decoration:none}
.nav{display:flex;gap:4px;align-items:center;overflow-x:auto;scrollbar-width:none}.nav::-webkit-scrollbar{display:none}
.navlink{padding:8px 14px;border-radius:var(--r-pill);color:var(--muted);text-decoration:none;font-size:14px;font-weight:500;letter-spacing:-.14px;white-space:nowrap;min-height:40px;display:inline-flex;align-items:center}.navlink:hover{color:var(--ink);text-decoration:none;background:var(--surface-1)}.navlink.is-active{background:var(--surface-2);color:var(--ink)}
.navlink.nav-cta{background:var(--primary);color:var(--on-primary)}.navlink.nav-cta:hover{background:#e8e8e8;color:var(--on-primary)}
main.wrap{padding-top:28px;padding-bottom:96px}
.hero{padding:96px 0 40px;max-width:960px}.hero-tight{padding:64px 0 24px}
.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:13px;font-weight:500;color:var(--muted);margin:0 0 12px}
.h1{font-family:var(--display);font-weight:500;font-size:32px;line-height:1.13;letter-spacing:-1px;margin:0 0 12px;color:var(--ink);text-wrap:balance}
.hero-display{font-family:var(--display);font-weight:500;font-size:clamp(40px,7vw,85px);line-height:.95;letter-spacing:-.05em;margin:0 0 20px;color:var(--ink);text-wrap:balance;font-feature-settings:"ss02"}
.hero-sub{font-size:18px;line-height:1.3;letter-spacing:-.18px;color:var(--muted);max-width:60ch;margin:0 0 28px;font-feature-settings:"cv11"}
.sub{color:var(--muted);margin:6px 0 18px;max-width:68ch;font-size:15px}
.hero-ctas,.btn-row{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}
.card{background:var(--surface-1);border:1px solid var(--hairline-soft);border-radius:var(--r-xl);margin:0 0 14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:20px 24px 0}.card-head h2{font-family:var(--display);font-weight:500;font-size:18px;letter-spacing:-.4px;margin:0}
.card-body{padding:12px 24px 24px}.card-body h2{font-family:var(--display);font-size:20px;font-weight:500;letter-spacing:-.5px;margin:6px 0 8px}
.stat{margin:0;padding:20px 24px}.stat-label{font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}.stat-value{font-family:var(--display);font-size:28px;font-weight:500;letter-spacing:-.6px;margin-top:6px}.stat-hint{font-size:13px;font-weight:500;color:var(--muted);margin-top:6px;letter-spacing:-.13px}
.nextaction{background:var(--surface-2);border:1px solid var(--hairline);border-radius:12px;padding:12px 14px;margin-top:4px;font-size:14px}
.moneyband{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:20px 0;background:var(--surface-1);border:1px solid var(--hairline-soft);border-radius:var(--r-xl);padding:24px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 10px 30px rgba(0,0,0,.25)}
.money-cell{border-left:3px solid var(--hairline);padding-left:14px}.money-ok{border-color:var(--success)}.money-warn{border-color:var(--warn)}.money-info{border-color:var(--accent)}
.automation{display:flex;gap:10px;align-items:baseline;background:var(--info-soft);border:1px solid rgba(0,153,255,.22);border-radius:10px;padding:10px 14px;font-size:13px;color:var(--ink)}
.automation-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:1px 8px;white-space:nowrap}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:10px}.step{display:flex;gap:12px;align-items:flex-start;background:var(--surface-1);border:1px solid var(--hairline-soft);border-radius:12px;padding:14px 16px}.step-n{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:999px;background:var(--surface-2);color:var(--ink);font-weight:500;font-size:13px;flex:none}
.empty-action{margin-top:8px}
.spot-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0}
.spot{position:relative;overflow:hidden;border-radius:var(--r-xxl);padding:32px;color:#fff;min-height:220px;display:flex;flex-direction:column;justify-content:flex-end;gap:8px;isolation:isolate}
.spot::before{content:"";position:absolute;inset:0;background:radial-gradient(90% 90% at 20% 0%,rgba(255,255,255,.28),rgba(255,255,255,0) 55%);z-index:-1}
.spot::after{content:"";position:absolute;width:340px;height:340px;border-radius:50%;background:rgba(255,255,255,.14);filter:blur(70px);top:-120px;right:-100px;z-index:-1}
.spot-violet{background:linear-gradient(140deg,#8b5cf6 0%,var(--violet) 42%,#241257 100%)}
.spot-magenta{background:linear-gradient(140deg,#f5a3ff 0%,var(--magenta) 45%,#4d0d59 100%)}
.spot-orange{background:linear-gradient(140deg,#ffc89b 0%,var(--orange) 48%,#6b2408 100%)}
.spot-coral{background:linear-gradient(140deg,#ffb3c1 0%,var(--coral) 48%,#5f1224 100%)}
.spot-kicker{font-size:13px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;opacity:.85;margin:0}
.spot-title{font-family:var(--display);font-size:24px;font-weight:500;letter-spacing:-.5px;line-height:1.15;margin:0;text-wrap:balance}
.spot-body{font-size:15px;line-height:1.35;opacity:.92;margin:0;max-width:44ch}
.table-scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}
.table{width:100%;min-width:560px;border-collapse:collapse;font-size:14px}.table th,.table td{text-align:left;padding:12px 10px;border-top:1px solid var(--hairline-soft);vertical-align:top}.table tr:first-child th,.table tr:first-child td{border-top:0}.table th{color:var(--muted);font-weight:500;width:200px;font-size:14px;letter-spacing:-.14px}
.list{display:grid;gap:10px}.row{background:var(--surface-1);border:1px solid var(--hairline-soft);border-radius:12px;padding:14px 16px;text-decoration:none;color:inherit;display:block;transition:border-color .2s ease,transform .2s ease,background .2s ease}.row:hover{border-color:var(--hairline);background:var(--surface-2);text-decoration:none;transform:translateY(-1px)}.row-title{font-weight:500;color:var(--ink)}.row-meta{color:var(--muted);font-size:13px;margin-top:2px}
.pill{display:inline-block;font-size:12px;font-weight:500;letter-spacing:-.12px;padding:3px 10px;border-radius:999px;border:1px solid transparent;white-space:nowrap}.pill-ok{background:var(--ok-soft);color:var(--success)}.pill-warn{background:var(--warn-soft);color:var(--warn)}.pill-muted{background:var(--muted-soft);color:var(--muted)}.pill-info{background:var(--info-soft);color:var(--accent)}.pill-danger{background:var(--danger-soft);color:var(--danger)}
progress.progress{width:100%;height:8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--hairline-soft);overflow:hidden;-webkit-appearance:none;appearance:none}
progress.progress::-webkit-progress-bar{background:var(--surface-2);border-radius:999px}
progress.progress::-webkit-progress-value{background:linear-gradient(90deg,#fff,#c9b8ff);border-radius:999px}
progress.progress::-moz-progress-bar{background:#fff;border-radius:999px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form{display:grid;gap:12px;max-width:560px}.field{display:grid;gap:6px}.field label{font-size:13px;font-weight:500;color:var(--ink)}
.field input,.field select,.field textarea{border:1px solid var(--hairline);border-radius:var(--r-md);padding:10px 14px;font:inherit;background:var(--surface-1);color:var(--ink);font-feature-settings:"cv11"}
.field input::placeholder,.field textarea::placeholder{color:#6b6b6b}
.field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 1px rgba(0,153,255,.15),0 0 0 4px rgba(0,153,255,.12)}
.btn{background:var(--primary);color:var(--on-primary);border:0;border-radius:var(--r-pill);padding:10px 15px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;font-family:var(--body);font-size:14px;font-weight:500;letter-spacing:-.14px;cursor:pointer;text-decoration:none;transition:transform .15s ease,background .2s ease,box-shadow .2s ease;white-space:nowrap}
.btn:hover{background:#e8e8e8;text-decoration:none;box-shadow:0 6px 24px rgba(255,255,255,.12)}
.btn:active{transform:scale(.97)}
.btn.secondary{background:var(--surface-1);color:var(--ink);border:1px solid var(--hairline)}.btn.secondary:hover{background:var(--surface-2)}
.btn-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.timeline{list-style:none;margin:0;padding:0;display:grid;gap:10px}.timeline li{display:flex;gap:10px;align-items:baseline;font-size:14px}.timeline time{color:var(--muted);font-size:12px;white-space:nowrap}
details{border:1px solid var(--hairline-soft);border-radius:var(--r-md);padding:12px 14px;background:var(--surface-1)}
details summary{cursor:pointer;font-weight:500;color:var(--ink)}
.terms-pre{white-space:pre-wrap;font:inherit;background:var(--surface-2);border:1px solid var(--hairline-soft);border-radius:var(--r-md);padding:14px;overflow-x:auto}
.stack-gap{height:8px}
.foot{color:var(--muted);font-size:13px;font-weight:500;letter-spacing:-.13px;padding:64px 30px 40px;border-top:1px solid var(--hairline-soft);margin-top:64px}
.foot-links{margin:0 0 8px}.foot p{margin:6px 0}.foot a{color:var(--muted)}.foot a:hover{color:var(--ink)}
.skip{position:absolute;left:-9999px;top:0;background:var(--primary);color:var(--on-primary);padding:10px 18px;border-radius:0 0 12px 0;z-index:100;font-weight:500}.skip:focus{left:0}
code{background:var(--surface-2);border:1px solid var(--hairline-soft);padding:1px 6px;border-radius:6px;font-size:13px;color:var(--ink)}
html.js .reveal{opacity:0;transform:translateY(20px);filter:blur(6px);transition:opacity .7s ease,transform .7s cubic-bezier(.22,1,.36,1),filter .7s ease;transition-delay:var(--rv-d,0ms);will-change:opacity,transform,filter}
html.js .reveal.is-visible{opacity:1;transform:none;filter:none}
.reveal[data-rv="1"]{--rv-d:90ms}.reveal[data-rv="2"]{--rv-d:180ms}.reveal[data-rv="3"]{--rv-d:270ms}.reveal[data-rv="0"]{--rv-d:0ms}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}html.js .reveal{opacity:1;transform:none;filter:none;transition:none}}
@media(max-width:810px){.wrap{padding-left:20px;padding-right:20px}.spot-grid{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}.moneyband{grid-template-columns:1fr}.table th{width:130px}.hero{padding:64px 0 28px}.topbar-inner{gap:8px}.brand{font-size:13px}}
@media(max-width:1199px){.wrap{max-width:100%}}
@media print{
body{background:#fff;color:#000;font-feature-settings:normal}
.topbar,.skip,.hero-ctas,.btn-row,.btn,.nav,.foot,.spot-grid,.spot{display:none}
.wrap{max-width:100%;padding:0}
.card,.moneyband,.row,.step,.automation,details{background:#fff;border-color:#bbb;color:#000;box-shadow:none}
.h1,.stat-value,.card-head h2,.card-body h2,.row-title{color:#000}
.sub,.stat-hint,.stat-label,.row-meta,.table th{color:#333}
a{color:#000;text-decoration:underline}
code{background:#eee;border-color:#ccc;color:#000}
}`;

export const APP_JS = `// Workspace page interactions: progressive enhancement for create/edit
// forms (POST/PATCH as JSON with same-origin session cookies) plus
// Framer-style scroll reveal. No framework, no tracking.
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
    } else if (form && form.hasAttribute("data-auth")) {
      e.preventDefault();
      submitAuth(form);
    }
  });
  async function submitAuth(form) {
    // Browser signup/signin: the JSON API sets the session cookie; the page
    // only reads the JSON body to decide where to land next.
    const status = form.querySelector("[data-status]");
    try {
      if (status) status.textContent = "Working…";
      const data = {};
      new FormData(form).forEach((v, k) => {
        data[k] = String(v);
      });
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body && body.error && body.error.message) || ("Request failed (" + res.status + ")"));
      if (form.getAttribute("data-auth") === "signup") {
        const ws = body && body.workspace && body.workspace.id;
        if (!ws) throw new Error("Account created, but no workspace came back. Open Get started to continue.");
        if (status) status.textContent = "Account created. Opening your workspace…";
        window.location.assign("/app/projects?workspaceId=" + encodeURIComponent(ws));
      } else {
        if (status) status.textContent = "Signed in. Opening your workspace…";
        const list = await fetch("/api/v1/workspaces", { credentials: "same-origin" });
        const lj = await list.json().catch(() => ({}));
        const first = lj && lj.workspaces && lj.workspaces[0] && lj.workspaces[0].id;
        window.location.assign(first ? ("/app/projects?workspaceId=" + encodeURIComponent(first)) : "/app/onboarding");
      }
    } catch (err) {
      if (status) status.textContent = String((err && err.message) || err);
    }
    return false;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initReveal);
  } else {
    initReveal();
  }
})();
`;
