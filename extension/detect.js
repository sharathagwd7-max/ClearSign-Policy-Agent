// detect.js - ClearSign v14
// Guard: prevent double-injection crash when background re-injects this file
if (!window.__csLoaded) {
window.__csLoaded = true;

let currentUrl = location.href;
let buttonInjected = false;
let isAnalyzing = false;
let activeProgressListener = null;

// ===== LEGAL PAGE DETECTION =====
function legalPageScore() {
  const url = location.href.toLowerCase();
  const title = document.title.toLowerCase();
  const body = document.body?.innerText || "";
  const bodyLower = body.slice(0, 3000).toLowerCase();
  let score = 0;

  if (/terms|privacy|policy|agreement|legal|tos|conditions/.test(url)) score += 2;
  if (/terms|privacy|policy|agreement|legal/.test(title)) score += 2;
  if (body.length > 3000) score += 1;

  const indicators = ["terms and conditions","terms of service","privacy policy","user agreement",
    "end user license","cookie policy","data protection","subscription terms","billing agreement"];
  for (const ind of indicators) { if (bodyLower.includes(ind)) { score += 2; break; } }

  if (findPolicyLinks().length > 0) score += 2;
  return score;
}

function isLegalPage() { return legalPageScore() >= 3; }

function findPolicyLinks() {
  const links = [];
  document.querySelectorAll("a").forEach(el => {
    const label = (el.innerText || el.getAttribute("aria-label") || el.title || "").trim();
    const text = label.toLowerCase();
    const href = (el.href || "").trim();
    let score = 0;
    if (/terms|conditions|agreement/.test(text)) score += 50;
    if (/privacy|data|cookie/.test(text)) score += 50;
    if (/legal|policy/.test(text)) score += 30;
    if (/terms|privacy|policy/.test(href)) score += 40;
    if (text === "terms" || text === "privacy") score += 20;
    if (score > 40 && href.startsWith("http")) {
      try {
        const parsed = new URL(href);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          links.push({ url: parsed.href, label: label || "Linked policy", score });
        }
      } catch {}
    }
  });
  const unique = [...new Map(links.map(link => [link.url, link])).values()];
  unique.sort((a, b) => b.score - a.score);
  return unique.slice(0, 4).map(({ url, label }) => ({ url, label }));
}

function removeButton() {
  const existing = document.getElementById("cs-btn");
  if (existing) { existing.remove(); buttonInjected = false; }
}

// ===== DRAGGABLE BUTTON =====
function makeDraggable(btn) {
  let isDragging = false, hasDragged = false, startX, startY, origX, origY;

  btn.addEventListener("mousedown", e => {
    isDragging = true; hasDragged = false;
    startX = e.clientX; startY = e.clientY;
    const r = btn.getBoundingClientRect();
    origX = r.left; origY = r.top;
    btn.style.transition = "none";
    btn.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", e => {
    if (!isDragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged = true;
    btn.style.left = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, origX + dx)) + "px";
    btn.style.top  = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, origY + dy)) + "px";
    btn.style.right = "auto"; btn.style.bottom = "auto";
  });

  document.addEventListener("mouseup", e => {
    if (!isDragging) return;
    isDragging = false;
    btn.style.cursor = "pointer";
    btn.style.transition = "box-shadow 0.2s, transform 0.2s";
    if (btn.style.left) chrome.storage.local.set({ btnPos: { left: btn.style.left, top: btn.style.top } });
    btn._wasDrag = hasDragged;
    if (hasDragged) e.stopImmediatePropagation();
  });

  btn.addEventListener("touchstart", e => {
    const t = e.touches[0];
    isDragging = true; hasDragged = false;
    startX = t.clientX; startY = t.clientY;
    const r = btn.getBoundingClientRect();
    origX = r.left; origY = r.top;
    btn.style.transition = "none";
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!isDragging) return;
    const t = e.touches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged = true;
    btn.style.left = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, origX + dx)) + "px";
    btn.style.top  = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, origY + dy)) + "px";
    btn.style.right = "auto"; btn.style.bottom = "auto";
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!isDragging) return;
    isDragging = false;
    btn.style.transition = "box-shadow 0.2s, transform 0.2s";
    btn._wasDrag = hasDragged;
    if (btn.style.left) chrome.storage.local.set({ btnPos: { left: btn.style.left, top: btn.style.top } });
  });
}

