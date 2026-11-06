// background.js - ClearSign v14

// ===== OPENROUTER CONFIG =====
// 🔑 ADD YOUR API KEY HERE — ctrl+f: "OPENROUTER_API_KEY"
const OPENROUTER_API_KEY = ""; // Agent calls now go through the backend. Never put secrets in an extension.
const OPENROUTER_MODEL   = "nvidia/nemotron-3-ultra-550b-a55b:free"; // free tier on openrouter.ai

// ===== GOOGLE SAFE BROWSING CONFIG =====
// 🔑 GET A FREE KEY: https://developers.google.com/safe-browsing/v4/get-started
// Then replace the placeholder below with your key — ctrl+f: "SAFE_BROWSING_API_KEY"
const SAFE_BROWSING_API_KEY = ""; // Optional: configure server-side if you later move Safe Browsing there.

// ===== TRUSTED DOMAIN LIST =====
// Well-known legitimate companies — get a score reduction bonus.
const TRUSTED_DOMAINS = new Set([
  "spotify.com","google.com","apple.com","microsoft.com","amazon.com","netflix.com",
  "meta.com","facebook.com","instagram.com","twitter.com","x.com","youtube.com",
  "linkedin.com","github.com","dropbox.com","adobe.com","paypal.com","stripe.com",
  "shopify.com","zoom.us","slack.com","notion.so","atlassian.com","salesforce.com",
  "twilio.com","cloudflare.com","airbnb.com","uber.com","lyft.com","reddit.com",
  "wikipedia.org","bbc.com","nytimes.com","theguardian.com","bloomberg.com",
  "reuters.com","medium.com","substack.com","discord.com","snapchat.com","tiktok.com",
]);

// ===== SUSPICIOUS DOMAIN PATTERNS =====
// Patterns that indicate a site may be untrustworthy even if GSB hasn't caught it yet.
const SUSPICIOUS_TLD = /\.(xyz|top|click|loan|work|win|gq|ml|cf|tk|ga|buzz|icu|cam|cfd|monster|quest|cyou)$/i;
const SUSPICIOUS_KEYWORDS = /reward|prize|claim|winner|free-gift|lucky|cash|bonus|scam-sim|money|jackpot|promo-win|congratulation/i;
const SUSPICIOUS_PLATFORM_DOMAINS = /(lovable\.app|glitch\.me|vercel\.app|netlify\.app|pages\.dev|web\.app|firebaseapp\.com|github\.io|repl\.co|replit\.dev|000webhostapp\.com|weebly\.com|wixsite\.com|carrd\.co|framer\.app)$/i;

function assessDomainTrust(hostname) {
  // Returns { trusted: bool, suspicious: bool, reasons: string[] }
  const reasons = [];
  const baseDomain = hostname.replace(/^www\./, "");

  // Check trusted list
  if (TRUSTED_DOMAINS.has(baseDomain)) {
    return { trusted: true, suspicious: false, reasons: [] };
  }

  // Check suspicious signals
  if (SUSPICIOUS_TLD.test(hostname)) reasons.push("Uncommon high-risk TLD");
  if (SUSPICIOUS_KEYWORDS.test(hostname)) reasons.push("Domain name contains reward/scam keywords");
  if (SUSPICIOUS_PLATFORM_DOMAINS.test(hostname)) {
    reasons.push("Hosted on free website builder platform — not an established business domain");
  }

  // Subdomain abuse: many subdomains stacked = suspicious
  const parts = hostname.split(".");
  if (parts.length > 4) reasons.push("Excessive subdomain nesting");

  return { trusted: false, suspicious: reasons.length > 0, reasons };
}

let deepScanController = null; // shared cancel controller

