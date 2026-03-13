let analysisData = null;
let selectedCategory = "dog";
let bankConnected = false;
let currentUser = null; // { id, name, email } or null
let prefetchedCategories = new Set();
let prefetchPollTimer = null;
const analysisCache = {}; // category -> API response, avoids redundant LLM calls
let islandOpen = false;
let islandTxnsLoaded = false;
let refinementStack = []; // stack of { query, data } for drill-down

const CATEGORIES = [
    { key: "dog", emoji: "\u{1F436}", label: "dog" },
    { key: "groceries", emoji: "\u{1F6D2}", label: "groceries" },
    { key: "coffee", emoji: "\u2615", label: "coffee" },
    { key: "restaurants", emoji: "\u{1F37D}\uFE0F", label: "restaurants" },
    { key: "rent", emoji: "\u{1F3E0}", label: "rent" },
    { key: "clothes", emoji: "\u{1F455}", label: "clothes" },
    { key: "rideshare", emoji: "\u{1F697}", label: "rideshare" },
    { key: "subscriptions", emoji: "\u{1F4F1}", label: "subscriptions" },
    { key: "travel", emoji: "\u2708\uFE0F", label: "travel" },
    { key: "fitness", emoji: "\u{1F4AA}", label: "fitness" },
    { key: "fast food", emoji: "\u{1F35F}", label: "fast food" },
    { key: "alcohol", emoji: "\u{1F377}", label: "alcohol" },
    { key: "hawaii", emoji: "\u{1F308}", label: "hawaii" },
    { key: "san francisco", emoji: "\u{1F309}", label: "san francisco" },
];

const CAROUSEL_EXAMPLES = [
    { emoji: "\u{1F37D}\uFE0F", label: "restaurants last week" },
    { emoji: "\u{1F697}", label: "uber in the last month" },
    { emoji: "\u{1F961}", label: "takeout on weekends" },
    { emoji: "\u{1F4E6}", label: "amazon purchases" },
    { emoji: "\u{1F4F1}", label: "subscriptions over $20" },
    { emoji: "\u2615", label: "coffee in san francisco" },
    { emoji: "\u2708\uFE0F", label: "flights to hawaii" },
    { emoji: "\u{1F6D2}", label: "groceries in january" },
    { emoji: "\u{1F35F}", label: "fast food last 3 months" },
    { emoji: "\u{1F377}", label: "alcohol this year" },
];

const CAT_ICONS = {
    // Pet-specific
    food_treats: "\u{1F9B4}", health_vet: "\u{1F3E5}", insurance: "\u{1F6E1}\uFE0F", grooming: "\u2702\uFE0F",
    supplies_toys: "\u{1F9F8}", boarding_daycare: "\u{1F3E0}", walking_sitting: "\u{1F6B6}",
    training: "\u{1F393}", other_pet: "\u{1F43E}",
    // General categories
    food: "\u{1F37D}\uFE0F", transport: "\u{1F697}", shopping: "\u{1F6CD}\uFE0F", housing: "\u{1F3E0}",
    entertainment: "\u{1F3AC}", health: "\u{1F48A}", utilities: "\u26A1", other: "\u{1F4CB}",
    // Common LLM-returned labels
    restaurant: "\u{1F37D}\uFE0F", restaurants: "\u{1F37D}\uFE0F", dining: "\u{1F37D}\uFE0F",
    clothing: "\u{1F455}", clothes: "\u{1F455}", apparel: "\u{1F455}",
    grocery: "\u{1F6D2}", groceries: "\u{1F6D2}", supermarket: "\u{1F6D2}",
    alcohol: "\u{1F377}", bar: "\u{1F37A}", drinks: "\u{1F378}",
    pharmacy: "\u{1F48A}", medical: "\u{1F3E5}", healthcare: "\u{1F3E5}",
    salon: "\u2702\uFE0F", beauty: "\u{1F484}", spa: "\u{1F9D6}",
    gas: "\u26FD", fuel: "\u26FD", gas_station: "\u26FD",
    coffee: "\u2615", cafe: "\u2615",
    rideshare: "\u{1F697}", uber: "\u{1F697}", lyft: "\u{1F697}", taxi: "\u{1F695}",
    travel: "\u2708\uFE0F", flights: "\u2708\uFE0F", hotel: "\u{1F3E8}", hotels: "\u{1F3E8}", lodging: "\u{1F3E8}",
    subscriptions: "\u{1F4F1}", subscription: "\u{1F4F1}", streaming: "\u{1F4FA}",
    fitness: "\u{1F4AA}", gym: "\u{1F3CB}\uFE0F",
    rent: "\u{1F3E0}", mortgage: "\u{1F3E0}",
    fast_food: "\u{1F35F}", fast_food_: "\u{1F35F}",
    electronics: "\u{1F4BB}", tech: "\u{1F4BB}", technology: "\u{1F4BB}",
    education: "\u{1F393}", books: "\u{1F4DA}",
    pets: "\u{1F43E}", pet: "\u{1F43E}", veterinary: "\u{1F3E5}",
    home: "\u{1F3E0}", home_improvement: "\u{1F528}", furniture: "\u{1F6CB}\uFE0F",
    auto: "\u{1F697}", car: "\u{1F697}", parking: "\u{1F17F}\uFE0F",
    gifts: "\u{1F381}", charity: "\u{1F49D}", donations: "\u{1F49D}",
    personal_care: "\u{1F9F4}", laundry: "\u{1F9FA}", cleaning: "\u{1F9F9}",
    childcare: "\u{1F476}", kids: "\u{1F476}",
    miscellaneous: "\u{1F4CB}", general: "\u{1F4CB}",
};

