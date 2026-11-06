// popup.js - ClearSign v14

// ===== CENTRAL STATE =====
const State = {
  analysis: null,
  scanStatus: null,
  onboardingDone: false,
  activeTab: "risks",   // "risks" | "chat" | "optout"
  chatHistory: [],      // [{role, text}]
  chatLoading: false,
  optoutStep: "select", // "select" | "draft" | "done"
  optoutType: null,

  set(patch) {
    Object.assign(this, patch);
    render();
  }
};

// ===== BOOTSTRAP =====
document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["analysis", "onboardingDone"], result => {
    State.analysis = result.analysis || null;
    State.onboardingDone = !!result.onboardingDone;
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.analysis) {
      State.analysis = changes.analysis.newValue || null;
      if (State.scanStatus === "scanning") State.scanStatus = null;
      render();
    }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "ANALYSIS_PROGRESS" && State.scanStatus === "scanning") {
      const el = document.getElementById("scanStatus");
      if (el) el.textContent = msg.step;
    }
  });

  document.getElementById("refreshBtn")?.addEventListener("click", onRefresh);
  document.getElementById("exportBtn")?.addEventListener("click", exportReport);
  document.getElementById("clearBtn")?.addEventListener("click", onClear);

  document.addEventListener("click", e => {
    if (!e.target.closest(".risk-card"))
      document.querySelectorAll(".risk-card.open").forEach(c => c.classList.remove("open"));
  });
});

// ===== RENDER =====
function render() {
  const content  = document.getElementById("content");
  const metaBar  = document.getElementById("metaBar");
  const scoreNum = document.getElementById("scoreNum");
  const ringFill = document.getElementById("ringFill");
  const tabBar   = document.getElementById("tabBar");
  if (!content) return;

  const setRing = (score, color) => {
    const CIRC = 138.2;
    const pct = score === null ? 0 : score / 10;
    ringFill.style.strokeDashoffset = (CIRC * (1 - pct)).toFixed(2);
    ringFill.style.stroke = color;
    scoreNum.textContent = score === null ? "—" : score + "/10";
  };

  if (State.scanStatus === "scanning") {
    setRing(null, "#E24B4A");
    metaBar.style.display = "none";
    if (tabBar) tabBar.style.display = "none";
    content.innerHTML = buildSkeleton("Scanning...");
    return;
  }

  const a = State.analysis;

  if (!a || a.score === undefined) {
    setRing(null, "#E24B4A");
    metaBar.style.display = "none";
    if (tabBar) tabBar.style.display = "none";
    let html = "";
    if (!State.onboardingDone) html += buildOnboarding();
    html += `<div class="empty-state">
      <span class="empty-icon">📄</span>
      <strong>No analysis yet</strong><br>
      Navigate to any Terms &amp; Conditions or Privacy Policy page,<br>
      then click <strong style="color:#E24B4A">🔍 Analyze T&amp;C</strong>.
    </div>`;
    content.innerHTML = html;
    wireOnboarding();
    return;
  }

  // Score ring
  const score = a.score;
  const ringColor = score >= 7 ? "#e53935" : score >= 4 ? "#f57c00" : "#27ae60";
  setRing(score, ringColor);

  // Meta bar
  const metaParts = [];
  if (a.timestamp) metaParts.push(`<span class="chip">🕒 ${timeAgo(a.timestamp)}</span>`);
  if (typeof a.linksScanned === "number" && a.linksScanned > 0)
    metaParts.push(`<span class="chip">🔗 ${a.linksScanned} linked polic${a.linksScanned===1?"y":"ies"}</span>`);
  if (a.scanDuration) metaParts.push(`<span class="chip">⚡ ${a.scanDuration}s</span>`);
  metaBar.innerHTML = metaParts.join("");
  metaBar.style.display = metaParts.length ? "flex" : "none";

  // Tab bar — show when we have results
  if (tabBar) {
    tabBar.style.display = "flex";
    tabBar.innerHTML = `
      <button class="tab-btn ${State.activeTab==="risks"?"active":""}" data-tab="risks">⚠️ Risks</button>
      <button class="tab-btn ${State.activeTab==="optout"?"active":""}" data-tab="optout">✉️ Opt-Out</button>
      <button class="tab-btn ${State.activeTab==="chat"?"active":""}" data-tab="chat">🤖 Policy Agent</button>
    `;
    tabBar.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        State.activeTab = btn.dataset.tab;
        render();
      });
    });
  }

  let html = "";
  if (!State.onboardingDone) html += buildOnboarding();

  if (State.activeTab === "risks") {
    html += buildRisksTab(a);
  } else if (State.activeTab === "optout") {
    html += buildOptOutTab(a);
  } else if (State.activeTab === "chat") {
    html += buildChatTab();
  }

  content.innerHTML = html;
  wireOnboarding();

  if (State.activeTab === "risks") {
    content.querySelectorAll(".risk-card").forEach(card => {
      card.addEventListener("click", e => {
        const wasOpen = card.classList.contains("open");
        document.querySelectorAll(".risk-card.open").forEach(c => c.classList.remove("open"));
        if (!wasOpen) card.classList.add("open");
        e.stopPropagation();
      });
    });
    content.querySelectorAll(".community-link[data-href]").forEach(a => {
      a.addEventListener("click", e => { e.preventDefault(); chrome.tabs.create({ url: a.dataset.href }); });
    });
  }

  if (State.activeTab === "optout") {
    wireOptOut(a);
  }

  if (State.activeTab === "chat") {
    wireChat();
  }
}