// ===== DOMAIN SAFETY CHECK (Google Safe Browsing v4) =====
async function checkDomainSafety(url) {
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { return { checked: false }; }

  // Always run our local heuristic trust assessment regardless of GSB key
  const trustAssessment = assessDomainTrust(hostname);

  // Skip GSB API call if no key configured
  if (!SAFE_BROWSING_API_KEY || SAFE_BROWSING_API_KEY.startsWith("YOUR_")) {
    return {
      checked: true,
      safe: !trustAssessment.suspicious,
      trusted: trustAssessment.trusted,
      suspicious: trustAssessment.suspicious,
      suspiciousReasons: trustAssessment.reasons,
      gsbChecked: false
    };
  }

  try {
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${SAFE_BROWSING_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "clearsign-extension", clientVersion: "14" },
          threatInfo: {
            threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: [
              { url: `https://${hostname}/` },
              { url: `http://${hostname}/` }
            ]
          }
        })
      }
    );
    if (!res.ok) {
      return {
        checked: true, safe: !trustAssessment.suspicious,
        trusted: trustAssessment.trusted, suspicious: trustAssessment.suspicious,
        suspiciousReasons: trustAssessment.reasons, gsbChecked: false
      };
    }
    const data = await res.json();
    if (data.matches && data.matches.length > 0) {
      const threatType = data.matches[0].threatType || "UNKNOWN";
      return {
        checked: true, safe: false, threatType,
        trusted: false, suspicious: true,
        suspiciousReasons: ["Flagged by Google Safe Browsing: " + threatType],
        gsbChecked: true
      };
    }
    // GSB says safe — but still flag heuristic suspicion separately
    return {
      checked: true,
      safe: !trustAssessment.suspicious,       // safe=false if our heuristic fires
      gsbSafe: true,                            // GSB itself said safe
      trusted: trustAssessment.trusted,
      suspicious: trustAssessment.suspicious,
      suspiciousReasons: trustAssessment.reasons,
      gsbChecked: true
    };
  } catch {
    return {
      checked: true, safe: !trustAssessment.suspicious,
      trusted: trustAssessment.trusted, suspicious: trustAssessment.suspicious,
      suspiciousReasons: trustAssessment.reasons, gsbChecked: false
    };
  }
}

// ===== CLEAN HTML =====
function stripHTML(html) {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/@font-face\s*{[^}]+}/gis, "")
    .replace(/url\([^)]+\)/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ===== CLEAN TEXT =====
function cleanText(text) {
  return text
    .replace(/\r/g, "")
    .split(/[.!?]\s+|\n{1,}/)
    .map(s => s.trim())
    .filter(s => s.length > 50)
    .join("\n");
}

// ===== VALID CLAUSE =====
function isValidClause(line) {
  if (line.length < 55 || line.length > 500) return false;
  if (/^(login|sign up|download|menu|home|support|about us|contact|help|faq|blog|careers)/i.test(line.trim())) return false;
  if (/login|sign up|download|click here|learn more|read more|see all|view all|get started/i.test(line)) return false;
  if (/[{}<>@;]/.test(line)) return false;
  if ((line.match(/http/g) || []).length > 1) return false;
  if ((line.match(/\|/g) || []).length > 2) return false;
  return true;
}

function isLegalContext(line) {
  return /terms of service|terms and conditions|subscription agreement|billing policy|privacy policy|data processing|refund policy|cancellation policy|fees and charges|auto.renew|service agreement|end user|eula|subscription|recurring|payment method|charged|billing|will renew|arbitration|class action/i.test(line);
}

function isHighValueClause(line) {
  return /auto.?renew|automatically renew|recurring charge|recurring billing|will be charged|subscription fee|cancel.*subscription|non.refundable|terminate.*account|suspend.*service|delete.*account|continue to be charged|continue.*indefinitely|until you cancel|subscription continues|charged.*automatically|payment.*recurring|renew.*automatically|binding arbitration|waive.*class action|waive.*jury|dispute.*arbitration|arbitration.*dispute|forced arbitration|class action waiver/i.test(line);
}

function isReadableSentence(line) {
  if (/privacy policy -|skip to content|premium plans/i.test(line)) return false;
  const words = line.toLowerCase().split(" ");
  if (words.length < 6) return false;
  return new Set(words).size >= words.length * 0.35;
}

function hasBillingKeyword(line) {
  return /subscription|charge|billing|payment|renew|arbitration|class action/i.test(line);
}

function extractClauses(text) {
  return [...new Set(
    text.split("\n").filter(line =>
      isValidClause(line) &&
      isReadableSentence(line) &&
      (isHighValueClause(line) || isLegalContext(line) || hasBillingKeyword(line))
    )
  )];
}