// ===== SCREENS =====
let screenHistory = [];
let handlingPopState = false;

function showScreen(id, { pushState = true } = {}) {
    // Close island if open when switching screens
    if (islandOpen) collapseIsland();

    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");

    if (pushState && !handlingPopState) {
        // Avoid duplicate pushes for same screen
        const current = history.state?.screen;
        if (current !== id) {
            history.pushState({ screen: id }, "", "");
            screenHistory.push(id);
        }
    }
}

window.addEventListener("popstate", (e) => {
    handlingPopState = true;

    // If island is open, close it on back
    if (islandOpen) {
        collapseIsland();
        // Re-push current state so we stay on the same screen
        const currentScreen = document.querySelector(".screen.active")?.id || "picker";
        history.pushState({ screen: currentScreen }, "", "");
        handlingPopState = false;
        return;
    }

    // If we have refinements stacked, pop one level
    const activeScreen = document.querySelector(".screen.active")?.id;
    if (activeScreen === "results" && refinementStack.length > 0) {
        const prev = refinementStack.pop();
        analysisData = prev.data;
        selectedCategory = prev.query;
        renderResults(analysisData);
        renderRefinementChain();
        updateTrackButton();
        handlingPopState = false;
        return;
    }

    const target = e.state?.screen;
    if (target) {
        showScreen(target, { pushState: false });
    } else {
        // No state — go to the default home screen
        if (activeScreen === "results") {
            showScreen("picker", { pushState: false });
        } else if (activeScreen === "loading") {
            showScreen("picker", { pushState: false });
        }
    }
    handlingPopState = false;
});

function showError(msg) {
    const box = document.getElementById("errorBox");
    box.textContent = msg;
    box.classList.add("show");
    setTimeout(() => box.classList.remove("show"), 4000);
}

function fmt(n) {
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtD(n) {
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ===== ROTATING WORDS =====
let rotateIdx = 0;
let rotateTimer = null;

function startRotation() {
    const wordEl = document.getElementById("rotatingWord");
    const emojiEl = document.getElementById("rotatingEmoji");
    if (!wordEl) return;

    rotateIdx = 0;

    rotateTimer = setInterval(() => {
        wordEl.classList.add("out");
        if (emojiEl) emojiEl.classList.add("out");
        setTimeout(() => {
            rotateIdx = (rotateIdx + 1) % CAROUSEL_EXAMPLES.length;
            wordEl.textContent = CAROUSEL_EXAMPLES[rotateIdx].label;
            if (emojiEl) emojiEl.textContent = CAROUSEL_EXAMPLES[rotateIdx].emoji;
            wordEl.classList.remove("out");
            wordEl.classList.add("in");
            if (emojiEl) emojiEl.classList.remove("out");
        }, 300);
    }, 2000);
}

function stopRotation() {
    clearInterval(rotateTimer);
}

// ===== AUTH =====
function initGoogleAuth() {
    if (!window.GOOGLE_CLIENT_ID) return;

    // Wait for Google GIS to load
    const check = setInterval(() => {
        if (window.google && google.accounts) {
            clearInterval(check);
            google.accounts.id.initialize({
                client_id: window.GOOGLE_CLIENT_ID,
                callback: handleGoogleCredential,
            });
            renderGoogleButton();
            renderAuthUI();
        }
    }, 200);
}

async function handleGoogleCredential(response) {
    try {
        const resp = await fetch("/api/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential: response.credential }),
        });
        const data = await resp.json();
        if (data.error) { showError(data.error); return; }
        currentUser = data.user;
        renderAuthUI();
        // If bank was already connected, go to picker; otherwise show onboarding
        const hasBanks = await checkBankAndProceed();
        if (!hasBanks) {
            showOnboarding();
        }
    } catch (e) {
        showError("Sign-in failed: " + e.message);
    }
}

function showOnboarding() {
    stopRotation();
    const firstName = currentUser ? currentUser.name.split(" ")[0] : "";
    document.getElementById("onboardingHello").textContent = firstName ? `hello, ${firstName}!` : "hello!";
    showScreen("onboarding");
}

async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    currentUser = null;
    renderGoogleButton();
    renderAuthUI();
    showScreen("welcome");
    startRotation();
}

function renderGoogleButton() {
    const container = document.getElementById("googleSignInBtn");
    if (!container || !window.google || !google.accounts) return;
    container.innerHTML = "";
    google.accounts.id.renderButton(container, {
        theme: "outline",
        size: "large",
        shape: "pill",
        width: 300,
    });
}

