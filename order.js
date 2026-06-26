/* KUMAGO 年租方案線上訂購 — order page logic
   - Prices / add-ons mirror the live LINE order system (plan_data.py / fixed_reply.py).
   - The browser computes totals only for display; the authoritative total is
     recomputed server-side in /api/create-checkout-session before charging. */
(function () {
  "use strict";

  /* =================== LINE OA (市外報價導流用) ===================
     市外（奈良・京都・兵庫）運費需人工報價，導去 LINE 預填訂單摘要。
     ▼ 換成實際的 LINE 官方帳號 Basic ID（含 @）。 */
  const LINE_OA_BASIC_ID = "@kumago"; // TODO: 換成實際 Basic ID

  /* =================== DATA =================== */
  // 期別價格完全對齊 plan_data.PLANS
  const PLANS = {
    A: {
      name: { zh: "A 套組", ja: "A セット" },
      desc: { zh: "冷凍冷藏庫 90–130L・洗衣機 4.2–6kg・微波爐",
              ja: "冷凍冷蔵庫 90〜130L・洗濯機 4.2〜6kg・電子レンジ" },
      img: "assets/sets/set_A.jpg",
      prices: { "1個月": 28400, "2個月": 31130, "3個月": 32920, "4個月": 36250,
                "5個月": 37430, "半年": 38490, "1年": 45100, "2年": 63250 },
    },
    B: {
      name: { zh: "B 套組", ja: "B セット" },
      desc: { zh: "A 套組 ＋ 單人床架與床墊",
              ja: "A セット ＋ シングルベッドフレーム・マットレス" },
      img: "assets/sets/set_B.jpg",
      prices: { "1個月": 32910, "2個月": 35640, "3個月": 38400, "4個月": 41820,
                "5個月": 43640, "半年": 46270, "1年": 55080, "2年": 69990 },
    },
    C: {
      name: { zh: "C 套組", ja: "C セット" },
      desc: { zh: "A 套組 ＋ 半雙人床架與床墊",
              ja: "A セット ＋ セミダブルベッドフレーム・マットレス" },
      img: "assets/sets/set_C.jpg",
      prices: { "1個月": 46980, "2個月": 49360, "3個月": 52430, "4個月": 55690,
                "5個月": 59350, "半年": 62340, "1年": 72320, "2年": 91630 },
    },
  };

  // 主推年租在前；短期收在折疊區
  const MAIN_DURATIONS = ["半年", "1年", "2年"];
  const SHORT_DURATIONS = ["1個月", "2個月", "3個月", "4個月", "5個月"];

  const ADDONS = [
    { key: "floor_mat",     price: 1800, zh: "地板保護墊",   ja: "フロアマット" },
    { key: "kettle",        price: 4500, zh: "熱水壺",       ja: "電気ケトル" },
    { key: "ceiling_light", price: 4500, zh: "可調光吸頂燈", ja: "調光シーリングライト" },
    { key: "curtain",       price: 4900, zh: "4 片窗簾組",   ja: "カーテン4枚セット" },
    { key: "vacuum",        price: 4500, zh: "吸塵器",       ja: "掃除機" },
    { key: "fan",           price: 4500, zh: "電風扇",       ja: "扇風機" },
    { key: "clothes_rack",  price: 4500, zh: "室內掛衣架",   ja: "室内物干しラック" },
    { key: "desk",          price: 9000, zh: "桌椅組",       ja: "デスク・チェアセット" },
    { key: "rice_cooker",   price: 7000, zh: "電飯鍋",       ja: "炊飯器" },
    { key: "pot",           price: 7000, zh: "鍋具組",       ja: "鍋セット" },
    { key: "clothesline",   price: 1800, zh: "曬衣桿",       ja: "物干し竿" },
  ].map((a) => ({ ...a, img: `assets/addons/${a.key}.jpg` }));

  const AREAS = [
    { key: "osaka", online: true,  zh: "大阪市內", ja: "大阪市内" },
    { key: "nara",  online: false, zh: "奈良",     ja: "奈良" },
    { key: "kyoto", online: false, zh: "京都",     ja: "京都" },
    { key: "hyogo", online: false, zh: "兵庫（神戶）", ja: "兵庫（神戸）" },
  ];

  const TIMES = [
    { key: "10-12", zh: "10:00–12:00", ja: "10:00〜12:00" },
    { key: "12-14", zh: "12:00–14:00", ja: "12:00〜14:00" },
    { key: "14-16", zh: "14:00–16:00", ja: "14:00〜16:00" },
    { key: "any",   zh: "都可以",       ja: "どの時間帯でも可" },
  ];

  const ELEVATORS = [
    { key: "有",     zh: "有電梯",   ja: "エレベーターあり" },
    { key: "無",     zh: "無電梯",   ja: "エレベーターなし" },
    { key: "不知道", zh: "不確定",   ja: "わからない" },
  ];

  /* =================== i18n micro-helpers =================== */
  const L = () => (document.documentElement.lang === "ja" ? "ja" : "zh");
  const T = {
    durLabel: (d) => {
      if (d === "半年") return "半年";
      if (d === "1年") return "1 年";
      if (d === "2年") return "2 年";
      const n = d.replace("個月", "");
      return L() === "ja" ? `${n} ヶ月` : `${n} 個月`;
    },
    yen: (n) => "¥" + n.toLocaleString("ja-JP"),
    t: (zh, ja) => (L() === "ja" ? ja : zh),
  };

  /* =================== STATE =================== */
  const state = {
    plan: null,
    duration: null,
    addons: new Set(),
    area: "osaka",
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* =================== RENDERERS =================== */
  function renderPlans() {
    const wrap = $("#planCards");
    wrap.innerHTML = "";
    Object.keys(PLANS).forEach((k) => {
      const p = PLANS[k];
      const el = document.createElement("button");
      el.type = "button";
      el.className = "opt-card plan-card" + (state.plan === k ? " is-selected" : "");
      el.dataset.plan = k;
      el.innerHTML =
        `<span class="plan-photo"><img src="${p.img}" alt="${p.name[L()]}" loading="lazy" /></span>` +
        `<span class="plan-info">` +
          `<span class="plan-head"><span class="plan-letter">${k}</span><span class="opt-title">${p.name[L()]}</span></span>` +
          `<span class="opt-desc">${p.desc[L()]}</span>` +
          `<span class="opt-from">${T.t("最低", "最安")} ${T.yen(Math.min.apply(null, Object.values(p.prices)))}~</span>` +
        `</span>`;
      el.addEventListener("click", () => {
        state.plan = k;
        renderPlans();
        renderDurations();
        recalc();
      });
      wrap.appendChild(el);
    });
  }

  function durationButton(d) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "dur-btn" + (state.duration === d ? " is-selected" : "");
    el.dataset.dur = d;
    const price = state.plan ? PLANS[state.plan].prices[d] : null;
    el.innerHTML =
      `<span class="dur-name">${T.durLabel(d)}</span>` +
      `<span class="dur-price">${price != null ? T.yen(price) : "—"}</span>`;
    el.disabled = !state.plan;
    el.addEventListener("click", () => {
      state.duration = d;
      renderDurations();
      recalc();
    });
    return el;
  }

  function renderDurations() {
    const main = $("#durMain");
    const short = $("#durShort");
    main.innerHTML = "";
    short.innerHTML = "";
    MAIN_DURATIONS.forEach((d) => main.appendChild(durationButton(d)));
    SHORT_DURATIONS.forEach((d) => short.appendChild(durationButton(d)));
    $("#durHint").hidden = !!state.plan;
  }

  function renderAddons() {
    const wrap = $("#addonGrid");
    wrap.innerHTML = "";
    ADDONS.forEach((a) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "addon-chip" + (state.addons.has(a.key) ? " is-selected" : "");
      el.dataset.addon = a.key;
      el.innerHTML =
        `<span class="addon-photo"><img src="${a.img}" alt="${a[L()]}" loading="lazy" /><span class="addon-check" aria-hidden="true"></span></span>` +
        `<span class="addon-meta"><span class="addon-name">${a[L()]}</span>` +
        `<span class="addon-price">${T.yen(a.price)}</span></span>`;
      el.addEventListener("click", () => {
        if (state.addons.has(a.key)) state.addons.delete(a.key);
        else state.addons.add(a.key);
        renderAddons();
        recalc();
      });
      wrap.appendChild(el);
    });
  }

  function renderAreaTimeSelects() {
    const area = $("#fArea");
    area.innerHTML = "";
    AREAS.forEach((a) => {
      const o = document.createElement("option");
      o.value = a.key;
      o.textContent = a[L()] + (a.online ? "" : T.t("（市外・需報價）", "（市外・要見積り）"));
      area.appendChild(o);
    });
    area.value = state.area;

    const time = $("#fTime");
    const keep = time.value;
    time.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = T.t("請選擇時段", "時間帯を選択");
    ph.disabled = true;
    ph.selected = !keep;
    time.appendChild(ph);
    TIMES.forEach((tt) => {
      const o = document.createElement("option");
      o.value = tt.key;
      o.textContent = tt[L()];
      time.appendChild(o);
    });
    if (keep) time.value = keep;
  }

  function renderElevator() {
    const wrap = $("#fElevator");
    const keep = wrap.dataset.value || "";
    wrap.innerHTML = "";
    ELEVATORS.forEach((e) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "seg-btn" + (keep === e.key ? " is-selected" : "");
      el.dataset.val = e.key;
      el.textContent = e[L()];
      el.addEventListener("click", () => {
        wrap.dataset.value = e.key;
        renderElevator();
      });
      wrap.appendChild(el);
    });
  }

  /* =================== POSTAL CODE → ADDRESS (zipcloud) =================== */
  async function lookupPostal() {
    const raw = ($("#fPostal").value || "").replace(/[^0-9]/g, "");
    const hint = $("#postalHint");
    if (raw.length !== 7) {
      hint.hidden = false;
      hint.className = "field-hint err";
      hint.textContent = T.t("請輸入 7 位數郵便番號（例：530-0001）", "7桁の郵便番号を入力してください（例：530-0001）");
      return;
    }
    hint.hidden = false;
    hint.className = "field-hint";
    hint.textContent = T.t("查詢中…", "検索中…");
    try {
      const r = await fetch("https://zipcloud.ibsnet.co.jp/api/search?zipcode=" + raw);
      const j = await r.json();
      if (j.status === 200 && j.results && j.results.length) {
        const a = j.results[0];
        $("#fAddr1").value = `${a.address1}${a.address2}${a.address3}`;
        hint.className = "field-hint ok";
        hint.textContent = T.t("已帶入地址，請接著填寫番地與建物名", "住所を入力しました。番地・建物名をご記入ください");
        $("#fBanchi").focus();
        updateMapLink();
      } else {
        hint.className = "field-hint err";
        hint.textContent = T.t("查無此郵便番號，請確認後再試", "該当する住所が見つかりません。番号をご確認ください");
      }
    } catch (e) {
      hint.className = "field-hint err";
      hint.textContent = T.t("查詢失敗，請手動輸入地址", "検索に失敗しました。住所を手入力してください");
    }
  }

  /* =================== GOOGLE MAP CONFIRM =================== */
  function mapQuery() {
    const addr1 = $("#fAddr1").value.trim();
    const banchi = $("#fBanchi").value.trim();
    const building = $("#fBuilding").value.trim();
    return [addr1, banchi, building].filter(Boolean).join(" ").trim();
  }
  function updateMapLink() {
    const q = mapQuery();
    const link = $("#mapLink");
    const ready = $("#fAddr1").value.trim() && $("#fBanchi").value.trim();
    if (ready) {
      link.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
      link.classList.remove("is-disabled");
      link.setAttribute("aria-disabled", "false");
    } else {
      link.href = "#";
      link.classList.add("is-disabled");
      link.setAttribute("aria-disabled", "true");
    }
  }

  /* =================== TOTAL + SUMMARY =================== */
  function lineItems() {
    const items = [];
    if (state.plan && state.duration) {
      items.push({
        label: `${PLANS[state.plan].name[L()]} × ${T.durLabel(state.duration)}`,
        amount: PLANS[state.plan].prices[state.duration],
      });
    }
    ADDONS.forEach((a) => {
      if (state.addons.has(a.key)) items.push({ label: a[L()], amount: a.price });
    });
    return items;
  }

  function recalc() {
    const items = lineItems();
    const total = items.reduce((s, i) => s + i.amount, 0);
    const box = $("#sumItems");
    box.innerHTML = "";
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "sum-empty";
      p.textContent = T.t("請先選擇方案與租期", "プランとレンタル期間をお選びください");
      box.appendChild(p);
    } else {
      items.forEach((i) => {
        const row = document.createElement("div");
        row.className = "sum-row";
        row.innerHTML = `<span>${i.label}</span><span>${T.yen(i.amount)}</span>`;
        box.appendChild(row);
      });
    }
    $("#sumTotal").textContent = T.yen(total);

    const onlineArea = isOnlineArea();
    $("#shipNote").hidden = onlineArea;
    updateCta(total, onlineArea);
  }

  function isOnlineArea() {
    const a = AREAS.find((x) => x.key === state.area);
    return !!(a && a.online);
  }

  function updateCta(total, onlineArea) {
    const btn = $("#payBtn");
    const ready = state.plan && state.duration && total > 0;
    if (onlineArea) {
      btn.classList.remove("is-line");
      btn.textContent = ready
        ? T.t(`前往付款 ${T.yen(total)}`, `お支払いへ進む ${T.yen(total)}`)
        : T.t("前往付款", "お支払いへ進む");
    } else {
      btn.classList.add("is-line");
      btn.textContent = T.t("市外配送・透過 LINE 取得報價", "市外配送・LINE で見積り");
    }
  }

  /* =================== VALIDATION =================== */
  function fullAddress(d) {
    return [d.addr1, d.banchi, d.building].filter(Boolean).join(" ").trim();
  }

  function collectForm() {
    return {
      plan: state.plan,
      duration: state.duration,
      addons: Array.from(state.addons),
      area: state.area,
      moveInDate: $("#fDate").value.trim(),
      time: $("#fTime").value,
      postal: $("#fPostal").value.trim(),
      addr1: $("#fAddr1").value.trim(),
      banchi: $("#fBanchi").value.trim(),
      building: $("#fBuilding").value.trim(),
      room: $("#fNoRoom").checked ? "" : $("#fRoom").value.trim(),
      noRoom: $("#fNoRoom").checked,
      elevator: $("#fElevator").dataset.value || "",
      name: $("#fName").value.trim(),
      contact: $("#fContact").value.trim(),
      mapUrl: mapQuery() ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(mapQuery()) : "",
      lang: L(),
    };
  }

  function validate(d) {
    const miss = [];
    if (!d.plan) miss.push(T.t("方案", "プラン"));
    if (!d.duration) miss.push(T.t("租期", "レンタル期間"));
    if (!d.moveInDate) miss.push(T.t("入住日", "入居日"));
    if (!d.time) miss.push(T.t("到貨時段", "配送時間帯"));
    if (!d.addr1) miss.push(T.t("縣市區町名（可用郵便番號帶入）", "住所（郵便番号で自動入力可）"));
    if (!d.banchi) miss.push(T.t("丁目・番地・號", "番地"));
    if (!d.noRoom && !d.room) miss.push(T.t("房號（或勾選無房號）", "部屋番号（または「部屋番号なし」）"));
    if (!d.elevator) miss.push(T.t("電梯", "エレベーター"));
    if (!d.name) miss.push(T.t("姓名", "お名前"));
    if (!d.contact) miss.push(T.t("聯絡方式", "ご連絡先"));
    return miss;
  }

  function showError(msg) {
    const box = $("#formError");
    box.textContent = msg;
    box.hidden = !msg;
    if (msg) box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* =================== SUBMIT =================== */
  function buildLineDeeplink(d) {
    const items = lineItems();
    const total = items.reduce((s, i) => s + i.amount, 0);
    const areaName = (AREAS.find((a) => a.key === d.area) || {})[L()] || d.area;
    const lines = [
      T.t("您好，我想預訂年租方案（市外配送，想了解運費報價）：", "年間レンタルを予約したいです（市外配送・送料の見積り希望）："),
      `${T.t("方案", "プラン")}：${items[0] ? items[0].label : ""}`,
      d.addons.length
        ? `${T.t("加購", "追加")}：${ADDONS.filter((a) => state.addons.has(a.key)).map((a) => a[L()]).join("、")}`
        : "",
      `${T.t("小計", "小計")}：${T.yen(total)}（${T.t("未含市外運費", "市外送料別")}）`,
      `${T.t("配送地區", "配送エリア")}：${areaName}`,
      `${T.t("入住日", "入居日")}：${d.moveInDate}　${d.time}`,
      `${T.t("地址", "住所")}：〒${d.postal} ${fullAddress(d)} ${d.room}`.trim(),
      d.mapUrl ? `${T.t("地圖", "地図")}：${d.mapUrl}` : "",
      `${T.t("電梯", "EV")}：${d.elevator}`,
      `${T.t("姓名", "お名前")}：${d.name}`,
      `${T.t("聯絡", "連絡先")}：${d.contact}`,
    ].filter(Boolean);
    return "https://line.me/R/oaMessage/" + LINE_OA_BASIC_ID + "/?" + encodeURIComponent(lines.join("\n"));
  }

  async function onSubmit() {
    const d = collectForm();
    const miss = validate(d);
    if (miss.length) {
      showError(T.t("還缺：", "未入力：") + miss.join("、"));
      return;
    }
    showError("");

    if (!isOnlineArea()) {
      window.location.href = buildLineDeeplink(d);
      return;
    }

    const btn = $("#payBtn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = T.t("前往付款頁面…", "決済ページへ…");
    try {
      const payload = Object.assign({}, d, { address: fullAddress(d) });
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.url) throw new Error(json.error || "checkout_failed");
      window.location.href = json.url;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      showError(
        T.t("付款連線失敗，請稍後再試或透過 LINE 與我們聯繫。",
            "決済の接続に失敗しました。時間をおいて再度お試しいただくか、LINE までご連絡ください。")
      );
    }
  }

  /* =================== INIT =================== */
  function init() {
    renderPlans();
    renderDurations();
    renderAddons();
    renderAreaTimeSelects();
    renderElevator();

    const pre = new URLSearchParams(location.search).get("plan");
    if (pre && PLANS[pre.toUpperCase()]) {
      state.plan = pre.toUpperCase();
      state.duration = "1年";
      renderPlans();
      renderDurations();
    }

    $("#fArea").addEventListener("change", (e) => { state.area = e.target.value; recalc(); });
    $("#fTime").addEventListener("change", recalc);
    $("#fNoRoom").addEventListener("change", (e) => {
      $("#fRoom").disabled = e.target.checked;
      if (e.target.checked) $("#fRoom").value = "";
    });

    // postal autofill
    $("#postalBtn").addEventListener("click", lookupPostal);
    $("#fPostal").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookupPostal(); } });
    $("#fPostal").addEventListener("input", (e) => {
      const digits = e.target.value.replace(/[^0-9]/g, "");
      if (digits.length === 7) lookupPostal(); // auto when 7 digits typed
    });

    // map link updates as address changes
    ["#fAddr1", "#fBanchi", "#fBuilding"].forEach((s) =>
      $(s).addEventListener("input", updateMapLink)
    );

    $("#payBtn").addEventListener("click", onSubmit);

    // 語言切換時，重繪 JS 動態產生的字串
    new MutationObserver(() => {
      renderPlans();
      renderDurations();
      renderAddons();
      renderAreaTimeSelects();
      renderElevator();
      recalc();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

    const today = new Date();
    today.setDate(today.getDate() + 1);
    $("#fDate").min = today.toISOString().slice(0, 10);

    updateMapLink();
    recalc();
  }

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
