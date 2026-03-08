let analysisData = null;
let selectedCategory = "dog";
let bankConnected = false;
let currentUser = null; // { id, name, email } or null
let prefetchedCategories = new Set();
let prefetchPollTimer = null;

const CATEGORIES = [
    { key: "dog", emoji: "\u{1F436}", label: "dog", domain: "dog.com" },
    { key: "groceries", emoji: "\u{1F6D2}", label: "groceries", domain: "groceries.com" },
    { key: "coffee", emoji: "\u2615", label: "coffee", domain: "coffee.com" },
    { key: "restaurants", emoji: "\u{1F37D}\uFE0F", label: "restaurants", domain: "restaurants.com" },
    { key: "rent", emoji: "\u{1F3E0}", label: "rent", domain: "rent.com" },
    { key: "clothes", emoji: "\u{1F455}", label: "clothes", domain: "clothes.com" },
    { key: "rideshare", emoji: "\u{1F697}", label: "rideshare", domain: "rideshare.com" },
    { key: "subscriptions", emoji: "\u{1F4F1}", label: "subscriptions", domain: "subscriptions.com" },
    { key: "travel", emoji: "\u2708\uFE0F", label: "travel", domain: "travel.com" },
    { key: "fitness", emoji: "\u{1F4AA}", label: "fitness", domain: "fitness.com" },
    { key: "fast food", emoji: "\u{1F35F}", label: "fast food", domain: "fastfood.com" },
    { key: "alcohol", emoji: "\u{1F377}", label: "alcohol", domain: "alcohol.com" },
];

const CAT_ICONS = {
    food_treats: "\u{1F9B4}", health_vet: "\u{1F3E5}", insurance: "\u{1F6E1}\uFE0F", grooming: "\u2702\uFE0F",
    supplies_toys: "\u{1F9F8}", boarding_daycare: "\u{1F3E0}", walking_sitting: "\u{1F6B6}",
    training: "\u{1F393}", other_pet: "\u{1F43E}",
    food: "\u{1F37D}\uFE0F", transport: "\u{1F697}", shopping: "\u{1F6CD}\uFE0F", housing: "\u{1F3E0}",
    entertainment: "\u{1F3AC}", health: "\u{1F48A}", utilities: "\u26A1", other: "\u{1F4CB}",
};

// ===== SCREENS =====
function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
}

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
            rotateIdx = (rotateIdx + 1) % CATEGORIES.length;
            wordEl.textContent = CATEGORIES[rotateIdx].label;
            if (emojiEl) emojiEl.textContent = CATEGORIES[rotateIdx].emoji;
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
        // If bank was already connected anonymously, it's now claimed
        checkBankAndProceed();
    } catch (e) {
        showError("Sign-in failed: " + e.message);
    }
}

async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    currentUser = null;
    renderGoogleButton();
    renderAuthUI();
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
    // Welcome screen auth — toggle Google button vs bank button
    const googleBtn = document.getElementById("googleSignInBtn");
    const bankBtn = document.getElementById("connectBankBtn");
    const plaidNote = document.getElementById("welcomePlaidNote");
    const welcomeAuth = document.getElementById("welcomeAuth");

    if (currentUser) {
        if (googleBtn) googleBtn.style.display = "none";
        if (bankBtn) bankBtn.style.display = "block";
        if (plaidNote) plaidNote.style.display = "block";
        if (welcomeAuth) {
            welcomeAuth.innerHTML = `<p class="welcome-fine" style="margin-top:10px;">signed in as ${escapeHtml(currentUser.name)} &middot; <a href="#" onclick="signOut();return false;" class="auth-link">sign out</a></p>`;
        }
    } else {
        if (googleBtn) googleBtn.style.display = "flex";
        if (bankBtn) bankBtn.style.display = "none";
        if (plaidNote) plaidNote.style.display = "none";
        if (welcomeAuth) welcomeAuth.innerHTML = "";
    }

    // Picker header auth
    const pickerAuth = document.getElementById("pickerAuthArea");
    if (pickerAuth) {
        if (currentUser) {
            pickerAuth.innerHTML = `<span class="picker-user">${escapeHtml(currentUser.name)}</span> <a href="#" onclick="signOut();return false;" class="auth-link-small">sign out</a>`;
        } else if (window.GOOGLE_CLIENT_ID) {
            pickerAuth.innerHTML = `<a href="#" onclick="triggerGoogleSignIn();return false;" class="auth-link-small">sign in</a>`;
        }
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

                    // Pre-fetch transactions in background
                    fetch("/api/prefetch", { method: "POST" });

                    // Start background prefetch of all 12 categories
                    startPrefetchAll();

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

// ===== SAVED CATEGORIES =====
async function loadSavedCategories() {
    try {
        const resp = await fetch("/api/saved_categories");
        const cats = await resp.json();
        const section = document.getElementById("savedCategoriesSection");
        const container = document.getElementById("savedCards");

        if (!cats || cats.length === 0) {
            section.style.display = "none";
            return;
        }

        section.style.display = "block";
        container.innerHTML = cats.map(cat => {
            const catObj = CATEGORIES.find(c => c.key === cat.category);
            const emoji = cat.emoji || (catObj ? catObj.emoji : "\u{1F50D}");
            const total = cat.last_total != null ? fmt(cat.last_total) : "--";

            let changeHtml = "";
            if (cat.previous_total != null && cat.previous_total > 0 && cat.last_total != null) {
                const pctChange = ((cat.last_total - cat.previous_total) / cat.previous_total) * 100;
                const arrow = pctChange >= 0 ? "\u2191" : "\u2193";
                const cls = pctChange >= 0 ? "change-up" : "change-down";
                changeHtml = `<span class="saved-change ${cls}">${arrow}${Math.abs(pctChange).toFixed(0)}%</span>`;
            }

            return `
                <div class="saved-card" onclick="analyzeSaved('${escapeHtml(cat.category)}')">
                    <button class="saved-remove" onclick="event.stopPropagation();removeSaved(${cat.id})">&times;</button>
                    <div class="saved-emoji">${emoji}</div>
                    <div class="saved-name">${escapeHtml(cat.category)}</div>
                    <div class="saved-total">${total}</div>
                    ${changeHtml}
                </div>`;
        }).join("");
    } catch (e) {}
}

function analyzeSaved(category) {
    selectedCategory = category;
    clearInterval(carouselTimer);
    runAnalysis();
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
    carouselIdx = 0;
    carouselPaused = false;
    updateCarouselDisplay();
    startCarousel();
    renderAuthUI();
    loadSavedCategories();

    document.getElementById("customCategory").addEventListener("keydown", e => {
        if (e.key === "Enter") analyzeCustom();
    });

    showScreen("picker");
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
            carouselIdx = (carouselIdx + 1) % CATEGORIES.length;
            updateCarouselDisplay();
            emojiEl.classList.remove("out");
            wordEl.classList.remove("out");
        }, 250);
    }, 1800);
}