function renderAuthUI() {
    const googleBtn = document.getElementById("googleSignInBtn");
    const welcomeAuth = document.getElementById("welcomeAuth");

    if (currentUser) {
        if (googleBtn) googleBtn.style.display = "none";
        if (welcomeAuth) {
            welcomeAuth.innerHTML = `<p class="welcome-fine" style="margin-top:10px;">signed in as ${escapeHtml(currentUser.name)} &middot; <a href="#" onclick="signOut();return false;" class="auth-link">sign out</a></p>`;
        }
    } else {
        if (googleBtn) googleBtn.style.display = "flex";
        if (welcomeAuth) welcomeAuth.innerHTML = "";
    }

}

function triggerGoogleSignIn() {
    if (window.google && google.accounts) {
        google.accounts.id.prompt();
    }
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ===== PLAID =====
async function startPlaidLink() {
    if (!currentUser) { showError("Please sign in with Google first"); return; }
    try {
        const resp = await fetch("/api/create_link_token", { method: "POST" });
        const data = await resp.json();
        if (data.error) { showError(data.error); return; }

        const handler = Plaid.create({
            token: data.link_token,
            onSuccess: async (publicToken, metadata) => {
                try {
                    const exchResp = await fetch("/api/exchange_token", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            public_token: publicToken,
                            institution_name: metadata.institution?.name || "Bank",
                        }),
                    });
                    const exchData = await exchResp.json();
                    if (exchData.error) { showError(exchData.error); return; }
                    bankConnected = true;
                    stopRotation();

                    showCategoryPicker();
                } catch (e) {
                    showError("Failed to connect: " + e.message);
                }
            },
            onExit: () => {},
        });
        handler.open();
    } catch (e) {
        showError("Could not start Plaid: " + e.message);
    }
}

// ===== PREFETCH ALL =====
function startPrefetchAll() {
    fetch("/api/prefetch_all", { method: "POST" });
    prefetchedCategories.clear();
    pollPrefetchStatus();
}

function pollPrefetchStatus() {
    clearInterval(prefetchPollTimer);
    prefetchPollTimer = setInterval(async () => {
        try {
            const resp = await fetch("/api/prefetch_status");
            const data = await resp.json();
            prefetchedCategories = new Set(data.categories || []);

            const el = document.getElementById("prefetchProgress");
            const txt = document.getElementById("prefetchText");
            if (data.complete || data.done >= data.total) {
                el.style.display = "none";
                clearInterval(prefetchPollTimer);
            } else if (data.done > 0) {
                el.style.display = "block";
                txt.textContent = `analyzing ${data.done}/${data.total} categories...`;
            } else {
                el.style.display = "block";
                txt.textContent = "starting analysis...";
            }

            // Update saved categories display
            loadSavedCategories();
        } catch (e) {
            clearInterval(prefetchPollTimer);
        }
    }, 3000);
}

// ===== SAVED CATEGORIES / DASHBOARD =====
let savedCategoriesList = []; // cached for tracking detection

async function loadSavedCategories() {
    try {
        const resp = await fetch("/api/saved_categories");
        const cats = await resp.json();
        savedCategoriesList = cats || [];
        renderDashboard(savedCategoriesList);
    } catch (e) {}
}

function renderDashboard(cats) {
    const section = document.getElementById("dashboardSection");
    const cardsContainer = document.getElementById("dashboardCards");
    const tipEl = document.getElementById("dashboardTip");
    const pickerWrap = document.getElementById("pickerWrap");

    if (!cats || cats.length === 0) {
        section.style.display = "none";
        if (tipEl) tipEl.style.display = "block";
        pickerWrap.classList.add("picker-wrap-hero");
        return;
    }

    section.style.display = "block";
    if (tipEl) tipEl.style.display = "none";
    pickerWrap.classList.remove("picker-wrap-hero");

    cardsContainer.innerHTML = cats.map(cat => {
        const catObj = CATEGORIES.find(c => c.key === cat.category);
        const cachedEmoji = analysisCache[cat.category]?.emoji;
        const emoji = cat.emoji || cachedEmoji || (catObj ? catObj.emoji : "");
        const total = cat.last_total != null ? fmt(cat.last_total) : "--";

        let changeHtml = "";
        if (cat.previous_total != null && cat.previous_total > 0 && cat.last_total != null) {
            const pctChange = ((cat.last_total - cat.previous_total) / cat.previous_total) * 100;
            const arrow = pctChange >= 0 ? "\u2191" : "\u2193";
            const cls = pctChange >= 0 ? "change-up" : "change-down";
            changeHtml = `<span class="dash-row-change ${cls}">${arrow}${Math.abs(pctChange).toFixed(0)}%</span>`;
        }

        return `
            <div class="dash-row" onclick="analyzeSaved('${escapeHtml(cat.category)}')">
                <div class="dash-row-left">
                    ${emoji ? `<span class="dash-row-emoji">${emoji}</span>` : ""}
                    <span class="dash-row-name">${escapeHtml(cat.category)}</span>
                </div>
                <div class="dash-row-right">
                    ${changeHtml}
                    <span class="dash-row-total">${total}</span>
                    <button class="dash-row-remove" onclick="event.stopPropagation();removeSaved(${cat.id})">&times;</button>
                </div>
            </div>`;
    }).join("");
}