function inject() {
  if (buttonInjected) return;
  if (!isLegalPage()) return;
  removeButton();

  const btn = document.createElement("button");
  btn.id = "cs-btn";
  btn.title = "Drag to reposition · Click to analyze";

  btn.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    background: linear-gradient(135deg, #E24B4A 0%, #c0392b 100%);
    color: white;
    padding: 13px 22px;
    border: none;
    border-radius: 50px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    box-shadow: 0 6px 20px rgba(226,75,74,0.45), 0 2px 6px rgba(0,0,0,0.15);
    transition: box-shadow 0.2s, transform 0.2s;
    user-select: none;
    letter-spacing: 0.3px;
    display: flex;
    align-items: center;
    gap: 7px;
  `;

  btn.innerHTML = `<span style="font-size:15px;">🔍</span><span>Analyze T&amp;C</span>`;

  chrome.storage.local.get(["btnPos"], result => {
    if (result.btnPos?.left && result.btnPos?.top) {
      const left = parseFloat(result.btnPos.left), top = parseFloat(result.btnPos.top);
      if (left >= 0 && left < window.innerWidth && top >= 0 && top < window.innerHeight) {
        btn.style.left = result.btnPos.left;
        btn.style.top  = result.btnPos.top;
        btn.style.right = "auto"; btn.style.bottom = "auto";
      }
    }
  });

  btn.onmouseenter = () => { if (!isAnalyzing) btn.style.transform = "scale(1.05) translateY(-1px)"; };
  btn.onmouseleave = () => { if (!isAnalyzing) btn.style.transform = "scale(1) translateY(0)"; };

  btn.onclick = e => {
    if (btn._wasDrag) { btn._wasDrag = false; return; }
    if (isAnalyzing) return;

    isAnalyzing = true;

    if (activeProgressListener) {
      chrome.runtime.onMessage.removeListener(activeProgressListener);
      activeProgressListener = null;
    }

    activeProgressListener = msg => {
      if (msg.type === "ANALYSIS_PROGRESS" && isAnalyzing) {
        btn.querySelector("span:last-child").textContent = msg.step;
      }
    };
    chrome.runtime.onMessage.addListener(activeProgressListener);

    btn.innerHTML = `<span style="font-size:14px">⏳</span><span>Scanning...</span><span style="font-size:10px;opacity:0.8;margin-left:4px;">tap to cancel</span>`;
    btn.style.background = "linear-gradient(135deg, #f39c12 0%, #e67e22 100%)";
    btn.style.boxShadow = "0 6px 20px rgba(243,156,18,0.4)";

    let cancelled = false;
    const cancelHandler = ev => {
      ev.stopImmediatePropagation();
      if (!isAnalyzing) return;
      cancelled = true;
      chrome.runtime.sendMessage({ type: "CANCEL_ANALYZE" });
      btn.innerHTML = `<span>✕</span><span>Cancelling...</span>`;
      btn.removeEventListener("click", cancelHandler);
    };
    btn.addEventListener("click", cancelHandler);

    const text = document.body.innerText.slice(0, 50000);
    const links = findPolicyLinks();

    chrome.runtime.sendMessage({ type: "DEEP_ANALYZE", payload: { text, links, url: location.href } }, resp => {
      btn.removeEventListener("click", cancelHandler);
      if (activeProgressListener) {
        chrome.runtime.onMessage.removeListener(activeProgressListener);
        activeProgressListener = null;
      }
      isAnalyzing = false;

      if (cancelled || resp?.cancelled) {
        resetBtn();
      } else {
        btn.style.background = "linear-gradient(135deg, #27ae60 0%, #219a52 100%)";
        btn.style.boxShadow = "0 6px 20px rgba(39,174,96,0.4)";
        btn.innerHTML = `<span>✓</span><span>Done!</span>`;
        setTimeout(resetBtn, 2200);
      }
    });

    function resetBtn() {
      btn.style.background = "linear-gradient(135deg, #E24B4A 0%, #c0392b 100%)";
      btn.style.boxShadow = "0 6px 20px rgba(226,75,74,0.45), 0 2px 6px rgba(0,0,0,0.15)";
      btn.innerHTML = `<span style="font-size:15px;">🔍</span><span>Analyze T&amp;C</span>`;
    }
  };

  makeDraggable(btn);
  document.body.appendChild(btn);
  buttonInjected = true;
}

// Reanalyze from popup refresh
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "REQUEST_REANALYZE") {
    chrome.runtime.sendMessage({
      type: "DEEP_ANALYZE",
      payload: { text: document.body.innerText.slice(0, 50000), links: findPolicyLinks(), url: location.href }
    }, () => sendResponse({ done: true }));
    return true;
  }
});

// URL change tracking
function checkUrlChange() {
  const newUrl = location.href;
  if (newUrl !== currentUrl) {
    currentUrl = newUrl;
    if (!isLegalPage()) removeButton();
    else { buttonInjected = false; inject(); }
  }
}

window.addEventListener("popstate", checkUrlChange);
window.addEventListener("hashchange", checkUrlChange);

window.addEventListener("resize", () => {
  const btn = document.getElementById("cs-btn");
  if (!btn || !btn.style.left) return;
  btn.style.left = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, parseFloat(btn.style.left))) + "px";
  btn.style.top  = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, parseFloat(btn.style.top))) + "px";
});

(function() {
  const _push = history.pushState.bind(history), _replace = history.replaceState.bind(history);
  history.pushState = (...a) => { _push(...a); setTimeout(checkUrlChange, 100); };
  history.replaceState = (...a) => { _replace(...a); setTimeout(checkUrlChange, 100); };
})();

setInterval(checkUrlChange, 2000);

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(inject, 600));
else setTimeout(inject, 600);

} // end __csLoaded guard