// ===== DARK PATTERN DETECTION =====
function detectDarkPatterns(text) {
  const lower = text.slice(0, 2000).toLowerCase();
  const patterns = [];

  if (/don't want to save|no thanks, i don't|i don't like saving|skip savings|decline protection/i.test(lower)) {
    patterns.push({
      name: "🎭 Confirmshaming", severity: "high", quote: text.slice(0, 120).trim(),
      tip: "The 'No' option is designed to make you feel guilty. Click it anyway.",
      counter: "Always read the decline option carefully before clicking.",
      reason: "Guilt-based 'No' wording detected"
    });
  }
  if (/i do not want to unsubscribe|uncheck to subscribe|click here to not receive/i.test(lower)) {
    patterns.push({
      name: "🎭 Trick Wording", severity: "high", quote: text.slice(0, 120).trim(),
      tip: "Double negatives are intentional traps. Read the sentence twice.",
      counter: "Rephrase without 'not' — the meaning flips.",
      reason: "Double-negative opt-in/out wording"
    });
  }
  if (/cancel by mail|cancel by phone only|written notice required|30 days.*notice|cancellation fee|no online cancellation/i.test(lower)) {
    patterns.push({
      name: "🎭 Hard Cancellation", severity: "critical", quote: text.slice(0, 120).trim(),
      tip: "Document everything. Send cancellation via certified mail.",
      counter: "Screenshot the cancellation process. Save all confirmation numbers.",
      reason: "Cancellation requires offline steps or fees"
    });
  }
  if (/auto.?renew(al)?|automatically renews|recurring billing|subscription renews/i.test(lower)) {
    patterns.push({
      name: "🎭 Auto-Renewal Trap", severity: "high", quote: text.slice(0, 120).trim(),
      tip: "Set a calendar reminder 3 days before renewal.",
      counter: "Use a virtual card with a spending limit.",
      reason: "Auto-renewal clause in visible UI text"
    });
  }
  if (/additional fee|processing fee|service fee|activation fee|convenience fee/i.test(lower)) {
    patterns.push({
      name: "🎭 Hidden Fees", severity: "high", quote: text.slice(0, 120).trim(),
      tip: "Search for 'fee', 'charge', 'cost' in the document.",
      counter: "Calculate total cost including all fees before agreeing.",
      reason: "Extra fee language detected"
    });
  }
  if (/binding arbitration|waive.*class action|dispute resolution.*arbitration/i.test(lower)) {
    patterns.push({
      name: "⚖️ Forced Arbitration", severity: "critical", quote: text.slice(0, 120).trim(),
      tip: "You give up the right to sue. Some companies allow opt-out within 30 days.",
      counter: "Send opt-out via certified mail within 30 days.",
      reason: "Mandatory arbitration + class action waiver"
    });
  }

  return patterns;
}

// ===== CLASSIFICATION =====
const WEIGHTS = {
  "🔓 Data Selling":            5,
  "🚫 Service Termination":     4,
  "⚠️ Auto Billing":           3,
  "💸 Fees":                    2,
  "📋 Hidden Conditions":       1.5,
  "🔓 Data Sharing (Marketing)":3,
  "🔓 Data Sharing (Legal)":    0.5,
  "💰 Pricing":                 1,
  "🎭 Confirmshaming":          2,
  "🎭 Trick Wording":           2,
  "🎭 Hard Cancellation":       3,
  "🎭 Auto-Renewal Trap":       3,
  "🎭 Hidden Fees":             2,
  "⚖️ Forced Arbitration":      4,
};