async function analyzeSaved(category) {
    selectedCategory = category;
    clearInterval(carouselTimer);
    await runAnalysis();
    // Re-save with updated emoji and total from analysis
    if (analysisData) {
        fetch("/api/saved_categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                category: category,
                emoji: analysisData.emoji || null,
                total: analysisData.total_30d || 0,
            }),
        }).catch(() => {});
    }
}

async function removeSaved(id) {
    await fetch(`/api/saved_categories/${id}`, { method: "DELETE" });
    loadSavedCategories();
}

// ===== CATEGORY PICKER (CAROUSEL) =====
let carouselIdx = 0;
let carouselTimer = null;
let carouselPaused = false;

function showCategoryPicker() {
    showHome();
}

function showHome() {
    carouselIdx = 0;
    carouselPaused = false;
    updateCarouselDisplay();
    startCarousel();
    renderHomeHeader();
    loadSavedCategories();
    loadConnectedAccounts();
    loadSpendingSummary();
    startPlaceholderRotation();

    document.getElementById("customCategory").addEventListener("keydown", e => {
        if (e.key === "Enter") analyzeCustom();
    });

    const refineInput = document.getElementById("refineInput");
    if (refineInput) {
        refineInput.addEventListener("keydown", e => {
            if (e.key === "Enter") runRefinement();
        });
    }

    showScreen("picker");
}

let pillRotateTimer = null;
let pillRotateIdx = 0;
let pillStats = [];

async function loadSpendingSummary() {
    const el = document.getElementById("spendingSummary");
    islandTxnsLoaded = false;
    clearInterval(pillRotateTimer);
    try {
        const resp = await fetch("/api/spending_summary");
        if (!resp.ok) { el.style.display = "none"; return; }
        const data = await resp.json();
        if (data.d30 && data.d30.total > 0) {
            el.style.display = "block";
            el.onclick = toggleIsland;

            pillStats = [];
            if (data.d30.total > 0) pillStats.push({ total: data.d30.total, count: data.d30.count, label: "last 30 days" });
            if (data.d7.total > 0) pillStats.push({ total: data.d7.total, count: data.d7.count, label: "last 7 days" });
            if (data.d1.total > 0) pillStats.push({ total: data.d1.total, count: data.d1.count, label: "yesterday" });

            const s = pillStats[0];
            el.innerHTML = `
                <div class="island-pill">
                    <span class="pill-text"><span class="summary-total">${fmt(s.total)}</span> &middot; ${s.count.toLocaleString()} txns &middot; <span style="color:var(--text3)">${s.label}</span></span>
                </div>
                <div class="island-header" onclick="event.stopPropagation();collapseIsland();">
                    <div class="island-header-left">
                        <div class="island-header-total">${fmt(data.d30.total)} spent</div>
                        <div class="island-header-sub">${data.d30.count.toLocaleString()} transactions &middot; last 30 days</div>
                    </div>
                    <button class="island-header-close">done</button>
                </div>
                <div class="island-body"></div>`;

            if (pillStats.length > 1) {
                pillRotateIdx = 0;
                pillRotateTimer = setInterval(() => {
                    if (islandOpen) return;
                    const pillText = el.querySelector(".pill-text");
                    if (!pillText) return;
                    pillText.classList.add("pill-fade-out");
                    setTimeout(() => {
                        pillRotateIdx = (pillRotateIdx + 1) % pillStats.length;
                        const ps = pillStats[pillRotateIdx];
                        pillText.innerHTML = `<span class="summary-total">${fmt(ps.total)}</span> &middot; ${ps.count.toLocaleString()} txns &middot; <span style="color:var(--text3)">${ps.label}</span>`;
                        pillText.classList.remove("pill-fade-out");
                    }, 300);
                }, 3000);
            }
        } else if (data.total > 0) {
            // Fallback for old API format
            el.style.display = "block";
            el.onclick = toggleIsland;
            el.innerHTML = `
                <div class="island-pill">
                    <span class="pill-text"><span class="summary-total">${fmt(data.total)}</span> &middot; ${data.count.toLocaleString()} txns &middot; <span style="color:var(--text3)">last 30 days</span></span>
                </div>
                <div class="island-header" onclick="event.stopPropagation();collapseIsland();">
                    <div class="island-header-left">
                        <div class="island-header-total">${fmt(data.total)} spent</div>
                        <div class="island-header-sub">${data.count.toLocaleString()} transactions &middot; last 30 days</div>
                    </div>
                    <button class="island-header-close">done</button>
                </div>
                <div class="island-body"></div>`;
        } else {
            el.style.display = "none";
        }
    } catch (e) {
        console.error("spending summary error:", e);
        el.style.display = "none";
    }
}

// ===== SPENDING ISLAND (Dynamic Island expand) =====
function toggleIsland() {
    const el = document.getElementById("spendingSummary");
    if (islandOpen) {
        collapseIsland();
    } else {
        expandIsland();
    }
}