// ===== RISKS TAB (original content) =====
function buildRisksTab(a) {
  let html = "";

  // Domain safety banner (Google Safe Browsing + heuristic result)
  if (a.domainSafety?.checked) {
    if (!a.domainSafety.safe && !a.domainSafety.gsbSafe) {
      // Hard GSB flag
      const threat = a.domainSafety.threatType || "THREAT";
      const label = {
        MALWARE: "Malware",
        SOCIAL_ENGINEERING: "Phishing / Social Engineering",
        UNWANTED_SOFTWARE: "Unwanted Software",
        POTENTIALLY_HARMFUL_APPLICATION: "Potentially Harmful App"
      }[threat] || threat;
      html += `<div style="background:#fde8e8;border:1.5px solid #e53935;border-radius:10px;padding:10px 13px;margin-bottom:12px;display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#b71c1c;line-height:1.5;">
        <span style="font-size:18px;flex-shrink:0">🚨</span>
        <span><strong>Google Safe Browsing Warning:</strong> This domain is flagged as <strong>${esc(label)}</strong>. Avoid entering personal information or agreeing to anything on this site.</span>
      </div>`;
    } else if (a.domainSafety.suspicious && a.domainSafety.suspiciousReasons?.length) {
      // Heuristic suspicious — GSB hasn't caught it yet (likely new site)
      const reasonsList = a.domainSafety.suspiciousReasons.map(r => `<li>${esc(r)}</li>`).join("");
      html += `<div style="background:#fff8e1;border:1.5px solid #f59e0b;border-radius:10px;padding:10px 13px;margin-bottom:12px;display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#92400e;line-height:1.5;">
        <span style="font-size:18px;flex-shrink:0">⚠️</span>
        <span>
          <strong>Suspicious Domain Detected</strong> — Google Safe Browsing has no record (site may be too new to be flagged yet).<br>
          <ul style="margin:5px 0 0 0;padding-left:16px;">${reasonsList}</ul>
          Do not enter personal or payment information on this site.
        </span>
      </div>`;
    } else if (a.domainSafety.trusted) {
      html += `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:8px 13px;margin-bottom:12px;display:flex;gap:8px;align-items:center;font-size:11.5px;color:#166534;">
        <span>✅</span><span><strong>Established, trusted domain</strong> — verified by Google Safe Browsing. Clause risks reflect standard industry practice.</span>
      </div>`;
    } else {
      html += `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:8px 13px;margin-bottom:12px;display:flex;gap:8px;align-items:center;font-size:11.5px;color:#166534;">
        <span>🛡️</span><span><strong>Domain verified safe</strong> by Google Safe Browsing.</span>
      </div>`;
    }
  }

  if (a.weakLegal && a._textLength < 1000) {
    html += `<div class="confidence-warn">⚠️ <span><strong>Low confidence</strong> — limited policy text available. Results may be incomplete.</span></div>`;
  }

  if (a.summary?.length) {
    html += `<div class="summary-card">
      <div class="summary-card-head">📋 Summary</div>
      <div class="summary-items">`;
    a.summary.forEach(s => {
      html += `<div class="summary-item ${s.startsWith("✅") ? "positive" : ""}">
        <span>${s.slice(0,2)}</span><span>${esc(s.slice(2).trim())}</span>
      </div>`;
    });
    html += `</div></div>`;
  }

  if (a.risks?.length) {
    html += `<div class="section-label">⚠️ Risks Found (${a.risks.length})</div>`;
    a.risks.forEach((risk, i) => {
      const sev = risk.severity || "medium";
      const tip = esc(risk.tip || "Read carefully before agreeing.");
      const counter = risk.counter
        ? `<div class="counter-row"><span class="tip-icon">🛡️</span><span class="counter-text">${esc(risk.counter)}</span></div>` : "";
      const reasonTag = risk.reason
        ? `<span class="risk-reason">📌 ${esc(risk.reason)}</span>` : "";

      html += `
        <div class="risk-card" data-idx="${i}">
          <div class="risk-header">
            <div class="sev-dot ${sev}"></div>
            <div class="risk-title-wrap">
              <span class="risk-type">${esc(risk.type)}</span>
              ${reasonTag}
            </div>
            <span class="sev-badge ${sev}">${sev}</span>
            <span class="expand-chevron">▾</span>
          </div>
          <div class="risk-text">"${esc(risk.text)}"</div>
          <div class="risk-panel">
            <div class="risk-panel-inner">
              <div class="risk-panel-body">
                <div class="tip-row">
                  <span class="tip-icon">💡</span>
                  <span class="tip-text">${tip}</span>
                </div>
                ${counter}
              </div>
            </div>
          </div>
        </div>`;
    });
  } else {
    html += `<div class="empty-state" style="padding:20px 10px">
      <span class="empty-icon" style="font-size:28px">✅</span>
      No major risks detected in this document.
    </div>`;
  }

  if (a.safeCards?.length) {
    html += `<div class="section-label" style="color:var(--green)">✅ Safe Clauses</div>`;
    a.safeCards.forEach(sc => {
      html += `<div class="safe-card"><span>✅</span><span>${esc(sc.text)}</span></div>`;
    });
  }

  if (a.darkPatterns > 0) {
    html += `<div class="dp-row">🎭 ${a.darkPatterns} dark pattern${a.darkPatterns>1?"s":""} detected</div>`;
  }

  if (a.communityLinks?.length) {
    html += `<div class="community-section">
      <div class="community-title">🌐 Real User Experiences</div>
      <div class="community-grid">`;
    a.communityLinks.forEach(l => {
      html += `<a class="community-link" data-href="${esc(l.url)}">
        <div class="community-link-top">${l.icon} ${esc(l.label)}</div>
        ${l.preview ? `<div class="community-link-sub">${esc(l.preview)}</div>` : ""}
      </a>`;
    });
    html += `</div></div>`;
  }

  if (a.sourceUrl) html += `<div class="source-url">${esc(a.sourceUrl)}</div>`;
  return html;
}