function classify(c) {
  const t = c.toLowerCase();

  let ab = 0;
  if (/auto.?renew|automatically renew|renew.*automatically/.test(t)) ab += 2;
  if (/recurring/.test(t)) ab += 1;
  if (/subscription|charge|billing/.test(t)) ab += 1;
  if (/continue to be charged|continue.*indefinitely|until you cancel|subscription continues|charged.*automatically|payment.*recurring/.test(t)) ab += 2;
  if (/will be charged|you will be billed|your.*card.*charged/.test(t)) ab += 1;
  if (ab >= 2)
    return { type: "⚠️ Auto Billing", severity: "high", weight: Math.min(ab, WEIGHTS["⚠️ Auto Billing"]),
             reason: ab >= 4 ? "explicit auto-renewal language" : "billing continuation language" };

  if (/\bsell\b.*\b(personal data|your data|user data|information)\b|\b(personal data|user data)\b.*\bsold\b/i.test(t))
    return { type: "🔓 Data Selling", severity: "critical", weight: WEIGHTS["🔓 Data Selling"],
             reason: "explicit data selling language" };

  if (/share.*third.?party.*\b(marketing|advertis)\b|share.*\b(advertis|marketing)\b.*partner/i.test(t))
    return { type: "🔓 Data Sharing (Marketing)", severity: "high", weight: WEIGHTS["🔓 Data Sharing (Marketing)"],
             reason: "sharing with ad/marketing partners" };
  if (/share.*personal.*with.*partner|share.*information.*with.*affiliate/i.test(t))
    return { type: "🔓 Data Sharing (Marketing)", severity: "medium", weight: 2,
             reason: "data shared with affiliates/partners" };
  if (/share.*\b(law enforcement|government|regulat|legal requirement)\b/i.test(t))
    return { type: "🔓 Data Sharing (Legal)", severity: "low", weight: WEIGHTS["🔓 Data Sharing (Legal)"],
             reason: "legal compliance disclosure" };

  if (/share.*to.*improve|share.*service.*provider|data.*to.*improve.*our|analytics.*improve|share.*solely.*to.*provide/i.test(t))
    return { type: "✅ Safe Data Use", severity: "safe", weight: 0, reason: "data used for service improvement only" };

  let tw = 0;
  if (/terminate.*account|suspend.*account|delete.*account|ban.*account|deactivate.*account/i.test(t)) tw += 2;
  if (/we.*may.*suspend|we.*may.*terminate|right to terminate|right to suspend/i.test(t)) tw += 1.5;
  if (/remove.*access|revoke.*access/i.test(t)) tw += 1;
  if (/without notice|without.*prior notice/i.test(t)) tw += 1;
  if (tw >= 2)
    return { type: "🚫 Service Termination", severity: tw >= 3 ? "high" : "medium",
             weight: Math.min(tw, WEIGHTS["🚫 Service Termination"]), reason: "account termination without notice" };

  if (/non.?refundable|no refund|all sales final|refund.*not.*eligible/i.test(t))
    return { type: "💸 Fees", severity: "high", weight: WEIGHTS["💸 Fees"], reason: "no-refund policy" };
  if (/cancellation fee|early termination fee|penalty.*cancel/i.test(t))
    return { type: "💸 Fees", severity: "high", weight: WEIGHTS["💸 Fees"], reason: "cancellation fee" };
  if (/\bfee(s)?\b.*\b(additional|extra|hidden|surprise)\b|\b(additional|extra)\b.*\bfee(s)?\b/i.test(t))
    return { type: "💸 Fees", severity: "medium", weight: 1.5, reason: "unexpected fee language" };

  if (/price.*change|pricing.*change|modify.*price|change.*fee|rate.*may.*change|adjust.*pricing/i.test(t))
    return { type: "💰 Pricing", severity: "medium", weight: WEIGHTS["💰 Pricing"], reason: "prices may change without notice" };

  if (/binding arbitration|class action waiver|waive.*right.*sue|arbitrat/i.test(t))
    return { type: "⚖️ Forced Arbitration", severity: "critical", weight: WEIGHTS["⚖️ Forced Arbitration"],
             reason: "mandatory arbitration clause" };

  if (/governing law|jurisdiction|applicable law/i.test(t))
    return { type: "📋 Hidden Conditions", severity: "low", weight: WEIGHTS["📋 Hidden Conditions"],
             reason: "specific jurisdiction/law requirements" };
  if (/reserve.*right|right.*change.*terms|modify.*agreement|update.*terms.*notice|terms.*subject.*change/i.test(t))
    return { type: "📋 Hidden Conditions", severity: "medium", weight: WEIGHTS["📋 Hidden Conditions"],
             reason: "terms can be changed unilaterally" };

  return null;
}

function similarity(a, b) {
  const sa = new Set(a.toLowerCase().split(/\W+/));
  const sb = new Set(b.toLowerCase().split(/\W+/));
  let inter = 0;
  sa.forEach(w => { if (sb.has(w)) inter++; });
  return inter / Math.max(sa.size, sb.size, 1);
}