async function expandIsland() {
    const el = document.getElementById("spendingSummary");
    islandOpen = true;
    document.body.style.overflow = "hidden";
    el.classList.add("island-open");
    history.pushState({ island: true, screen: "picker" }, "", "");

    if (!islandTxnsLoaded) {
        const body = el.querySelector(".island-body");
        body.innerHTML = '<p style="text-align:center;padding:32px 0;color:var(--text3);font-size:0.85rem;">loading transactions...</p>';
        try {
            const resp = await fetch("/api/transactions");
            const txns = await resp.json();
            renderIslandTransactions(body, txns);
            islandTxnsLoaded = true;
        } catch (e) {
            body.innerHTML = '<p style="text-align:center;padding:32px 0;color:var(--text3);font-size:0.85rem;">failed to load transactions</p>';
        }
    }
}

function collapseIsland() {
    const el = document.getElementById("spendingSummary");
    islandOpen = false;
    document.body.style.overflow = "";
    el.classList.remove("island-open");
}

function renderIslandTransactions(container, txns) {
    if (!txns || txns.length === 0) {
        container.innerHTML = '<p style="text-align:center;padding:32px 0;color:var(--text3);font-size:0.85rem;">no transactions found</p>';
        return;
    }

    let html = "";
    let lastDateLabel = "";

    for (const txn of txns) {
        const dateStr = txn.date || "";
        const dateObj = dateStr ? new Date(dateStr + "T00:00:00") : null;
        const dateLabel = dateObj
            ? dateObj.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
            : "Unknown";

        if (dateLabel !== lastDateLabel) {
            html += `<div class="island-date-header">${dateLabel}</div>`;
            lastDateLabel = dateLabel;
        }

        const merchant = txn.merchant_name || "";
        const detailParts = merchant && merchant !== txn.name ? merchant : "";

        html += `
            <div class="island-txn">
                <div class="island-txn-info">
                    <div class="island-txn-name">${escapeHtml(txn.name)}</div>
                    ${detailParts ? `<div class="island-txn-detail">${escapeHtml(detailParts)}</div>` : ""}
                </div>
                <div class="island-txn-amount">${fmtD(txn.amount)}</div>
            </div>`;
    }

    container.innerHTML = html;
}

function renderHomeHeader() {
    const greetingEl = document.getElementById("homeGreeting");
    const signOutEl = document.getElementById("homeSignOut");
    if (currentUser) {
        const firstName = currentUser.name.split(" ")[0];
        greetingEl.textContent = `hello, ${firstName}`;
        signOutEl.style.display = "inline";
    } else {
        greetingEl.textContent = "";
        signOutEl.style.display = "none";
    }
}

function startCarousel() {
    clearInterval(carouselTimer);
    carouselTimer = setInterval(() => {
        if (carouselPaused) return;
        const emojiEl = document.getElementById("carouselEmoji");
        const wordEl = document.getElementById("carouselWord");
        emojiEl.classList.add("out");
        wordEl.classList.add("out");
        setTimeout(() => {
            carouselIdx = (carouselIdx + 1) % CAROUSEL_EXAMPLES.length;
            updateCarouselDisplay();
            emojiEl.classList.remove("out");
            wordEl.classList.remove("out");
        }, 250);
    }, 1800);
}

function updateCarouselDisplay() {
    const ex = CAROUSEL_EXAMPLES[carouselIdx];
    document.getElementById("carouselEmoji").textContent = ex.emoji;
    document.getElementById("carouselWord").textContent = ex.label;
}

function selectCarousel() {
    if (!carouselPaused) {
        carouselPaused = true;
        document.getElementById("carouselHint").textContent = "tap again to analyze";
        document.getElementById("carouselHint").classList.add("paused");
    } else {
        selectedCategory = CAROUSEL_EXAMPLES[carouselIdx].label;
        clearInterval(carouselTimer);
        runAnalysis();
    }
}

// ===== ROTATING PLACEHOLDER =====
const PLACEHOLDER_EXAMPLES = [
    "type anything...",
    "restaurants last week",
    "uber in the last month",
    "takeout on weekends",
    "amazon purchases",
    "subscriptions over $20",
    "coffee in san francisco",
    "flights to hawaii",
    "groceries in january",
    "fast food last 3 months",
    "alcohol this year",
];
let placeholderIdx = 0;
let placeholderTimer = null;

function startPlaceholderRotation() {
    const input = document.getElementById("customCategory");
    if (!input) return;
    clearInterval(placeholderTimer);
    placeholderIdx = 0;
    placeholderTimer = setInterval(() => {
        if (document.activeElement === input) return; // don't rotate while focused
        placeholderIdx = (placeholderIdx + 1) % PLACEHOLDER_EXAMPLES.length;
        input.placeholder = PLACEHOLDER_EXAMPLES[placeholderIdx];
    }, 3000);
}

// ===== CONTEXTUAL REFINE PLACEHOLDERS =====
let refineRotateTimer = null;
let refineRotateIdx = 0;

function getRefineExamples(category) {
    const cat = category.toLowerCase();
    const specific = {
        amazon: ["amazon subscriptions", "amazon over $50", "amazon last month"],
        restaurants: ["restaurants over $30", "restaurants last week", "italian restaurants"],
        coffee: ["coffee over $5", "coffee last week", "starbucks"],
        groceries: ["groceries over $100", "groceries last week", "whole foods"],
        uber: ["uber over $20", "uber last week", "uber eats"],
    };
    for (const [key, examples] of Object.entries(specific)) {
        if (cat.includes(key)) return examples;
    }
    return ["over $50", "last month", "last week"];
}