function updateCarouselDisplay() {
    const cat = CATEGORIES[carouselIdx];
    document.getElementById("carouselEmoji").textContent = cat.emoji;
    const checkmark = prefetchedCategories.has(cat.key) ? ' <span class="prefetch-check">\u2713</span>' : "";
    document.getElementById("carouselWord").innerHTML = cat.label + '<span class="carousel-dot">.com</span>' + checkmark;
}

function selectCarousel() {
    if (!carouselPaused) {
        carouselPaused = true;
        document.getElementById("carouselHint").textContent = "tap again to analyze";
        document.getElementById("carouselHint").classList.add("paused");
    } else {
        selectedCategory = CATEGORIES[carouselIdx].key;
        clearInterval(carouselTimer);
        runAnalysis();
    }
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
    document.getElementById("loadingWord").innerHTML = emoji + selectedCategory + '<span class="dim">.com</span>';
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
        renderResults(data);
        showScreen("results");
    } catch (e) {
        stopProgress();
        showError("Analysis failed: " + e.message);
        showScreen("picker");
    }
}

// ===== RESULTS =====
function renderResults(data) {
    const days = data.days_available || 365;
    const stack = document.querySelector(".results-stack");

    if (days <= 35) {
        stack.innerHTML = `
            <div class="result-row row-1yr">
                <span class="row-amount">${fmt(data.total_1yr || 0)}</span>
                <span class="row-label">last ${days} days</span>
            </div>`;
    } else if (days <= 95) {
        stack.innerHTML = `
            <div class="result-row row-30">
                <span class="row-amount">${fmt(data.total_30d || 0)}</span>
                <span class="row-label">last 30 days</span>
            </div>
            <div class="result-row row-1yr">
                <span class="row-amount">${fmt(data.total_1yr || 0)}</span>
                <span class="row-label">last ${days} days</span>
            </div>`;
    } else {
        stack.innerHTML = `
            <div class="result-row row-30">
                <span class="row-amount" id="amt30">${fmt(data.total_30d || 0)}</span>
                <span class="row-label">last 30 days</span>
            </div>
            <div class="result-row row-90">
                <span class="row-amount" id="amt90">${fmt(data.total_90d || 0)}</span>
                <span class="row-label">last 90 days</span>
            </div>
            <div class="result-row row-1yr">
                <span class="row-amount" id="amt1yr">${fmt(data.total_1yr || 0)}</span>
                <span class="row-label">last year</span>
            </div>`;
    }

    const catObj = CATEGORIES.find(c => c.key === selectedCategory);
    const emoji = catObj ? catObj.emoji + " " : "";
    document.getElementById("resultsOn").innerHTML = `on ${emoji}${selectedCategory}<span class="dim">.com</span>`;

    let metaText = `${data.transaction_count} transactions \u00B7 ${data.total_transactions_analyzed} analyzed`;
    if (days < 90) {
        metaText += ` \u00B7 ${days} days of bank history available`;
    }
    document.getElementById("resultsMeta").textContent = metaText;

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

function goBack() {
    carouselPaused = false;
    document.getElementById("carouselHint").textContent = "tap to select";
    document.getElementById("carouselHint").classList.remove("paused");
    startCarousel();
    loadSavedCategories();
    showScreen("picker");
}

// ===== LOGOUT =====
async function doLogout() {
    if (!confirm("Disconnect all accounts and clear data?")) return;
    await fetch("/api/logout", { method: "POST" });
    analysisData = null;
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
            // Start prefetch if not already running
            startPrefetchAll();
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
