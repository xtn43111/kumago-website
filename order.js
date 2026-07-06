/* KUMAGO 年租方案線上訂購 — order page logic
   - Prices / add-ons mirror the live LINE order system (plan_data.py / fixed_reply.py).
   - The browser computes totals only for display; the authoritative total is
     recomputed server-side in /api/create-checkout-session before charging. */
(function () {
  "use strict";

  /* =================== LINE OA (市外報價導流用) ===================
     市外（奈良・京都・兵庫）運費需人工報價，導去 LINE 預填訂單摘要。
     ▼ 換成實際的 LINE 官方帳號 Basic ID（含 @）。 */
  const LINE_OA_BASIC_ID = "@967bmevi"; // KUMAGO 官方帳號（lin.ee/z3yASqK）

  /* =================== DATA =================== */
  // 期別價格完全對齊 plan_data.PLANS
  const PLANS = {
    A: {
      name: { zh: "A 套組", ja: "A セット", en: "Set A" },
      desc: { zh: "冷凍冷藏庫 90–130L・洗衣機 4.2–6kg・微波爐",
              ja: "冷凍冷蔵庫 90〜130L・洗濯機 4.2〜6kg・電子レンジ",
              en: "Fridge-freezer 90–130L, washing machine 4.2–6kg, microwave" },
      img: "assets/sets/set_A.jpg",
      prices: { "1個月": 28400, "2個月": 31130, "3個月": 32920, "4個月": 36250,
                "5個月": 37430, "半年": 38490, "1年": 45100, "2年": 63250 },
    },
    B: {
      name: { zh: "B 套組", ja: "B セット", en: "Set B" },
      desc: { zh: "A 套組 ＋ 單人床架與床墊（寬 100cm）",
              ja: "A セット ＋ シングルベッドフレーム・マットレス（幅100cm）",
              en: "Set A + single bed frame & mattress (100cm wide)" },
      img: "assets/sets/set_B.jpg",
      prices: { "1個月": 32910, "2個月": 35640, "3個月": 38400, "4個月": 41820,
                "5個月": 43640, "半年": 46270, "1年": 55080, "2年": 69990 },
    },
    C: {
      name: { zh: "C 套組", ja: "C セット", en: "Set C" },
      desc: { zh: "A 套組 ＋ 單人加大床架與床墊（寬 120cm）",
              ja: "A セット ＋ セミダブルベッドフレーム・マットレス（幅120cm）",
              en: "Set A + semi-double bed frame & mattress (120cm wide)" },
      img: "assets/sets/set_C.jpg",
      prices: { "1個月": 46980, "2個月": 49360, "3個月": 52430, "4個月": 55690,
                "5個月": 59350, "半年": 62340, "1年": 72320, "2年": 91630 },
    },
  };

  // 主推年租在前；短期收在折疊區
  const MAIN_DURATIONS = ["半年", "1年", "2年"];
  const SHORT_DURATIONS = ["1個月", "2個月", "3個月", "4個月", "5個月"];

  const ADDONS = [
    { key: "floor_mat",     price: 1800, zh: "地板保護墊",   ja: "フロアマット", en: "Floor protection mat" },
    { key: "kettle",        price: 4500, zh: "熱水壺",       ja: "電気ケトル", en: "Electric kettle" },
    { key: "ceiling_light", price: 4500, zh: "可調光吸頂燈", ja: "調光シーリングライト", en: "Dimmable ceiling light" },
    { key: "curtain",       price: 4900, zh: "4 片窗簾組",   ja: "カーテン4枚セット", en: "Curtain set (4 panels)" },
    { key: "vacuum",        price: 4500, zh: "吸塵器",       ja: "掃除機", en: "Vacuum cleaner" },
    { key: "fan",           price: 4500, zh: "電風扇",       ja: "扇風機", en: "Electric fan" },
    { key: "clothes_rack",  price: 4500, zh: "室內掛衣架",   ja: "室内物干しラック", en: "Indoor drying rack" },
    { key: "desk",          price: 9000, zh: "桌椅組",       ja: "デスク・チェアセット", en: "Desk & chair set" },
    { key: "low_table",     price: 6000, zh: "和式桌（75×50×31.5cm）", ja: "和式テーブル（75×50×31.5cm）", en: "Low table (75×50×31.5cm)" },
    { key: "rice_cooker",   price: 7000, zh: "電飯鍋",       ja: "炊飯器", en: "Rice cooker" },
    { key: "pot",           price: 7000, zh: "鍋具組",       ja: "鍋セット", en: "Pot set" },
    { key: "clothesline",   price: 1800, zh: "曬衣桿",       ja: "物干し竿", en: "Drying pole" },
  ].map((a) => ({ ...a, img: `assets/addons/${a.key}.jpg` }));

  /* =================== 配送費（依郵便番號辨識的市區自動計算） ===================
     大阪市內無料；大阪府其他市、奈良・京都・兵庫依下表加收市外配送費。
     清單外的地區無法線上估價 → 導去 LINE 人工報價。
     ⚠ 與後端 api/create-checkout-session.js 的 shippingFee() 必須保持同步。 */
  const SHIP_OSAKA_TIERS = [
    { fee: 6600,  cities: ["堺市", "松原市", "東大阪市"] },
    { fee: 9800,  cities: ["藤井寺市", "八尾市", "大阪狭山市", "柏原市", "守口市", "門真市",
                           "大東市", "豊中市", "吹田市", "高石市", "泉大津市", "和泉市",
                           "岸和田市", "寝屋川市", "枚方市", "茨木市", "摂津市", "池田市", "箕面市"] },
    { fee: 13800, cities: ["高槻市", "交野市", "四條畷市", "四条畷市", "泉佐野市", "貝塚市",
                           "富田林市", "羽曳野市", "阪南市", "河内長野市", "泉南市"] },
  ];

  // 京都府：京都市 ¥18,000／下列近郊市 ¥25,000／其餘不在配送範圍
  const KYOTO_25000 = ["向日市", "長岡京市", "八幡市", "京田辺市", "宇治市", "城陽市", "木津川市", "亀岡市"];
  // 奈良県：奈良・天理・橿原 ¥15,800／下列近郊市 ¥18,000／其餘不在配送範圍
  const NARA_15800 = ["奈良市", "天理市", "橿原市"];
  const NARA_18000 = ["生駒市", "大和郡山市", "香芝市", "葛城市", "大和高田市"];
  // 兵庫県：下列阪神間 8 市のみ ¥18,000／其餘（播磨・西部・北部・淡路島等）不在配送範圍
  const HYOGO_18000 = ["神戸市", "尼崎市", "西宮市", "芦屋市", "伊丹市", "宝塚市", "川西市", "三田市"];

  // zipcloud の address1（都道府県）＋ address2（市区町村）から配送費を判定。
  // fee: 0=大阪市内無料 / 数値=市外配送費 / null=配送対象エリア外（LINE 洽詢）
  function shippingFor(pref, city) {
    pref = pref || "";
    city = city || "";
    const has = (name) => city.indexOf(name) === 0; // 政令市は「堺市堺区」等 → 前方一致
    // en falls back to the raw (Japanese-script) city name, same as zh/ja do
    // for tiers where no explicit label is given below — we never invent romaji.
    const ok = (fee, zh, ja, en) => ({ fee, online: true, zh: zh || city, ja: ja || city, en: en || zh || city });
    const no = () => ({ fee: null, online: false, zh: city || pref || "", ja: city || pref || "", en: city || pref || "" });
    if (pref === "大阪府") {
      if (has("大阪市")) return ok(0, "大阪市內（免費配送）", "大阪市内（配送無料）", "Osaka City (free delivery)");
      for (const tier of SHIP_OSAKA_TIERS) if (tier.cities.some(has)) return ok(tier.fee);
      return no();
    }
    if (pref === "京都府") {
      if (has("京都市")) return ok(18000, "京都市", "京都市", "Kyoto City");
      if (KYOTO_25000.some(has)) return ok(25000);
      return no();
    }
    if (pref === "奈良県") {
      if (NARA_15800.some(has)) return ok(15800);
      if (NARA_18000.some(has)) return ok(18000);
      return no();
    }
    if (pref === "兵庫県") {
      if (HYOGO_18000.some(has)) return ok(18000);
      return no();
    }
    return no();
  }

  const SHIP_FEE_LABEL = { zh: "市外配送費", ja: "市外配送料", en: "Out-of-city delivery fee" };
  const SHIP_FREE_LABEL = { zh: "大阪市內配送", ja: "大阪市内配送", en: "Osaka City delivery" };

  const TIMES = [
    { key: "09-1130", zh: "09:00–11:30", ja: "09:00〜11:30", en: "09:00–11:30" },
    { key: "1230-16", zh: "12:30–16:00", ja: "12:30〜16:00", en: "12:30–16:00" },
  ];

  const ELEVATORS = [
    { key: "有",     zh: "有電梯",   ja: "エレベーターあり", en: "Elevator available" },
    { key: "無",     zh: "無電梯",   ja: "エレベーターなし", en: "No elevator" },
  ];

  // 無電梯時的人工樓層搬運費（與後端 create-checkout-session.js 同步）
  const NO_ELEVATOR_FEE = 3300;
  const NO_ELEVATOR_LABEL = { zh: "無電梯樓層搬運費", ja: "エレベーターなし階上げ料", en: "No-elevator carry-up fee" };

  const MAP_CONFIRMS = [
    { key: "correct",   zh: "位置正確",   ja: "位置は正しい", en: "Location is correct" },
    { key: "incorrect", zh: "位置不正確", ja: "位置が違う", en: "Location is incorrect" },
  ];

  /* =================== i18n micro-helpers =================== */
  const L = () => {
    const lang = document.documentElement.lang;
    if (lang === "ja") return "ja";
    if (lang === "en") return "en";
    return "zh";
  };
  const T = {
    durLabel: (d) => {
      const lang = L();
      if (d === "半年") return lang === "en" ? "6 Months" : "半年";
      if (d === "1年") return lang === "en" ? "1 Year" : "1 年";
      if (d === "2年") return lang === "en" ? "2 Years" : "2 年";
      const n = d.replace("個月", "");
      if (lang === "ja") return `${n} ヶ月`;
      if (lang === "en") return `${n} Month${n === "1" ? "" : "s"}`;
      return `${n} 個月`;
    },
    yen: (n) => "¥" + n.toLocaleString("ja-JP"),
    // Third arg (en) is optional — omit it to safely fall back to the zh string
    // (never renders undefined/blank for languages we haven't translated yet).
    t: (zh, ja, en) => {
      const lang = L();
      if (lang === "ja") return ja;
      if (lang === "en") return en !== undefined ? en : zh;
      return zh;
    },
  };

  /* =================== STATE =================== */
  const state = {
    plan: null,
    duration: null,
    addons: new Set(),
    shipPref: "",     // 郵便番號查到的都道府県
    shipCity: "",     // 郵便番號查到的市区町村
    ship: null,       // shippingFor() 的結果，null = 尚未查郵便番號
    mapConfirm: null, // null | "correct" | "incorrect"
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
          `<span class="opt-from">${T.t("最低", "最安", "From")} ${T.yen(Math.min.apply(null, Object.values(p.prices)))}~</span>` +
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

  function renderTimeSelect() {
    const time = $("#fTime");
    const keep = time.value;
    time.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = T.t("請選擇時段", "時間帯を選択", "Select a time slot");
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

  // 配送區域 + 配送費的即時提示（依郵便番號自動判定）
  function renderShipZone() {
    const box = $("#shipZone");
    if (!box) return;
    const s = state.ship;
    if (!s) {
      box.hidden = true;
      box.className = "ship-zone";
      box.textContent = "";
      return;
    }
    box.hidden = false;
    if (!s.online) {
      box.className = "ship-zone warn";
      box.textContent = T.t(
        `很抱歉，「${s.zh}」目前不在配送範圍內。如有需要請透過 LINE 與我們聯繫。`,
        `申し訳ございません。「${s.ja}」は配送対象エリア外です。ご希望の場合は LINE までご連絡ください。`,
        `Sorry, "${s.en}" is currently outside our delivery area. Please contact us on LINE if you need service there.`
      );
    } else if (s.fee === 0) {
      box.className = "ship-zone ok";
      box.textContent = T.t(`配送地區：${s.zh}・免運費`, `配送エリア：${s.ja}・送料無料`, `Delivery area: ${s.en} · Free delivery`);
    } else {
      box.className = "ship-zone";
      box.textContent = T.t(
        `配送地區：${s.zh}・市外配送費 ${T.yen(s.fee)}`,
        `配送エリア：${s.ja}・市外送料 ${T.yen(s.fee)}`,
        `Delivery area: ${s.en} · Out-of-city delivery fee ${T.yen(s.fee)}`
      );
    }
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
        recalc(); // 無電梯 → 加樓層搬運費，需重算合計
      });
      wrap.appendChild(el);
    });
  }

  function elevatorValue() {
    return $("#fElevator").dataset.value || "";
  }

  /* =================== POSTAL CODE → ADDRESS (zipcloud) =================== */
  async function lookupPostal() {
    const raw = ($("#fPostal").value || "").replace(/[^0-9]/g, "");
    const hint = $("#postalHint");
    if (raw.length !== 7) {
      hint.hidden = false;
      hint.className = "field-hint err";
      hint.textContent = T.t("請輸入 7 位數郵便番號（例：530-0001）", "7桁の郵便番号を入力してください（例：530-0001）", "Please enter a 7-digit postal code (e.g. 530-0001)");
      return;
    }
    hint.hidden = false;
    hint.className = "field-hint";
    hint.textContent = T.t("查詢中…", "検索中…", "Searching…");
    try {
      const r = await fetch("https://zipcloud.ibsnet.co.jp/api/search?zipcode=" + raw);
      const j = await r.json();
      if (j.status === 200 && j.results && j.results.length) {
        const a = j.results[0];
        $("#fAddr1").value = `${a.address1}${a.address2}${a.address3}`;
        // 依都道府県＋市区町村判定配送區域與運費
        state.shipPref = a.address1 || "";
        state.shipCity = a.address2 || "";
        state.ship = shippingFor(state.shipPref, state.shipCity);
        renderShipZone();
        hint.className = "field-hint ok";
        hint.textContent = T.t("已帶入地址，請接著填寫番地與建物名", "住所を入力しました。番地・建物名をご記入ください", "Address filled in — please enter your block/lot number and building name");
        $("#fBanchi").focus();
        updateMapLink();
        recalc(); // 運費可能變動 → 重算合計與按鈕
      } else {
        hint.className = "field-hint err";
        hint.textContent = T.t("查無此郵便番號，請確認後再試", "該当する住所が見つかりません。番号をご確認ください", "No matching address found. Please check the postal code and try again");
      }
    } catch (e) {
      hint.className = "field-hint err";
      hint.textContent = T.t("查詢失敗，請手動輸入地址", "検索に失敗しました。住所を手入力してください", "Search failed. Please enter your address manually");
    }
  }

  /* =================== GOOGLE MAP CONFIRM =================== */
  function mapQuery() {
    const addr1 = $("#fAddr1").value.trim();
    const banchi = $("#fBanchi").value.trim();
    const building = $("#fBuilding").value.trim();
    return [addr1, banchi, building].filter(Boolean).join(" ").trim();
  }
  function searchMapUrl() {
    const q = mapQuery();
    return q ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q) : "";
  }
  function customMapUrl() {
    return ($("#fMapUrl").value || "").trim();
  }
  // The URL submitted with the order: customer-supplied if they flagged the
  // auto-located pin as wrong, otherwise the address-search link.
  function resolvedMapUrl() {
    if (state.mapConfirm === "incorrect" && customMapUrl()) return customMapUrl();
    return searchMapUrl();
  }

  function renderMapConfirm() {
    const wrap = $("#mapConfirmSeg");
    wrap.innerHTML = "";
    MAP_CONFIRMS.forEach((m) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "seg-btn" + (state.mapConfirm === m.key ? " is-selected" : "");
      el.dataset.val = m.key;
      el.textContent = m[L()];
      el.addEventListener("click", () => {
        state.mapConfirm = m.key;
        renderMapConfirm();
        // Custom-URL field only appears when the pin is flagged wrong;
        // a confirmed-correct pin just gets a checkmark beside the URL.
        $("#mapCustomWrap").hidden = m.key !== "incorrect";
        $("#mapUrlOk").hidden = m.key !== "correct";
      });
      wrap.appendChild(el);
    });
  }

  function updateMapLink() {
    const url = searchMapUrl();
    const link = $("#mapLink");
    const ready = !!($("#fAddr1").value.trim() && $("#fBanchi").value.trim());
    if (ready) {
      link.href = url;
      link.classList.remove("is-disabled");
      link.setAttribute("aria-disabled", "false");
    } else {
      link.href = "#";
      link.classList.add("is-disabled");
      link.setAttribute("aria-disabled", "true");
    }

    // Show the URL text + the correct/incorrect confirmation only once ready.
    const urlLine = $("#mapUrlLine");
    const urlText = $("#mapUrlText");
    urlLine.hidden = !ready;
    $("#mapCheck").hidden = !ready;
    if (ready) {
      urlText.href = url;
      // Show a human-readable form (decoded query) while linking to the real URL.
      let display = url;
      try { display = decodeURIComponent(url); } catch (e) { /* keep raw */ }
      urlText.textContent = display;
      $("#mapUrlOk").hidden = state.mapConfirm !== "correct";
    } else {
      urlText.href = "#";
      urlText.textContent = "";
      $("#mapUrlOk").hidden = true;
      $("#mapCustomWrap").hidden = true;
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
    // 無電梯樓層搬運費（僅在已選方案＋租期、即有實際訂單時加上）
    if (state.plan && state.duration && elevatorValue() === "無") {
      items.push({ label: NO_ELEVATOR_LABEL[L()], amount: NO_ELEVATOR_FEE });
    }
    // 市外配送費（依郵便番號判定；大阪市內為 0，僅作免運提示，不計入金額）
    if (state.plan && state.duration && state.ship && state.ship.online && state.ship.fee > 0) {
      items.push({ label: `${SHIP_FEE_LABEL[L()]}（${state.ship[L()]}）`, amount: state.ship.fee });
    }
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
      p.textContent = T.t("請先選擇方案與租期", "プランとレンタル期間をお選びください", "Please choose a set and rental term first");
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

    // 市外（清單外）才顯示需 LINE 報價的提示
    $("#shipNote").hidden = !(state.ship && !state.ship.online);
    updateCta(total);
  }

  // 已查到郵便番號且屬於可線上估價的地區
  function isOnlineArea() {
    return !!(state.ship && state.ship.online);
  }

  function updateCta(total) {
    const btn = $("#payBtn");
    const ready = state.plan && state.duration && total > 0;
    // 清單外地區 → 走 LINE 報價；其餘（含尚未輸入郵便番號）→ 線上付款
    if (state.ship && !state.ship.online) {
      btn.classList.add("is-line");
      btn.textContent = T.t("此地區請透過 LINE 洽詢", "対象エリア外・LINE でお問い合わせ", "Outside delivery area — please contact us on LINE");
    } else {
      btn.classList.remove("is-line");
      btn.textContent = ready
        ? T.t(`前往付款 ${T.yen(total)}`, `お支払いへ進む ${T.yen(total)}`, `Proceed to Payment ${T.yen(total)}`)
        : T.t("前往付款", "お支払いへ進む", "Proceed to Payment");
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
      shipPref: state.shipPref,
      shipCity: state.shipCity,
      shipFee: state.ship ? state.ship.fee : null,
      area: state.ship ? state.ship.zh : "",
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
      note: $("#fNote").value.trim(),
      mapUrl: resolvedMapUrl(),
      mapConfirm: state.mapConfirm || "",
      mapCorrected: state.mapConfirm === "incorrect" && !!customMapUrl(),
      lang: L(),
    };
  }

  function validate(d) {
    const miss = [];
    if (!d.plan) miss.push(T.t("方案", "プラン", "Set"));
    if (!d.duration) miss.push(T.t("租期", "レンタル期間", "Rental term"));
    if (!d.moveInDate) miss.push(T.t("入住日", "入居日", "Move-in date"));
    if (!d.time) miss.push(T.t("到貨時段", "配送時間帯", "Delivery time slot"));
    if (!state.ship) miss.push(T.t("郵便番號（以確認配送費）", "郵便番号（送料の確認のため）", "Postal code (to confirm delivery fee)"));
    if (!d.addr1) miss.push(T.t("縣市區町名（可用郵便番號帶入）", "住所（郵便番号で自動入力可）", "Address (auto-fillable via postal code)"));
    if (!d.banchi) miss.push(T.t("丁目・番地・號", "番地", "Block/lot number"));
    if (!d.noRoom && !d.room) miss.push(T.t("房號（或勾選無房號）", "部屋番号（または「部屋番号なし」）", "Room number (or check \"no room number\")"));
    if (!d.elevator) miss.push(T.t("電梯", "エレベーター", "Elevator"));
    if (d.mapConfirm === "incorrect" && !customMapUrl())
      miss.push(T.t("正確位置的 Google 地圖網址", "正しい位置の Googleマップ URL", "Google Maps URL for the correct location"));
    if (!d.name) miss.push(T.t("姓名", "お名前", "Name"));
    if (!d.contact) miss.push(T.t("聯絡方式", "ご連絡先", "Contact info"));
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
    const areaName = (state.ship && state.ship[L()]) || d.area || `〒${d.postal}`;
    const lines = [
      T.t("您好，我想預訂年租方案，想確認這個地區是否能配送：", "年間レンタルを予約したいです。配送可否を確認したいです：", "Hi, I'd like to book an annual rental plan. Could you confirm if delivery is available in this area:"),
      `${T.t("方案", "プラン", "Plan")}：${items[0] ? items[0].label : ""}`,
      d.addons.length
        ? `${T.t("加購", "追加", "Add-ons")}：${ADDONS.filter((a) => state.addons.has(a.key)).map((a) => a[L()]).join("、")}`
        : "",
      `${T.t("小計", "小計", "Subtotal")}：${T.yen(total)}（${T.t("未含市外運費", "市外送料別", "excl. out-of-city delivery fee")}）`,
      `${T.t("配送地區", "配送エリア", "Delivery area")}：${areaName}`,
      `${T.t("入住日", "入居日", "Move-in date")}：${d.moveInDate}　${d.time}`,
      `${T.t("地址", "住所", "Address")}：〒${d.postal} ${fullAddress(d)} ${d.room}`.trim(),
      d.mapUrl ? `${T.t("地圖", "地図", "Map")}：${d.mapUrl}` : "",
      `${T.t("電梯", "EV", "Elevator")}：${d.elevator}`,
      `${T.t("姓名", "お名前", "Name")}：${d.name}`,
      `${T.t("聯絡", "連絡先", "Contact")}：${d.contact}`,
      d.note ? `${T.t("備註", "備考", "Note")}：${d.note}` : "",
    ].filter(Boolean);
    return "https://line.me/R/oaMessage/" + LINE_OA_BASIC_ID + "/?" + encodeURIComponent(lines.join("\n"));
  }

  /* Build the post-payment LINE handoff and stash it for success.html to pick up.
     After Stripe redirects back to /success (same browser/origin), the success page
     reads this from localStorage and guides the customer to add the official LINE
     and send their full order details to 客服. */
  function buildPaidOrderStash(d) {
    const items = lineItems();
    const total = items.reduce((s, i) => s + i.amount, 0);
    const areaName = (state.ship && state.ship[L()]) || d.area || `〒${d.postal}`;
    // Customer/delivery info up top (who・when・where) so 客服 can act at a glance;
    // items + total drop to the bottom. null = drop optional line, "" = blank spacer.
    const lines = [
      T.t("【KUMAGO 線上訂單・已完成付款】", "【KUMAGO オンライン注文・決済完了】", "[KUMAGO Online Order – Payment Completed]"),
      "",
      `${T.t("姓名", "お名前", "Name")}：${d.name}`,
      `${T.t("聯絡", "連絡先", "Contact")}：${d.contact}`,
      `${T.t("入住日", "入居日", "Move-in date")}：${d.moveInDate}　${d.time}`,
      `${T.t("配送地區", "配送エリア", "Delivery area")}：${areaName}`,
      `${T.t("地址", "住所", "Address")}：〒${d.postal} ${fullAddress(d)} ${d.room}`.trim(),
      d.mapUrl ? `${T.t("地圖", "地図", "Map")}：${d.mapUrl}` : null,
      `${T.t("電梯", "EV", "Elevator")}：${d.elevator}`,
      d.note ? `${T.t("備註", "備考", "Note")}：${d.note}` : null,
      "",
      T.t("―― 訂單明細 ――", "―― 注文明細 ――", "―― Order Details ――"),
      ...items.map((i) => `・${i.label}　${T.yen(i.amount)}`),
      `${T.t("總金額", "合計", "Total")}：${T.yen(total)}`,
      "",
      T.t("（已完成線上付款，麻煩協助確認配送日期與時段，謝謝！）",
          "（オンライン決済が完了しました。配送日時のご確認をお願いいたします。）",
          "(Payment completed online. Please confirm the delivery date and time. Thank you!)"),
    ].filter((l) => l !== null);
    const msg = lines.join("\n");
    return {
      msg: msg,
      deeplink: "https://line.me/R/oaMessage/" + LINE_OA_BASIC_ID + "/?" + encodeURIComponent(msg),
      addFriend: "https://lin.ee/z3yASqK",
      lang: L(),
    };
  }

  async function onSubmit() {
    const d = collectForm();
    const miss = validate(d);
    if (miss.length) {
      showError(T.t("還缺：", "未入力：", "Missing: ") + miss.join("、"));
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
    btn.textContent = T.t("前往付款頁面…", "決済ページへ…", "Redirecting to payment…");
    try {
      const payload = Object.assign({}, d, { address: fullAddress(d) });
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.url) throw new Error(json.error || "checkout_failed");
      // Stash the order so success.html can route the customer to LINE 客服.
      try { localStorage.setItem("kumago_paid_order", JSON.stringify(buildPaidOrderStash(d))); } catch (e) {}
      window.location.href = json.url;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      showError(
        T.t("付款連線失敗，請稍後再試或透過 LINE 與我們聯繫。",
            "決済の接続に失敗しました。時間をおいて再度お試しいただくか、LINE までご連絡ください。",
            "Payment connection failed. Please try again later or contact us on LINE.")
      );
    }
  }

  /* =================== INIT =================== */
  function init() {
    renderPlans();
    renderDurations();
    renderAddons();
    renderTimeSelect();
    renderShipZone();
    renderElevator();
    renderMapConfirm();

    const pre = new URLSearchParams(location.search).get("plan");
    if (pre && PLANS[pre.toUpperCase()]) {
      state.plan = pre.toUpperCase();
      state.duration = "1年";
      renderPlans();
      renderDurations();
    }

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

    // map link updates as address changes; a changed address invalidates any
    // prior correct/incorrect confirmation, so reset it.
    function onAddrChange() {
      if (state.mapConfirm) {
        state.mapConfirm = null;
        renderMapConfirm();
        $("#mapCustomWrap").hidden = true;
        $("#mapUrlOk").hidden = true;
      }
      updateMapLink();
    }
    ["#fAddr1", "#fBanchi", "#fBuilding"].forEach((s) =>
      $(s).addEventListener("input", onAddrChange)
    );

    $("#payBtn").addEventListener("click", onSubmit);

    // 語言切換時，重繪 JS 動態產生的字串
    new MutationObserver(() => {
      renderPlans();
      renderDurations();
      renderAddons();
      renderTimeSelect();
      renderShipZone();
      renderElevator();
      renderMapConfirm();
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