function startRefineRotation(category) {
    clearInterval(refineRotateTimer);
    const input = document.getElementById("refineInput");
    if (!input) return;
    const examples = getRefineExamples(category);
    refineRotateIdx = 0;
    input.placeholder = examples[0];
    refineRotateTimer = setInterval(() => {
        if (document.activeElement === input) return;
        refineRotateIdx = (refineRotateIdx + 1) % examples.length;
        input.placeholder = examples[refineRotateIdx];
    }, 3000);
}

function analyzeCustom() {
    const val = document.getElementById("customCategory").value.trim();
    if (!val) return;
    selectedCategory = val;
    clearInterval(carouselTimer);
    runAnalysis();
}

// ===== LOADING =====
let progressInterval = null;

function animateProgress() {
    const bar = document.getElementById("progressBar");
    const msg = document.getElementById("loadingMsg");
    const catObj = CATEGORIES.find(c => c.key === selectedCategory);
    const emoji = catObj ? catObj.emoji + " " : "";
    document.getElementById("loadingWord").innerHTML = emoji + escapeHtml(selectedCategory);
    let pct = 0;
    const steps = [
        [10, "checking cache..."],
        [25, "AI is reading your transactions..."],
        [50, "categorizing spending..."],
        [70, "crunching numbers..."],
        [88, "almost there..."],
    ];

    clearInterval(progressInterval);
    bar.style.width = "0%";

    progressInterval = setInterval(() => {
        pct += 1;
        if (pct > 92) pct = 92;
        bar.style.width = pct + "%";
        for (const [t, m] of steps) {
            if (pct === t) msg.textContent = m;
        }
    }, 150);
}

function stopProgress() {
    clearInterval(progressInterval);
    document.getElementById("progressBar").style.width = "100%";
}

// ===== ANALYSIS =====
async function runAnalysis() {
    // Return cached result instantly if we already have it for this category
    if (analysisCache[selectedCategory]) {
        analysisData = analysisCache[selectedCategory];
        renderResults(analysisData);
        updateTrackButton();
        showScreen("results");
        return;
    }

    showScreen("loading");
    animateProgress();

    try {
        const resp = await fetch(`/api/analysis?category=${encodeURIComponent(selectedCategory)}`);
        const data = await resp.json();
        stopProgress();

        if (data.error) {
            showError(data.error);
            if (bankConnected) showScreen("picker");
            else showScreen("welcome");
            return;
        }

        analysisData = data;
        analysisCache[selectedCategory] = data;
        renderResults(data);
        updateTrackButton();
        showScreen("results");
    } catch (e) {
        stopProgress();
        showError("Analysis failed: " + e.message);
        showScreen("picker");
    }
}

// ===== RESULTS =====
function renderResults(data) {
    const refineInput = document.getElementById("refineInput");
    if (refineInput) refineInput.value = "";
    renderRefinementChain();

    const days = data.days_available || 365;
    const stack = document.querySelector(".results-stack");
    const displayLabel = refinementStack.length > 0 ? buildRefinementLabel() : selectedCategory;
    const catObj = CATEGORIES.find(c => c.key === selectedCategory);
    const resultEmoji = data.emoji || (catObj ? catObj.emoji : "");
    const onLabel = `on ${resultEmoji ? resultEmoji + " " : ""}${escapeHtml(displayLabel)}`;

    if (days <= 35) {
        stack.innerHTML = `
            <div class="result-row row-1yr">
                <span class="row-amount">${fmt(data.total_1yr || 0)}</span>
                <span class="row-label">last ${days} days ${onLabel}</span>
            </div>`;
    } else if (days <= 95) {
        stack.innerHTML = `
            <div class="result-row row-30">
                <span class="row-amount">${fmt(data.total_30d || 0)}</span>
                <span class="row-label">last 30 days ${onLabel}</span>
            </div>
            <div class="result-row row-1yr">
                <span class="row-amount">${fmt(data.total_1yr || 0)}</span>
                <span class="row-label">last ${days} days</span>
            </div>`;
    } else {
        let momHtml = "";
        if (data.prior_30d > 0) {
            const pctChange = ((data.total_30d - data.prior_30d) / data.prior_30d) * 100;
            const arrow = pctChange >= 0 ? "\u2191" : "\u2193";
            const cls = pctChange >= 0 ? "change-up" : "change-down";
            momHtml = `<span class="row-mom ${cls}">${arrow}${Math.abs(pctChange).toFixed(0)}% vs prior 30 days</span>`;
        }
        stack.innerHTML = `
            <div class="result-row row-30">
                <span class="row-amount" id="amt30">${fmt(data.total_30d || 0)}</span>
                <span class="row-label">last 30 days ${onLabel}</span>
            </div>
            ${momHtml ? `<div class="result-row-mom">${momHtml}</div>` : ""}
            <div class="result-row row-90">
                <span class="row-amount" id="amt90">${fmt(data.total_90d || 0)}</span>
                <span class="row-label">last 90 days</span>
            </div>
            <div class="result-row row-1yr">
                <span class="row-amount" id="amt1yr">${fmt(data.total_1yr || 0)}</span>
                <span class="row-label">last year</span>
            </div>`;
    }

    let metaText = `${data.transaction_count} transactions \u00B7 ${data.total_transactions_analyzed} analyzed`;
    if (days < 90) {
        metaText += ` \u00B7 ${days} days of bank history available`;
    }
    document.getElementById("resultsMeta").textContent = metaText;

    startRefineRotation(displayLabel);
    renderSections(data.categories);
}