// ===== OPT-OUT EMAIL TAB =====
function buildOptOutTab(a) {
  let company = "the company";
  let domain = "";
  try {
    const u = new URL(a.sourceUrl || "");
    domain = u.hostname.replace("www.", "");
    company = domain.split(".")[0];
    company = company.charAt(0).toUpperCase() + company.slice(1);
  } catch {}

  // Detect which opt-outs are relevant
  const hasArbitration = a.risks?.some(r => r.type.includes("Arbitration"));
  const hasAutoRenew   = a.risks?.some(r => r.type.includes("Auto Billing") || r.type.includes("Auto-Renewal"));
  const hasMarketing   = a.risks?.some(r => r.type.includes("Data Sharing (Marketing)") || r.type.includes("Data Selling"));
  const hasCancellation = a.risks?.some(r => r.type.includes("Cancellation"));

  const options = [];
  if (hasArbitration)   options.push({ id: "arbitration", label: "⚖️ Opt out of forced arbitration", badge: "critical" });
  if (hasAutoRenew)     options.push({ id: "autorenew",   label: "⚠️ Cancel / stop auto-renewal",    badge: "high" });
  if (hasMarketing)     options.push({ id: "marketing",   label: "🔓 Opt out of data sharing",         badge: "high" });
  if (hasCancellation)  options.push({ id: "cancel",      label: "🚪 Formal cancellation request",     badge: "medium" });
  // Always offer general inquiry
  options.push({ id: "general", label: "📋 Request full data disclosure", badge: "low" });

  if (State.optoutStep === "select" || !State.optoutType) {
    let html = `<div class="optout-intro">
      <p>Based on the risks detected, here are <strong>ready-to-send opt-out emails</strong>. Select one to draft:</p>
    </div>
    <div class="optout-options">`;
    if (options.length === 0) {
      html += `<div class="safe-card"><span>✅</span><span>No risky clauses detected — no opt-out emails needed.</span></div>`;
    } else {
      options.forEach(o => {
        html += `<button class="optout-option-btn" data-type="${o.id}">
          <span>${o.label}</span>
          <span class="sev-badge ${o.badge}" style="font-size:8px">${o.badge}</span>
        </button>`;
      });
    }
    html += `</div>`;
    return html;
  }

  if (State.optoutStep === "draft") {
    const draft = buildEmailDraft(State.optoutType, company, domain, a);
    return `
      <div class="optout-draft-header">
        <button id="optoutBack" class="optout-back-btn">← Back</button>
        <span class="optout-draft-title">${draft.title}</span>
      </div>
      <div class="email-draft-box">
        <div class="email-field"><span class="email-label">To:</span><span class="email-val">${esc(draft.to)}</span></div>
        <div class="email-field"><span class="email-label">Subject:</span><span class="email-val">${esc(draft.subject)}</span></div>
        <div class="email-divider"></div>
        <div class="email-body" id="emailBodyText">${esc(draft.body)}</div>
      </div>
      <div class="optout-actions">
        <button id="copyEmailBtn" class="btn btn-secondary" style="flex:1">📋 Copy Email</button>
        <button id="openMailBtn"  class="btn btn-primary"   style="flex:1">📧 Open in Mail</button>
      </div>
      <div class="optout-tip">
        💡 <strong>Tip:</strong> ${esc(draft.tip)}
      </div>
    `;
  }

  return "";
}

