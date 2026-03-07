let analysisData = null;
let selectedCategory = "dog";
let bankConnected = false;

const CATEGORIES = [
    { key: "dog", emoji: "🐶", label: "dog", domain: "dog.com" },
    { key: "groceries", emoji: "🛒", label: "groceries", domain: "groceries.com" },
    { key: "coffee", emoji: "☕", label: "coffee", domain: "coffee.com" },
    { key: "restaurants", emoji: "🍽️", label: "restaurants", domain: "restaurants.com" },
    { key: "rent", emoji: "🏠", label: "rent", domain: "rent.com" },
    { key: "clothes", emoji: "👕", label: "clothes", domain: "clothes.com" },
    { key: "rideshare", emoji: "🚗", label: "rideshare", domain: "rideshare.com" },
    { key: "subscriptions", emoji: "📱", label: "subscriptions", domain: "subscriptions.com" },
    { key: "travel", emoji: "✈️", label: "travel", domain: "travel.com" },
    { key: "fitness", emoji: "💪", label: "fitness", domain: "fitness.com" },
    { key: "fast food", emoji: "🍟", label: "fast food", domain: "fastfood.com" },
    { key: "alcohol", emoji: "🍷", label: "alcohol", domain: "alcohol.com" },
];

const CAT_ICONS = {
    food_treats: "🦴", health_vet: "🏥", insurance: "🛡️", grooming: "✂️",
    supplies_toys: "🧸", boarding_daycare: "🏠", walking_sitting: "🚶",
    training: "🎓", other_pet: "🐾",
    food: "🍽️", transport: "🚗", shopping: "🛍️", housing: "🏠",
    entertainment: "🎬", health: "💊", utilities: "⚡", other: "📋",
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

// ===== PLAID =====
async function startPlaidLink() {
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

                    // Pre-fetch transactions in background while showing picker
                    fetch("/api/prefetch", { method: "POST" });

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

// ===== CATEGORY PICKER (CAROUSEL) =====
let carouselIdx = 0;
let carouselTimer = null;
let carouselPaused = false;

function showCategoryPicker() {
    carouselIdx = 0;
    carouselPaused = false;
    updateCarouselDisplay();
    startCarousel();

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
    document.getElementById("carouselWord").innerHTML = cat.label + '<span class="carousel-dot">.com</span>';
}

function selectCarousel() {
    if (!carouselPaused) {
        // First tap: pause
        carouselPaused = true;
        document.getElementById("carouselHint").textContent = "tap again to analyze";
        document.getElementById("carouselHint").classList.add("paused");
    } else {
        // Second tap: go
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
        // Only ~30 days of data — show single number
        stack.innerHTML = `
            <div class="result-row row-1yr">
                <span class="row-amount">${fmt(data.total_1yr || 0)}</span>
                <span class="row-label">last ${days} days</span>
            </div>`;
    } else if (days <= 95) {
        // ~90 days — show 30d and total
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
        // Full data — show all three
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

    let metaText = `${data.transaction_count} transactions · ${data.total_transactions_analyzed} analyzed`;
    if (days < 90) {
        metaText += ` · ${days} days of bank history available`;
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
        const icon = CAT_ICONS[key] || "📋";

        const rows = (cat.transactions || []).map(txn => {
            const d = txn.date
                ? new Date(txn.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
                : "";
            return `
                <div class="txn-row">
                    <div class="txn-info">
                        <div class="txn-name">${txn.name}</div>
                        <div class="txn-detail">${d}${txn.merchant_name ? " · " + txn.merchant_name : ""}</div>
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
                        <span class="txn-chevron">›</span>
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
    showScreen("picker");
}

// ===== LOGOUT =====
async function doLogout() {
    if (!confirm("Disconnect all accounts and clear data?")) return;
    await fetch("/api/logout", { method: "POST" });
    analysisData = null;
    bankConnected = false;
    showScreen("welcome");
    startRotation();
}

// ===== INIT =====
(async function init() {
    const subCat = window.SUBDOMAIN_CATEGORY;

    // If subdomain category, set it as selected and update welcome screen text
    if (subCat) {
        selectedCategory = subCat;
        const catObj = CATEGORIES.find(c => c.key === subCat);
        const wordEl = document.getElementById("rotatingWord");
        const emojiEl = document.getElementById("rotatingEmoji");
        if (wordEl) wordEl.textContent = subCat;
        if (emojiEl) emojiEl.textContent = catObj ? catObj.emoji : "🔍";
    }

    if (!subCat) startRotation();

    try {
        const resp = await fetch("/api/institutions");
        const institutions = await resp.json();
        if (institutions.length > 0) {
            bankConnected = true;
            stopRotation();
            if (subCat) {
                // Auto-analyze the subdomain category
                runAnalysis();
            } else {
                showCategoryPicker();
            }
        }
    } catch (e) {}
})();