function renderSections(categories) {
    const container = document.getElementById("txnSections");

    if (!categories || categories.length === 0) {
        container.innerHTML = '<p style="color:var(--text3);text-align:center;padding:32px 0;font-size:0.9rem;">no transactions found for this category</p>';
        return;
    }

    container.innerHTML = categories.map((cat, idx) => {
        const key = findCatKey(cat.label);
        const icon = CAT_ICONS[key] || "\u{1F4CB}";

        const rows = (cat.transactions || []).map(txn => {
            const d = txn.date
                ? new Date(txn.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
                : "";
            return `
                <div class="txn-row">
                    <div class="txn-info">
                        <div class="txn-name">${txn.name}</div>
                        <div class="txn-detail">${d}${txn.merchant_name ? " \u00B7 " + txn.merchant_name : ""}</div>
                    </div>
                    <div class="txn-amount">${fmtD(txn.amount)}</div>
                </div>`;
        }).join("");

        return `
            <div class="txn-section" id="sec-${idx}">
                <div class="txn-section-header" onclick="toggleSec(${idx})">
                    <div class="txn-section-left">
                        <span class="txn-section-icon">${icon}</span>
                        <span class="txn-section-name">${cat.label}</span>
                    </div>
                    <div class="txn-section-right">
                        <span class="txn-section-total">${fmt(cat.total)}</span>
                        <span class="txn-section-count">${cat.count}</span>
                        <span class="txn-chevron">\u203A</span>
                    </div>
                </div>
                <div class="txn-section-body">${rows}</div>
            </div>`;
    }).join("");
}

function findCatKey(label) {
    const map = {
        "Food & Treats": "food_treats", "Health & Vet": "health_vet",
        "Pet Insurance": "insurance", "Grooming": "grooming",
        "Supplies & Toys": "supplies_toys", "Boarding & Daycare": "boarding_daycare",
        "Walking & Sitting": "walking_sitting", "Training": "training",
        "Other Pet Expense": "other_pet",
    };
    return map[label] || label.toLowerCase().replace(/ /g, "_");
}

function toggleSec(idx) {
    document.getElementById(`sec-${idx}`).classList.toggle("open");
}

function goBack() { goHome(); }

function goHome() {
    refinementStack = [];
    clearInterval(refineRotateTimer);
    carouselPaused = false;
    document.getElementById("carouselHint").textContent = "tap to select";
    document.getElementById("carouselHint").classList.remove("paused");
    startCarousel();
    renderHomeHeader();
    loadSavedCategories();
    loadConnectedAccounts();
    loadSpendingSummary();
    showScreen("picker");
}

// ===== REFINEMENT =====
function buildRefinementLabel() {
    const labels = refinementStack.map(s => s.query);
    labels.push(selectedCategory);
    return labels.join(" \u2192 ");
}

function renderRefinementChain() {
    const el = document.getElementById("refinementChain");
    if (!el) return;
    if (refinementStack.length === 0) {
        el.style.display = "none";
        return;
    }
    const allQueries = refinementStack.map(s => s.query);
    allQueries.push(selectedCategory);
    el.style.display = "flex";
    el.innerHTML = allQueries.map((q, i) => {
        const chip = `<span class="refine-chip">${escapeHtml(q)}</span>`;
        return i < allQueries.length - 1 ? chip + '<span class="refine-arrow">\u2192</span>' : chip;
    }).join("");
}

async function runRefinement() {
    const input = document.getElementById("refineInput");
    const query = (input ? input.value : "").trim();
    if (!query || !analysisData || !analysisData.transactions || analysisData.transactions.length === 0) return;

    // Push current state onto stack
    refinementStack.push({ query: selectedCategory, data: analysisData });
    history.pushState({ screen: "results" }, "", "");

    selectedCategory = query;
    showScreen("loading");
    animateProgress();

    try {
        const resp = await fetch("/api/analysis/refine", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, transactions: analysisData.transactions }),
        });
        const data = await resp.json();
        stopProgress();

        if (data.error) {
            // Revert stack
            const prev = refinementStack.pop();
            selectedCategory = prev.query;
            analysisData = prev.data;
            showError(data.error);
            showScreen("results");
            return;
        }

        analysisData = data;
        renderResults(data);
        updateTrackButton();
        showScreen("results");
    } catch (e) {
        stopProgress();
        const prev = refinementStack.pop();
        selectedCategory = prev.query;
        analysisData = prev.data;
        showError("Refinement failed: " + e.message);
        showScreen("results");
    }
}