// ===== TIPS =====
function getTip(type) {
  const TIPS = {
    "⚠️ Auto Billing":            "Set a phone reminder 5 days before each renewal date. Use a virtual card.",
    "🔓 Data Selling":            "Opt out via CCPA/GDPR if available. Use a masked email service.",
    "🔓 Data Sharing (Marketing)":"Opt out of marketing in privacy settings.",
    "🔓 Data Sharing (Legal)":    "Standard legal compliance — low risk.",
    "🚫 Service Termination":     "Export your data now. Keep a backup of all content.",
    "💸 Fees":                    "Ask support for a fee waiver. Document all charges.",
    "📋 Hidden Conditions":       "Read all linked documents before agreeing.",
    "💰 Pricing":                 "Lock in pricing with annual plan if available.",
    "⚖️ Forced Arbitration":      "Send opt-out letter within 30 days of signup.",
    "🎭 Confirmshaming":          "Ignore guilt language — choose what's right for you.",
    "🎭 Trick Wording":           "Rephrase the sentence removing 'not' — the meaning reverses.",
    "🎭 Hard Cancellation":       "Document every step. Use certified mail for written notice.",
    "🎭 Auto-Renewal Trap":       "Use a single-use virtual card number for subscriptions.",
    "🎭 Hidden Fees":             "Total up all fees before agreeing. Ask support for a breakdown.",
  };
  return TIPS[type] || "Review this clause carefully before agreeing.";
}

// ===== SAFE CARDS =====
function buildSafeCards(clauses) {
  const safe = [];
  const safePatterns = [
    { re: /you may cancel at any time|cancel.*anytime|no.*cancellation fee/i, text: "You can cancel anytime without penalty." },
    { re: /we do not sell.*data|we never sell.*personal/i, text: "This service does not sell your personal data." },
    { re: /we do not share.*third.?party|no.*third.?party.*sharing/i, text: "Data is not shared with third parties." },
    { re: /30.day.*money.back|full refund.*30|money.back guarantee/i, text: "30-day money-back guarantee offered." },
    { re: /opt.out.*anytime|unsubscribe.*anytime/i, text: "You can opt out of communications anytime." },
    { re: /data.*deleted.*request|right.*erasure|right to be forgotten/i, text: "You have the right to request data deletion." },
    { re: /free trial.*cancel.*anytime|trial.*no.*charge/i, text: "Free trial with no charge if cancelled early." },
    { re: /no.*arbitration|right.*court|right.*jury/i, text: "Your right to sue in court is preserved." },
  ];
  const seen = new Set();
  clauses.forEach(c => {
    safePatterns.forEach(p => {
      if (!seen.has(p.text) && p.re.test(c)) { safe.push({ text: p.text }); seen.add(p.text); }
    });
  });
  return safe;
}

// ===== COMMUNITY LINKS =====
function buildCommunityLinks(risks, url) {
  let domain = "";
  try { domain = new URL(url).hostname.replace("www.", "").split(".")[0]; } catch {}
  if (!domain) return [];
  const company = domain.charAt(0).toUpperCase() + domain.slice(1);
  const links = [];
  if (risks.some(r => r.severity === "critical" || r.severity === "high")) {
    links.push({ url: `https://www.reddit.com/search/?q=${encodeURIComponent(domain + " terms service bad")}`, icon: "🔴", label: "Reddit Complaints", preview: `User experiences with ${company}` });
    links.push({ url: `https://www.trustpilot.com/review/${domain}.com`, icon: "⭐", label: "Trustpilot Reviews", preview: `Real customer ratings` });
    links.push({ url: `https://tosdr.org/#${domain}`, icon: "📖", label: "ToS;DR Rating", preview: `Community grading of ${company}'s ToS` });
    links.push({ url: `https://twitter.com/search?q=${encodeURIComponent(domain + " cancel subscription")}`, icon: "🐦", label: "X / Twitter", preview: `Cancellation experiences` });
  }
  return links;
}