function buildEmailDraft(type, company, domain, a) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const supportEmail = `support@${domain}`;
  const legalEmail = `legal@${domain}`;
  const privacyEmail = `privacy@${domain}`;

  const drafts = {
    arbitration: {
      title: "⚖️ Arbitration Opt-Out",
      to: legalEmail,
      subject: `Arbitration Opt-Out Notice — Account Holder Request`,
      body: `To Whom It May Concern at ${company},

I am writing to formally opt out of the mandatory arbitration clause contained in your Terms of Service.

Under the terms of your agreement, I understand I have the right to opt out of binding arbitration within a specified timeframe. I hereby exercise that right.

Please confirm receipt of this opt-out notice in writing.

Account Information:
- Full Name: [YOUR FULL NAME]
- Email Address: [YOUR ACCOUNT EMAIL]
- Date of Account Creation / Agreement: [DATE]

I expect a written confirmation within 10 business days.

Regards,
[YOUR FULL NAME]
${today}`,
      tip: "Send this via certified email or mail. Keep a screenshot of the sent email as proof. Most companies allow arbitration opt-out within 30 days of signing up."
    },
    autorenew: {
      title: "⚠️ Cancel Auto-Renewal",
      to: supportEmail,
      subject: `Cancellation Request — Stop Auto-Renewal Immediately`,
      body: `Dear ${company} Support Team,

I am writing to formally request the immediate cancellation of my subscription and the disabling of all auto-renewal charges on my account.

Please confirm:
1. My subscription has been cancelled effective today (${today})
2. No further charges will be made to my payment method
3. A refund for any unused subscription period will be processed (if applicable)

Account Information:
- Full Name: [YOUR FULL NAME]
- Email Address: [YOUR ACCOUNT EMAIL]
- Subscription Plan: [YOUR PLAN NAME]

If there is no online cancellation option, I request you process this cancellation via this email and send written confirmation within 5 business days.

Regards,
[YOUR FULL NAME]`,
      tip: "After sending, take a screenshot or print this email immediately. Follow up if you don't get confirmation within 5 business days. Consider disputing any post-cancellation charge with your bank."
    },
    marketing: {
      title: "🔓 Data Sharing Opt-Out",
      to: privacyEmail,
      subject: `Data Sharing Opt-Out Request — GDPR/CCPA`,
      body: `To the ${company} Privacy Team,

I am writing to formally exercise my right to opt out of the sale and sharing of my personal data with third parties, including advertising partners and data brokers.

Under applicable privacy law (GDPR / CCPA / applicable local law), I request:
1. Immediate cessation of selling or sharing my personal data
2. Removal of my data from any third-party marketing lists
3. Confirmation of the categories of data shared to date
4. Written confirmation that this opt-out has been processed

Account Information:
- Full Name: [YOUR FULL NAME]
- Email Address: [YOUR ACCOUNT EMAIL]
- Account ID (if known): [ACCOUNT ID]

I expect a response within 30 days as required by law.

Regards,
[YOUR FULL NAME]
${today}`,
      tip: "Under GDPR/CCPA, companies must respond within 30 days. If they don't respond, you can file a complaint with your local data protection authority."
    },
    cancel: {
      title: "🚪 Formal Cancellation",
      to: supportEmail,
      subject: `Formal Cancellation Request — Written Notice`,
      body: `Dear ${company},

I am providing formal written notice of my intent to cancel my account and all associated services, effective immediately.

As required by your Terms of Service, I am submitting this cancellation request in writing.

Please confirm:
1. Cancellation is effective as of today (${today})
2. All future charges are stopped
3. My account data is retained/deleted per your privacy policy
4. A confirmation number is provided

Account Information:
- Full Name: [YOUR FULL NAME]
- Email Address: [YOUR ACCOUNT EMAIL]
- Account ID: [ACCOUNT ID]

If additional steps are required to complete this cancellation, please inform me in writing within 3 business days.

Regards,
[YOUR FULL NAME]`,
      tip: "If the company requires cancellation by phone, record the call (where legal) or follow up with an email summary of the conversation."
    },
    general: {
      title: "📋 Data Disclosure Request",
      to: privacyEmail,
      subject: `Personal Data Access Request — Right to Know`,
      body: `To the ${company} Privacy Team,

I am requesting a full disclosure of all personal data your company holds about me, pursuant to my rights under applicable privacy law (GDPR / CCPA / other).

Please provide:
1. All categories of personal data you collect about me
2. The purposes for which my data is used
3. All third parties with whom my data has been shared
4. The retention period for each category of data
5. Any automated decision-making processes that use my data

Account Information:
- Full Name: [YOUR FULL NAME]
- Email Address: [YOUR ACCOUNT EMAIL]

I expect a response within 30 days.

Regards,
[YOUR FULL NAME]
${today}`,
      tip: "Companies are legally required to respond to data access requests. If they don't within 30 days, contact your local data protection authority."
    }
  };

  return drafts[type] || drafts.general;
}