// ===== TRACK CATEGORY =====
async function trackCategory() {
    if (!analysisData) return;
    const trackLabel = refinementStack.length > 0 ? buildRefinementLabel() : selectedCategory;
    const catObj = CATEGORIES.find(c => c.key === selectedCategory);
    const emoji = analysisData.emoji || (catObj ? catObj.emoji : null);
    try {
        await fetch("/api/saved_categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                category: trackLabel,
                emoji: emoji,
                total: analysisData.total_30d || 0,
            }),
        });
        const btn = document.getElementById("trackBtn");
        btn.textContent = "tracking \u2713";
        btn.disabled = true;
        btn.classList.add("tracked");
    } catch (e) {
        showError("Failed to save: " + e.message);
    }
}

function updateTrackButton() {
    const trackBtn = document.getElementById("trackBtn");
    const isTracked = savedCategoriesList.some(c => c.category === selectedCategory);
    if (isTracked) {
        trackBtn.textContent = "tracking \u2713";
        trackBtn.disabled = true;
        trackBtn.classList.add("tracked");
    } else {
        trackBtn.textContent = "track this";
        trackBtn.disabled = false;
        trackBtn.classList.remove("tracked");
    }
}

// ===== CONNECTED ACCOUNTS =====
async function loadConnectedAccounts() {
    try {
        const resp = await fetch("/api/institutions");
        const institutions = await resp.json();
        const section = document.getElementById("connectedAccountsSection");
        const list = document.getElementById("connectedList");
        if (!institutions || institutions.length === 0) {
            section.style.display = "none";
            return;
        }
        section.style.display = "block";
        const names = institutions.map(inst =>
            `<span class="connected-name" style="cursor:default;">${escapeHtml(inst.institution_name)}</span><button onclick="removeAccount('${escapeHtml(inst.item_id)}','${escapeHtml(inst.institution_name)}');return false;" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:0.75rem;padding:0 2px;margin-left:2px;" title="Disconnect">&times;</button>`
        ).join('<span class="connected-sep">&middot;</span>');
        list.innerHTML = `
            <span class="connected-label">connected:</span>
            ${names}
            <span class="connected-sep">&middot;</span>
            <a href="#" class="connected-action" onclick="addMoreAccounts();return false;">+ add</a>`;
    } catch (e) {}
}

async function removeAccount(itemId, institutionName) {
    const name = institutionName || "this account";
    if (!confirm(`Disconnect ${name}?\n\nYou will not be able to track expenses from this account until you reconnect it.`)) return;
    try {
        const resp = await fetch("/api/remove_institution", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_id: itemId }),
        });
        const data = await resp.json();
        if (data.error) { showError(data.error); return; }
        if (data.remaining === 0) {
            bankConnected = false;
            showScreen("welcome");
            startRotation();
            renderAuthUI();
            return;
        }
        loadConnectedAccounts();
        // Invalidate cache since accounts changed
        fetch("/api/refresh", { method: "POST" });
    } catch (e) {
        showError("Failed to remove: " + e.message);
    }
}

function addMoreAccounts() {
    startPlaidLink();
}

// ===== LOGOUT =====
async function doLogout() {
    if (!confirm("Disconnect all accounts and clear data?")) return;
    await fetch("/api/logout", { method: "POST" });
    analysisData = null;
    Object.keys(analysisCache).forEach(k => delete analysisCache[k]);
    bankConnected = false;
    currentUser = null;
    prefetchedCategories.clear();
    clearInterval(prefetchPollTimer);
    renderGoogleButton();
    renderAuthUI();
    showScreen("welcome");
    startRotation();
}

// ===== INIT =====
async function checkBankAndProceed() {
    try {
        const resp = await fetch("/api/institutions");
        const institutions = await resp.json();
        if (institutions.length > 0) {
            bankConnected = true;
            stopRotation();
            const subCat = window.SUBDOMAIN_CATEGORY;
            if (subCat) {
                selectedCategory = subCat;
                runAnalysis();
            } else {
                showCategoryPicker();
            }
            return true;
        }
    } catch (e) {}
    return false;
}

// Set initial history state
history.replaceState({ screen: "welcome" }, "", "");

(async function init() {
    const subCat = window.SUBDOMAIN_CATEGORY;

    if (subCat) {
        selectedCategory = subCat;
        const catObj = CATEGORIES.find(c => c.key === subCat);
        const wordEl = document.getElementById("rotatingWord");
        const emojiEl = document.getElementById("rotatingEmoji");
        if (wordEl) wordEl.textContent = subCat;
        if (emojiEl) emojiEl.textContent = catObj ? catObj.emoji : "\u{1F50D}";
    }

    if (!subCat) startRotation();

    // Check auth state
    try {
        const authResp = await fetch("/api/auth/me");
        const authData = await authResp.json();
        if (authData.authenticated) {
            currentUser = authData.user;
        }
    } catch (e) {}

    initGoogleAuth();
    renderAuthUI();

    // Check if bank is already connected
    const hasBanks = await checkBankAndProceed();
    if (!hasBanks && subCat) {
        // No bank but subdomain — stay on welcome
    }
})();