// ===== PROCESS =====
function process(text, sourceUrl, linksScanned = 0, scanDuration = 0) {
  const cleaned = cleanText(text);
  const clauses = extractClauses(cleaned);
  const _textLength = text.length;

  const risks = [];
  const safeCards = buildSafeCards(clauses);
  const seenTypes = new Map();

  clauses.forEach(clause => {
    const cl = classify(clause);
    if (!cl || cl.severity === "safe") return;
    const displayText = clause.length > 140 ? clause.slice(0, 140) + "…" : clause;
    if (seenTypes.has(cl.type)) {
      const prev = seenTypes.get(cl.type);
      if (similarity(prev.text, displayText) > 0.65) return;
      if (cl.weight <= prev.weight) return;
      risks.splice(risks.indexOf(prev), 1);
    }
    seenTypes.set(cl.type, { type: cl.type, severity: cl.severity, text: displayText, tip: getTip(cl.type), weight: cl.weight, reason: cl.reason || "" });
    risks.push({
      type: cl.type,
      severity: cl.severity,
      text: displayText,
      tip: getTip(cl.type),
      weight: cl.weight,
      reason: cl.reason || ""
    });
  });

  const darkPatterns = detectDarkPatterns(text);
  const dpSeen = new Set();
  darkPatterns.forEach(dp => {
    if (dpSeen.has(dp.name)) return;
    dpSeen.add(dp.name);
    if (!risks.some(r => r.type === dp.name && similarity(r.text, dp.quote) > 0.70)) {
      risks.push({ type: dp.name, severity: dp.severity, text: dp.quote.slice(0, 140), tip: dp.tip, counter: dp.counter, weight: WEIGHTS[dp.name] || 2, reason: dp.reason || "" });
    }
  });

  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  risks.sort((a, b) => {
    const sd = (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4);
    return sd !== 0 ? sd : (b.weight || 0) - (a.weight || 0);
  });

  let scoreRaw = 0;
  risks.forEach(r => { scoreRaw += r.weight || 1; });

  // Trust bonus: well-known, established companies get a score reduction.
  // Their T&Cs may contain standard clauses (arbitration, auto-renew) that are industry-normal.
  // Suspicious/unknown domains get a score penalty on top of their clause score.
  let trustModifier = 0;
  let hostname = "";
  try { hostname = new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch {}
  if (TRUSTED_DOMAINS.has(hostname)) {
    trustModifier = -3; // well-known brand — lower raw score
  } else {
    const trust = assessDomainTrust(hostname);
    if (trust.suspicious) trustModifier = +4; // unknown suspicious domain — boost raw score
  }
  scoreRaw = Math.max(0, scoreRaw + trustModifier);

  const score = Math.min(10, Math.round(10 * (1 - Math.exp(-scoreRaw / 8))));

  const summarySet = new Set();
  risks.forEach(r => {
    if (r.type.includes("Auto Billing") || r.type.includes("Auto-Renewal")) summarySet.add("⚠️ Subscription auto-renews unless cancelled");
    if (r.type.includes("Data Selling")) summarySet.add("🚨 This service may sell your personal data");
    if (r.type.includes("Data Sharing (Marketing)")) summarySet.add("🔓 Data shared with advertising partners");
    if (r.type.includes("Hidden Conditions")) summarySet.add("📋 Key conditions hidden in fine print");
    if (r.type.includes("Fee") || r.type.includes("Fees")) summarySet.add("💸 Extra charges or no-refund clauses present");
    if (r.type.includes("Cancellation")) summarySet.add("🚪 Cancellation requires offline steps");
    if (r.type.includes("Arbitration")) summarySet.add("⚖️ Court action waived — arbitration only");
    if (r.type.includes("Confirmshaming")) summarySet.add("🎭 Guilt-based opt-out wording detected");
    if (r.type.includes("Service Termination")) summarySet.add("🚫 Account can be suspended at company's discretion");
  });

  const highConfidence = _textLength >= 2000 && clauses.length >= 3;
  if (highConfidence) {
    if (score <= 3) summarySet.add("✅ No major harmful clauses found");
    if (![...summarySet].some(s => s.includes("sell") || s.includes("advertis"))) {
      if (score <= 5) summarySet.add("✅ No concerning data-sharing clauses");
    }
    if (![...summarySet].some(s => s.includes("auto-renew"))) {
      if (score <= 4) summarySet.add("✅ No auto-renewal traps detected");
    }
  }

  const weakLegal = _textLength < 1000;

  return {
    score, risks, safeCards,
    summary: [...summarySet],
    darkPatterns: darkPatterns.length,
    linksScanned, scanDuration,
    timestamp: Date.now(),
    sourceUrl, communityLinks: buildCommunityLinks(risks, sourceUrl),
    _textLength, weakLegal,
    domainSafety: null, // filled in after async Safe Browsing check
    // Store full text for AI features
    _fullText: text.slice(0, 25000)
  };
}

// ===== SAFE FETCH =====
async function safeFetch(url, cancelSignal) {
  if (cancelSignal?.aborted) return "";
  try {
    const timeoutCtrl = new AbortController();
    const t = setTimeout(() => timeoutCtrl.abort(), 8000);
    const signal = cancelSignal ? anySignal([cancelSignal, timeoutCtrl.signal]) : timeoutCtrl.signal;
    const res = await fetch(url, { credentials: "omit", signal });
    clearTimeout(t);
    if (cancelSignal?.aborted) return "";
    if (!res || !res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

function anySignal(signals) {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

// ===== AI CHAT VIA OPENROUTER =====
// 🔑 API key is set at top of file — ctrl+f: "OPENROUTER_API_KEY"
async function askAI(userMessage, tcContext) {
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.startsWith("YOUR_") || OPENROUTER_API_KEY === "") {
    return "⚠️ No API key set. Add your OpenRouter API key in background.js (ctrl+f: OPENROUTER_API_KEY).";
  }
  try {
    const systemPrompt = `You are ClearSign AI, an expert legal document assistant.

Your job is to help users understand Terms & Conditions accurately.

RULES:

1. Give complete and direct answers, not incomplete summaries.
2. Explain relevant clauses in simple English.
3. When answering, include important conditions, exceptions, fees, deadlines and consequences.
4. Use the actual document text as your primary source.
5. Never invent rights, policies or obligations.
6. If information is missing, explicitly say "Not clearly specified in the provided document."
7. If multiple clauses relate to a question, consider all of them together.
8. Distinguish between selling personal data and sharing data with third parties.
9. When possible, quote the relevant clause and explain what it means in practice.
10. Answer in 4–7 sentences when the question requires detail.

11. Never make a definitive claim based on incomplete document text.
12. If a relevant section is missing or truncated, explicitly inform the user.
13. Never confuse data selling, data sharing, and data processing. Explain each separately.
14. For privacy questions, examine all available clauses relating to personal data, third-party sharing, advertising, analytics, and data sales.
15. For cancellation questions, check cancellation procedures, effective dates, automatic renewal, trial periods, refunds, and cancellation fees.
16. For billing questions, explain recurring payments, renewal dates, price changes, and payment obligations.
17. If multiple sections provide relevant information, combine them into one coherent answer without repeating information.
18. Never assume that something is permitted or prohibited simply because the document does not mention it.
19. Do not stop halfway through a sentence, paragraph, or bullet point.
20. End every answer with a clear conclusion that directly addresses the user's question.

RESPONSE STYLE:
- Use simple, professional English.
- Use bullet points when explaining multiple conditions.
- Highlight important warnings.
- Avoid unnecessary legal jargon.
- Be concise but never sacrifice important information for brevity.
- Always distinguish between what the document explicitly states and what cannot be confirmed from the available text.

TERMS AND CONDITIONS:
---
${tcContext || "No document text available."}
---

Answer the user's question accurately and completely.`;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "chrome-extension://clearsign",
        "X-Title": "ClearSign"
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: 800,
        temperature: 0.3
      })
    });
    const data = await res.json();
console.log("AI Finish Reason:", data.choices?.[0]?.finish_reason);
console.log("AI Token Usage:", data.usage);
    if (data.error) return `⚠️ AI error: ${data.error.message}`;
    return data.choices?.[0]?.message?.content?.trim() || "No response from AI.";
  } catch (e) {
    return `⚠️ Connection error: ${e.message}`;
  }
}