function wireOptOut(a) {
  document.querySelectorAll(".optout-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      State.optoutType = btn.dataset.type;
      State.optoutStep = "draft";
      render();
    });
  });

  document.getElementById("optoutBack")?.addEventListener("click", () => {
    State.optoutStep = "select";
    render();
  });

  document.getElementById("copyEmailBtn")?.addEventListener("click", () => {
    const body = document.getElementById("emailBodyText")?.textContent || "";
    navigator.clipboard.writeText(body).then(() => {
      const btn = document.getElementById("copyEmailBtn");
      if (btn) { const orig = btn.innerHTML; btn.innerHTML = "✓ Copied!"; setTimeout(() => btn.innerHTML = orig, 2000); }
    });
  });

  document.getElementById("openMailBtn")?.addEventListener("click", () => {
    const a = State.analysis;
    let domain = "";
    let company = "the company";
    try {
      domain = new URL(a.sourceUrl || "").hostname.replace("www.", "");
      company = domain.split(".")[0];
      company = company.charAt(0).toUpperCase() + company.slice(1);
    } catch {}
    const draft = buildEmailDraft(State.optoutType, company, domain, a);
    const mailto = `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
    chrome.tabs.create({ url: mailto });
  });
}

// ===== CHAT TAB =====
function buildChatTab() {
  const hasKey = true; // key check happens in background
  let html = `<div class="chat-container">`;

  html += `<div class="chat-messages" id="chatMessages">`;

  if (State.chatHistory.length === 0) {
    html += `<div class="chat-welcome">
      <div class="chat-welcome-icon">🤖</div>
      <div class="chat-welcome-title">Investigate this website policy</div>
      <div class="chat-welcome-sub">The agent can search clauses, retrieve evidence, inspect a linked policy and explain what it finds.</div>
      <div class="chat-suggestions">
        <button class="chat-suggestion" data-q="Can I cancel anytime?">Can I cancel anytime?</button>
        <button class="chat-suggestion" data-q="Do they sell my data?">Do they sell my data?</button>
        <button class="chat-suggestion" data-q="What are the auto-renewal terms?">Auto-renewal terms?</button>
        <button class="chat-suggestion" data-q="Can they delete my account without warning?">Can they delete my account?</button>
      </div>
    </div>`;
  } else {
    State.chatHistory.forEach(msg => {
      if (msg.role === "user") {
        html += `<div class="chat-msg chat-user"><div class="chat-bubble chat-bubble-user">${esc(msg.text)}</div></div>`;
      } else {
        html += `<div class="chat-msg chat-ai"><div class="chat-avatar">🤖</div><div class="chat-bubble chat-bubble-ai">${esc(msg.text)}</div></div>`;
      }
    });
    if (State.chatLoading) {
      html += `<div class="chat-msg chat-ai"><div class="chat-avatar">🤖</div><div class="chat-bubble chat-bubble-ai chat-typing"><span></span><span></span><span></span></div></div>`;
    }
  }

  html += `</div>`;

  html += `<div class="chat-input-row">
    <input type="text" id="chatInput" class="chat-input" placeholder="Ask about this document…" maxlength="300" ${State.chatLoading ? "disabled" : ""}/>
    <button id="chatSend" class="chat-send-btn" ${State.chatLoading ? "disabled" : ""}>
      ${State.chatLoading ? "⏳" : "➤"}
    </button>
  </div>`;

  if (State.chatHistory.length > 0) {
    html += `<div style="text-align:center;padding:4px 0 2px">
      <button id="clearChatBtn" style="background:none;border:none;font-size:10px;color:var(--muted);cursor:pointer;">Clear chat</button>
    </div>`;
  }

  html += `</div>`;
  return html;
}

function wireChat() {
  // Scroll to bottom
  const msgs = document.getElementById("chatMessages");
  if (msgs) msgs.scrollTop = msgs.scrollHeight;

  // Suggestion chips
  document.querySelectorAll(".chat-suggestion").forEach(btn => {
    btn.addEventListener("click", () => sendChatMessage(btn.dataset.q));
  });

  // Send button
  document.getElementById("chatSend")?.addEventListener("click", () => {
    const input = document.getElementById("chatInput");
    if (input?.value.trim()) sendChatMessage(input.value.trim());
  });

  // Enter key
  document.getElementById("chatInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !State.chatLoading) {
      const input = document.getElementById("chatInput");
      if (input?.value.trim()) sendChatMessage(input.value.trim());
    }
  });

  document.getElementById("clearChatBtn")?.addEventListener("click", () => {
    State.chatHistory = [];
    render();
  });
}

function sendChatMessage(question) {
  if (State.chatLoading) return;
  State.chatHistory.push({ role: "user", text: question });
  State.chatLoading = true;
  render();

  chrome.storage.local.get(["analysis"], async result => {
    try {
      const analysis = result.analysis || {};
      const policyText = analysis._fullText || "";
      if (!policyText.trim()) throw new Error("No policy text found. Analyze the current Terms & Conditions page first.");
      const response = await fetch("http://localhost:8787/api/agent/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          policyText,
          documents: Array.isArray(analysis._documents) ? analysis._documents : [],
          sourceUrl: analysis.sourceUrl || "",
          domain: (() => { try { return new URL(analysis.sourceUrl).hostname; } catch { return ""; } })()
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Backend returned ${response.status}`);
      const trace = (data.trace || []).map((item, i) => `${i + 1}. ${item}`).join("\n");
      const reply = `${data.answer || "No answer returned."}${trace ? "\n\nInvestigation steps:\n" + trace : ""}`;
      State.chatHistory.push({ role: "ai", text: reply });
    } catch (error) {
      State.chatHistory.push({ role: "ai", text: `Agent error: ${error.message}\n\nMake sure the ClearSign backend is running on http://localhost:8787.` });
    } finally {
      State.chatLoading = false;
      render();
      setTimeout(() => {
        const msgs = document.getElementById("chatMessages");
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }, 50);
    }
  });
}

