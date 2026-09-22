// Jevitate UI — vanilla-JS SPA for the local `jevitate ui` inbox dashboard.
// Served same-origin at /app.js (CSP: default-src 'self' — no inline script,
// no inline event handlers; everything here is wired with addEventListener).
(function () {
  "use strict";

  var TOKEN_HEADER = "x-jevitate-token";
  var POLL_MS = 4000;

  /** Read `?t=` once, then scrub it from the visible URL. The server has
   *  already set the auth cookie from this same query param on `GET /`, so
   *  same-origin fetches carry it automatically — the header below is sent
   *  on every request too, for robustness (belt and suspenders, not the
   *  only mechanism). */
  var token = "";
  (function initToken() {
    var params = new URLSearchParams(window.location.search);
    var t = params.get("t");
    if (t) {
      token = t;
      params.delete("t");
      var qs = params.toString();
      var newUrl = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
      window.history.replaceState({}, "", newUrl);
    }
  })();

  var els = {
    queueScreen: document.getElementById("screen-queue"),
    detailScreen: document.getElementById("screen-detail"),
    queueList: document.getElementById("queue-list"),
    queueCount: document.getElementById("queue-count"),
    detailRoot: document.getElementById("detail-root"),
    backLink: document.getElementById("back-link"),
    toast: document.getElementById("toast"),
  };

  var state = {
    view: "queue", // "queue" | "detail"
    detailId: null,
    pollTimer: null,
  };

  // ---------------------------------------------------------------- utils

  function escapeHtml(value) {
    var s = String(value == null ? "" : value);
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString(undefined, { hour12: false });
  }

  var toastTimer = null;
  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.hidden = true;
    }, 3200);
  }

  function apiFetch(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    headers[TOKEN_HEADER] = token;
    return fetch(path, Object.assign({}, options, { headers: headers, credentials: "same-origin" }));
  }

  // ------------------------------------------------------------ kind meta

  var KIND_META = {
    handback: { label: "HANDBACK", color: "var(--cyan)", ledClass: "led-c" },
    approval: { label: "APPROVAL", color: "var(--magenta)", ledClass: "led-m" },
    review: { label: "REVIEW", color: "var(--amber)", ledClass: "led-y" },
  };

  /** Transition semantics (mirrors `resolveTransition` in @jevitate/inbox):
   *  approval -> approve/reject; handback -> resume/reject (+ provide-input,
   *  which appends a thread entry rather than resolving); review ->
   *  approve/reject. `view` opens the detail screen for every kind. */
  var ACTIONS_BY_KIND = {
    handback: ["resume", "input", "reject", "view"],
    approval: ["approve", "reject", "view"],
    review: ["approve", "reject", "view"],
  };

  var ACTION_LABEL = {
    approve: "Approve",
    reject: "Reject",
    resume: "Resume",
    input: "Provide input",
    view: "View",
  };

  var RESOLVED_TOAST = {
    approve: "approved",
    reject: "rejected",
    resume: "resumed",
  };

  function actionButtonClass(action) {
    if (action === "approve" || action === "resume") return "btn-primary";
    if (action === "reject") return "btn-ghost-w";
    return "btn-ghost-c"; // input, view
  }

  // ------------------------------------------------------------- queue UI

  function emptyStateHtml() {
    return (
      '<div class="empty-state">' +
      '<h2 class="disp">NO PENDING ITEMS</h2>' +
      '<div class="mono sub">[ waiting for handbacks&hellip; <span class="cursor-blink" style="color:var(--cyan)">&#9608;</span> ]</div>' +
      '<p class="body-txt">Runs will hand back here when an agent needs you.</p>' +
      "</div>"
    );
  }

  function cardHtml(item) {
    var meta = KIND_META[item.kind] || KIND_META.approval;
    var actions = ACTIONS_BY_KIND[item.kind] || ["view"];
    var buttons = actions
      .map(function (action) {
        return (
          '<button type="button" class="' +
          actionButtonClass(action) +
          '" data-action="' +
          action +
          '" data-id="' +
          escapeHtml(item.id) +
          '">' +
          ACTION_LABEL[action] +
          "</button>"
        );
      })
      .join("");

    return (
      '<article class="card" data-id="' +
      escapeHtml(item.id) +
      '">' +
      '<div class="card-top">' +
      '<span class="badge" style="border-color:' +
      meta.color +
      '"><span class="led ' +
      meta.ledClass +
      '"></span><span class="mono" style="color:' +
      meta.color +
      '">[' +
      meta.label +
      "]</span></span>" +
      '<span class="mono eyebrow">[RUN ' +
      escapeHtml(item.run) +
      "]</span>" +
      "</div>" +
      '<h2 class="head card-title">' +
      escapeHtml(item.step) +
      "</h2>" +
      '<div class="card-meta">' +
      "<span>[JOURNEY] <strong>" +
      escapeHtml(item.journey) +
      "</strong></span>" +
      '<span>[AGENT] <span class="agent">' +
      escapeHtml(item.agent) +
      "</span></span>" +
      "</div>" +
      '<div class="card-actions">' +
      buttons +
      "</div>" +
      "</article>"
    );
  }

  function renderQueue(items) {
    els.queueCount.textContent = String(items.length).padStart(2, "0");
    if (items.length === 0) {
      els.queueList.innerHTML = emptyStateHtml();
      return;
    }
    els.queueList.innerHTML = items.map(cardHtml).join("");
  }

  function loadQueue() {
    return apiFetch("/api/inbox")
      .then(function (res) {
        if (!res.ok) throw new Error("inbox_fetch_failed");
        return res.json();
      })
      .then(function (data) {
        var items = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : [];
        if (state.view === "queue") renderQueue(items);
        return items;
      })
      .catch(function () {
        // Best-effort poll — a transient failure should not crash the SPA.
      });
  }

  // ------------------------------------------------------------ detail UI

  function screenshotPlaceholderHtml() {
    return (
      '<div class="screenshot-placeholder">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18"></rect>' +
      '<circle cx="8.5" cy="8.5" r="1.5"></circle>' +
      '<path d="M21 15l-5-5L5 21"></path>' +
      "</svg>" +
      '<span class="mono">[ NO SNAPSHOT ]</span>' +
      "</div>"
    );
  }

  function threadHtml(thread) {
    if (!thread || thread.length === 0) return '<div class="mono eyebrow">[ no messages ]</div>';
    return (
      '<div class="thread">' +
      thread
        .map(function (entry) {
          var cls = entry.author === "human" ? "thread-entry human" : "thread-entry";
          return (
            '<div class="' +
            cls +
            '"><div class="who mono">[' +
            escapeHtml(entry.author).toUpperCase() +
            " &middot; " +
            escapeHtml(formatTime(entry.at)) +
            ']</div><div class="body-txt">' +
            escapeHtml(entry.text) +
            "</div></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function findingsHtml(findings) {
    if (!findings || findings.length === 0) return "";
    return (
      '<div class="section-label mono">[FINDINGS]</div>' +
      '<div class="findings">' +
      findings
        .map(function (f) {
          return (
            '<div class="finding ' +
            escapeHtml(f.severity) +
            '"><div class="title">[' +
            escapeHtml(f.severity).toUpperCase() +
            "] " +
            escapeHtml(f.title) +
            "</div>" +
            (f.evidence ? '<div class="evidence mono">' + escapeHtml(f.evidence) + "</div>" : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function detailActionsHtml(item) {
    var actions = (ACTIONS_BY_KIND[item.kind] || []).filter(function (a) {
      return a !== "view"; // already viewing
    });
    return actions
      .map(function (action) {
        return (
          '<button type="button" class="' +
          actionButtonClass(action) +
          '" data-action="' +
          action +
          '" data-id="' +
          escapeHtml(item.id) +
          '">' +
          ACTION_LABEL[action] +
          "</button>"
        );
      })
      .join("");
  }

  function renderDetail(item) {
    var meta = KIND_META[item.kind] || KIND_META.approval;
    var glow = item.kind === "handback" ? "glow-c" : "glow-m";

    var left =
      '<div>' +
      '<span class="badge" style="border-color:' +
      meta.color +
      '"><span class="led ' +
      meta.ledClass +
      '"></span><span class="mono" style="color:' +
      meta.color +
      '">[' +
      meta.label +
      "]</span></span>" +
      '<h2 class="disp ' +
      glow +
      ' detail-title">' +
      escapeHtml(item.step) +
      "</h2>" +
      (item.targetUrl
        ? '<div class="mono detail-url"><a href="' +
          escapeHtml(item.targetUrl) +
          '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(item.targetUrl) +
          "</a></div>"
        : "") +
      '<div class="mono detail-meta">' +
      "<span>[JOURNEY] <strong>" +
      escapeHtml(item.journey) +
      "</strong></span>" +
      "<span>[RUN] <strong>" +
      escapeHtml(item.run) +
      "</strong></span>" +
      '<span>[AGENT] <span class="agent" style="color:var(--cyan)">' +
      escapeHtml(item.agent) +
      "</span></span>" +
      "<span>[CREATED] <strong>" +
      escapeHtml(formatTime(item.createdAt)) +
      "</strong></span>" +
      "</div>" +
      '<p class="body-txt detail-reason">' +
      escapeHtml(item.reason) +
      "</p>" +
      findingsHtml(item.findings) +
      '<div class="section-label mono">[THREAD]</div>' +
      threadHtml(item.thread) +
      '<div class="section-label mono">[PROVIDE INPUT]</div>' +
      '<textarea class="ta" id="input-textarea" rows="4" placeholder="type a reply or the value the agent needs…"></textarea>' +
      '<div class="detail-actions">' +
      detailActionsHtml(item) +
      "</div>" +
      "</div>";

    var right =
      '<div>' +
      '<div class="browser-frame">' +
      '<div class="browser-chrome">' +
      '<span class="led" style="background:var(--red)"></span>' +
      '<span class="led" style="background:var(--amber)"></span>' +
      '<span class="led" style="background:var(--green)"></span>' +
      '<span class="mono chrome-url">' +
      escapeHtml(item.targetUrl || "no target") +
      "</span>" +
      "</div>" +
      '<div class="screenshot-body" id="screenshot-body">' +
      '<img id="screenshot-img" src="/api/inbox/' +
      encodeURIComponent(item.id) +
      '/screenshot" alt="Step snapshot" />' +
      "</div>" +
      "</div>" +
      '<div class="mono screenshot-caption">[SNAPSHOT &middot; ' +
      escapeHtml(item.step) +
      "]</div>" +
      "</div>";

    els.detailRoot.innerHTML = left + right;

    // Always attempt the fetch and rely on the `error` event (never inline
    // `onerror=`, per CSP) to swap in the placeholder — covers both a
    // missing file (server 404s) and `hasScreenshot: false` alike.
    var img = document.getElementById("screenshot-img");
    if (img) {
      img.addEventListener("error", function onErr() {
        var body = document.getElementById("screenshot-body");
        if (body) body.innerHTML = screenshotPlaceholderHtml();
      });
    }
  }

  function openDetail(id) {
    return apiFetch("/api/inbox/" + encodeURIComponent(id))
      .then(function (res) {
        if (res.status === 404) {
          showToast("item no longer available");
          return loadQueue().then(showQueueView);
        }
        if (!res.ok) throw new Error("detail_fetch_failed");
        return res.json().then(function (item) {
          state.view = "detail";
          state.detailId = id;
          renderDetail(item);
          els.queueScreen.hidden = true;
          els.detailScreen.hidden = false;
        });
      })
      .catch(function () {
        showToast("could not load item");
      });
  }

  function showQueueView() {
    state.view = "queue";
    state.detailId = null;
    els.detailScreen.hidden = true;
    els.queueScreen.hidden = false;
    loadQueue();
  }

  // ------------------------------------------------------------- actions

  function performAction(id, action) {
    if (action === "view") {
      openDetail(id);
      return;
    }

    // "Provide input" needs the textarea, which only exists on the detail
    // screen — from a queue card, route there first instead of submitting
    // an empty value.
    if (action === "input" && (state.view !== "detail" || state.detailId !== id)) {
      openDetail(id);
      return;
    }

    var body = {};
    if (action === "input") {
      var ta = document.getElementById("input-textarea");
      var text = ta ? ta.value.trim() : "";
      if (!text) {
        showToast("type something first");
        return;
      }
      body.input = text;
    } else if (action === "resume") {
      var resumeTa = document.getElementById("input-textarea");
      var resumeText = resumeTa ? resumeTa.value.trim() : "";
      if (resumeText) body.input = resumeText;
    }

    apiFetch("/api/inbox/" + encodeURIComponent(id) + "/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (res.status === 409) {
          showToast("already resolved");
          return refreshCurrentView();
        }
        if (res.status === 404) {
          showToast("item no longer available");
          return refreshCurrentView();
        }
        if (!res.ok) {
          showToast("action failed");
          return;
        }
        if (action === "input") {
          showToast("input sent");
          return openDetail(id);
        }
        showToast(RESOLVED_TOAST[action] || "done");
        return showQueueView();
      })
      .catch(function () {
        showToast("network error");
      });
  }

  function refreshCurrentView() {
    if (state.view === "detail" && state.detailId) return openDetail(state.detailId);
    return showQueueView();
  }

  // -------------------------------------------------------------- events

  els.queueList.addEventListener("click", function (ev) {
    var target = ev.target;
    while (target && target !== els.queueList) {
      if (target.tagName === "BUTTON" && target.dataset.action) {
        performAction(target.dataset.id, target.dataset.action);
        return;
      }
      target = target.parentElement;
    }
  });

  els.detailRoot.addEventListener("click", function (ev) {
    var target = ev.target;
    while (target && target !== els.detailRoot) {
      if (target.tagName === "BUTTON" && target.dataset.action) {
        performAction(target.dataset.id, target.dataset.action);
        return;
      }
      target = target.parentElement;
    }
  });

  els.backLink.addEventListener("click", function () {
    showQueueView();
  });

  // --------------------------------------------------------------- init

  showQueueView();
  state.pollTimer = setInterval(function () {
    loadQueue();
  }, POLL_MS);
})();