// ===== WATCHDOG =====
function addToWatchdog(domain, analysis) {
  chrome.storage.local.get(["watchdog"], (result) => {
    const w = result.watchdog || {};
    w[domain] = { lastScore: analysis.score, lastAnalyzed: Date.now(), risks: analysis.risks.length, summary: analysis.summary };
    chrome.storage.local.set({ watchdog: w });
  });
}

// ===== MESSAGE HANDLER =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "ANALYZE") {
    (async () => {
      const result = process(msg.payload.text, msg.payload.url, 0);
      result.domainSafety = await checkDomainSafety(msg.payload.url);
      chrome.storage.local.set({ analysis: result });
      try { addToWatchdog(new URL(msg.payload.url).hostname, result); } catch {}
      sendResponse({ done: true });
    })();
    return true;
  }

  if (msg.type === "DEEP_ANALYZE") {
    const cancelCtrl = new AbortController();
    deepScanController = cancelCtrl;
    const scanStart = Date.now();

    (async () => {
      const mainText = String(msg.payload.text || "").slice(0, 50000);
      const links = (Array.isArray(msg.payload.links) ? msg.payload.links : []).slice(0, 4);
      const documents = [{
        id: "document_1",
        source: "Terms and Conditions",
        url: msg.payload.url || "",
        label: "Current page",
        text: mainText
      }];
      let linksScanned = 0;

      const sendProgress = step => chrome.runtime.sendMessage({ type: "ANALYSIS_PROGRESS", step }).catch(() => {});
      sendProgress("Scanning main page...");

      for (const item of links) {
        if (cancelCtrl.signal.aborted || Date.now() - scanStart > 20000) break;
        const link = typeof item === "string" ? { url: item, label: "Linked policy" } : item;
        if (!link || typeof link.url !== "string") continue;
        sendProgress(`Fetching linked policy ${linksScanned + 1}/${links.length}...`);
        const html = await safeFetch(link.url, cancelCtrl.signal);
        if (html.length > 300) {
          const linkedText = stripHTML(html).slice(0, 50000);
          if (linkedText.length >= 100) {
            const label = String(link.label || "Linked policy").slice(0, 120);
            const lower = `${label} ${link.url}`.toLowerCase();
            let source = /privacy|personal data|data protection/.test(lower) ? "Privacy Policy"
              : /cookie/.test(lower) ? "Cookie Policy"
              : /term|condition|agreement/.test(lower) ? "Terms and Conditions"
              : "Linked Policy";
            documents.push({
              id: `document_${documents.length + 1}`,
              source,
              label,
              url: link.url,
              text: linkedText
            });
            linksScanned++;
          }
        }
      }

      deepScanController = null;
      if (cancelCtrl.signal.aborted) { sendResponse({ cancelled: true }); return; }

      sendProgress("Classifying clauses...");
      const combinedText = documents.map(doc => `\n\n[${doc.source}: ${doc.url}]\n${doc.text}`).join("\n").slice(0, 100000);
      const duration = ((Date.now() - scanStart) / 1000).toFixed(1);
      const result = process(combinedText, msg.payload.url, linksScanned, parseFloat(duration));
      result._fullText = mainText.slice(0, 25000);
      result._documents = documents;

      // Domain safety check (runs in parallel with storage write)
      sendProgress("Checking domain safety...");
      result.domainSafety = await checkDomainSafety(msg.payload.url);

      chrome.storage.local.set({ analysis: result });
      try { addToWatchdog(new URL(msg.payload.url).hostname, result); } catch {}
      sendResponse({ done: true });
    })();
    return true;
  }

  if (msg.type === "CANCEL_ANALYZE") {
    if (deepScanController) { deepScanController.abort(); deepScanController = null; }
    sendResponse({ done: true });
    return true;
  }

  if (msg.type === "REANALYZE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) { sendResponse({ error: "No active tab" }); return; }
      const tabId = tabs[0].id;
      const tabUrl = tabs[0].url || "";

      // Step 1: try to inject detect.js fresh (no-op if already there, safe to re-inject)
      chrome.scripting.executeScript({ target: { tabId }, files: ["detect.js"] })
        .catch(() => {}) // ignore errors (e.g. chrome:// pages)
        .finally(() => {
          // Step 2: ask detect.js to re-analyze
          chrome.tabs.sendMessage(tabId, { type: "REQUEST_REANALYZE" }, resp => {
            if (!chrome.runtime.lastError && resp?.done) {
              sendResponse({ done: true });
              return;
            }
            // Step 3: fallback — grab text directly and run analysis here in background
            chrome.scripting.executeScript({
              target: { tabId },
              func: () => ({
                text: document.body?.innerText?.slice(0, 50000) || "",
                url: location.href
              })
            }, async results => {
              if (chrome.runtime.lastError || !results?.[0]?.result) {
                sendResponse({ error: "Could not read page. Try reloading the tab first." });
                return;
              }
              const { text, url } = results[0].result;
              const result = process(text, url || tabUrl, 0, 0);
              result.domainSafety = await checkDomainSafety(url || tabUrl);
              chrome.storage.local.set({ analysis: result });
              try { addToWatchdog(new URL(url || tabUrl).hostname, result); } catch {}
              sendResponse({ done: true });
            });
          });
        });
    });
    return true;
  }

  if (msg.type === "CLEAR_ANALYSIS") {
    chrome.storage.local.remove("analysis", () => sendResponse({ done: true }));
    return true;
  }

  if (msg.type === "GET_WATCHDOG") {
    chrome.storage.local.get(["watchdog"], r => sendResponse({ watchdog: r.watchdog || {} }));
    return true;
  }

  // ===== AI CHAT MESSAGE =====
  if (msg.type === "AI_CHAT") {
    chrome.storage.local.get(["analysis"], async result => {
      const context = result.analysis?._fullText || "";
      const reply = await askAI(msg.question, context);
      sendResponse({ reply });
    });
    return true; // async
  }

  return false;
});

console.log("[Background] ClearSign v14 loaded");