// ===== ONBOARDING =====
function buildOnboarding() {
  return `<div class="onboarding" id="onboardingBanner">
    <button class="onboarding-close" id="onboardingClose">✕</button>
    <h3>👋 Welcome to ClearSign!</h3>
    <p>Visit any Terms & Conditions page and click <strong style="color:#fbbf24">🔍 Analyze T&C</strong>.
    Drag the button anywhere. Tap risk cards to expand tips.<br>
    New: <strong style="color:#fbbf24">✉️ Opt-Out emails</strong> and <strong style="color:#fbbf24">🤖 Ask AI</strong> tabs above.<br>
    Shortcut: <strong>Ctrl+Shift+K</strong></p>
  </div>`;
}

function wireOnboarding() {
  document.getElementById("onboardingClose")?.addEventListener("click", () => {
    State.onboardingDone = true;
    chrome.storage.local.set({ onboardingDone: true });
    render();
  });
}

// ===== ACTION HANDLERS =====
function onRefresh() {
  const btn = document.getElementById("refreshBtn");
  btn.textContent = "⏳ Scanning...";
  btn.disabled = true;
  State.set({ scanStatus: "scanning" });
  chrome.runtime.sendMessage({ type: "REANALYZE_TAB" }, resp => {
    btn.innerHTML = "🔄 Refresh";
    btn.disabled = false;
    if (chrome.runtime.lastError || resp?.error) State.set({ scanStatus: null });
  });
}

function onClear() {
  if (!confirm("Clear analysis? You'll need to re-scan.")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_ANALYSIS" }, () => State.set({ analysis: null, scanStatus: null }));
}

// ===== SKELETON =====
function buildSkeleton(label = "Analyzing...") {
  return `<div class="skeleton-wrap">
    <div class="skeleton-label" id="scanStatus">${esc(label)}</div>
    <div class="skeleton-bar" style="width:72%"></div>
    <div class="skeleton-bar" style="width:55%"></div>
    <div class="skeleton-bar" style="width:83%"></div>
    <div class="skeleton-bar" style="width:47%"></div>
    <div class="skeleton-bar" style="width:68%"></div>
  </div>`;
}

// ===== TIME AGO =====
function timeAgo(ts) {
  const d = Date.now() - ts, m = Math.floor(d/60000), h = Math.floor(d/3600000), dy = Math.floor(d/86400000);
  if (d < 60000) return "just now";
  if (m < 60) return m + "m ago";
  if (h < 24) return h + "h ago";
  return dy + "d ago";
}

// ===== EXPORT =====
function exportReport() {
  const a = State.analysis;
  if (!a) { alert("No analysis to export."); return; }
  let slug = "";
  try { slug = "-" + new URL(a.sourceUrl).hostname.replace("www.", ""); } catch {}
  const dateStr = new Date(a.timestamp || Date.now()).toISOString().slice(0, 10);

  let r = `CLEARSIGN RISK REPORT\n${"=".repeat(30)}\n\n`;
  r += `Risk Score: ${a.score}/10\n`;
  r += `Analyzed: ${new Date(a.timestamp||Date.now()).toLocaleString()}\n`;
  if (a.sourceUrl) r += `Source: ${a.sourceUrl}\n`;
  if (a.scanDuration) r += `Scan duration: ${a.scanDuration}s\n`;
  if (typeof a.linksScanned === "number") r += `Linked policies: ${a.linksScanned}\n`;
  r += "\nSUMMARY:\n";
  (a.summary||[]).forEach(s => r += `- ${s}\n`);
  r += "\nRISKS:\n";
  (a.risks||[]).forEach((risk, i) => {
    r += `\n${i+1}. [${(risk.severity||"medium").toUpperCase()}] ${risk.type}\n`;
    if (risk.reason) r += `   Why flagged: ${risk.reason}\n`;
    r += `   Clause: "${risk.text}"\n`;
    r += `   Tip: ${risk.tip||"Review carefully"}\n`;
    if (risk.counter) r += `   Counter: ${risk.counter}\n`;
  });
  if (a.safeCards?.length) {
    r += "\nSAFE CLAUSES:\n";
    a.safeCards.forEach(sc => r += `- ${sc.text}\n`);
  }
  r += `\n${"=".repeat(30)}\nGenerated by ClearSign v14\n`;

  const blob = new Blob([r], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url; el.download = `clearsign${slug}-${dateStr}.txt`;
  el.click();
  URL.revokeObjectURL(url);

  const btn = document.getElementById("exportBtn");
  const orig = btn.innerHTML;
  btn.innerHTML = "✓ Done!";
  setTimeout(() => btn.innerHTML = orig, 2000);
}

// ===== ESCAPE =====
function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
                  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}