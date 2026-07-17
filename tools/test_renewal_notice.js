#!/usr/bin/env node
/* KUMAGO — 30天續租通知＋自動計價 離線測試（不碰網路）。
 *   node tools/test_renewal_notice.js
 */
"use strict";
const {
  buildNoticeTargets, buildRenewalNoticeFlex, parseLineFromDesc,
  runRenewalNotices, NOTICE_PROP,
} = require("../lib/renewal_notice.js");
const {
  parsePaidItemsFromDesc, computeRenewalPrice, durationLabel,
} = require("../lib/stripe_renewal.js");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name); }
}

const TODAY = "2026-08-01";
const mkExpiry = (over) => Object.assign({
  id: "ev1",
  summary: "【到期】測試甲（小甲） B 套組×1年",
  start: { date: "2026-08-31" }, // today+30
  description: "租期到期 測試甲\n聯絡：test@example.com\n\n── LINE ──\n顯示名：小甲\nuserId：U0123456789abcdef0123456789abcdef\n語言：zh",
  extendedProperties: { private: {} },
}, over);

console.log("— parseLineFromDesc —");
{
  const p = parseLineFromDesc(mkExpiry().description);
  ok(p.userId === "U0123456789abcdef0123456789abcdef", "抽出 userId");
  ok(p.lang === "zh", "抽出語言");
  ok(p.display === "小甲", "抽出顯示名");
  ok(parseLineFromDesc("沒有配對").userId === null, "無配對回 null");
  ok(parseLineFromDesc("LINE userId：U0123456789abcdef0123456789abcdef").userId !== null, "認得網站自動單格式（LINE userId：）");
}

console.log("— buildNoticeTargets 視窗與過濾 —");
{
  ok(buildNoticeTargets([mkExpiry()], TODAY).length === 1, "到期日 today+30 → 命中");
  ok(buildNoticeTargets([mkExpiry({ start: { date: "2026-08-28" } })], TODAY).length === 1, "today+27 → 命中（視窗下限）");
  ok(buildNoticeTargets([mkExpiry({ start: { date: "2026-08-27" } })], TODAY).length === 0, "today+26 → 不通知");
  ok(buildNoticeTargets([mkExpiry({ start: { date: "2026-09-01" } })], TODAY).length === 0, "today+31 → 還沒到");
  ok(buildNoticeTargets([mkExpiry({ summary: "【到期】測試甲 B 套組×1年 回收完畢" })], TODAY).length === 0, "已結案 → 跳過");
  ok(buildNoticeTargets([mkExpiry({ extendedProperties: { private: { [NOTICE_PROP]: "2026-07-30" } } })], TODAY).length === 0, "已通知過 → 跳過");
  ok(buildNoticeTargets([mkExpiry({ summary: "測試甲 入住配送 B 套組" })], TODAY).length === 0, "非到期事件 → 跳過");
  const t = buildNoticeTargets([mkExpiry()], TODAY)[0];
  ok(t.userId && t.lang === "zh" && t.daysLeft === 30, "target 帶 userId/lang/daysLeft");
  const noLine = buildNoticeTargets([mkExpiry({ description: "租期到期 測試甲" })], TODAY)[0];
  ok(noLine && noLine.userId === null, "無配對 → 仍列（走人工通知）");
}

console.log("— FLEX 結構 —");
{
  const t = buildNoticeTargets([mkExpiry()], TODAY)[0];
  const f = buildRenewalNoticeFlex(t);
  ok(f.type === "flex" && f.contents.type === "bubble", "flex bubble");
  const uris = JSON.stringify(f);
  ok(uris.includes(`/renewal?eid=${t.eventId}`), "續租按鈕帶事件 id");
  ok(uris.includes("/recovery"), "回收按鈕連 LIFF /recovery");
  ok(f.altText.includes("2026/08/31"), "altText 帶到期日");
  const en = buildRenewalNoticeFlex({ ...t, lang: "en" });
  ok(JSON.stringify(en).includes("Renew"), "英文版按鈕");
  const ja = buildRenewalNoticeFlex({ ...t, lang: "ja" });
  ok(JSON.stringify(ja).includes("継続"), "日文版按鈕");
}

console.log("— runRenewalNotices（stub deps）—");
{
  const pushed = [], patched = [], tg = [];
  const deps = {
    listEvents: async () => [
      mkExpiry(),
      mkExpiry({ id: "ev2", summary: "【到期】測試乙 C 套組×1年", description: "沒配對" }),
    ],
    patchEvent: async (id, p) => patched.push({ id, p }),
    sendLinePush: async (uid, msgs) => { pushed.push({ uid, msgs }); return { ok: true }; },
    sendTelegram: async (m) => tg.push(m),
    todayISO: TODAY,
  };
  runRenewalNotices(deps).then((r) => {
    ok(r.sent === 1 && r.manual === 1 && r.failed === 0, "1 推播＋1 人工");
    ok(pushed.length === 1 && pushed[0].uid.startsWith("U0123"), "推對人");
    ok(patched.length === 2 && patched.every((x) => x.p.extendedProperties.private[NOTICE_PROP] === TODAY), "兩事件都標記已通知");
    ok(tg.length === 1 && tg[0].includes("測試乙") && tg[0].includes("手動聯絡"), "TG 報告含人工名單");

    console.log("— 自動計價 —");
    const desc = [
      "🐻 KUMAGO 配送單", "",
      "【方案】B 套組 × 1 年",
      "【合計（已付款）】¥72,000", "",
      "── 明細 ──",
      "・B 套組 × 1 年　¥55,500",
      "・可調光吸頂燈　¥4,500",
      "・運費　¥8,000",
      "・搬運費（無電梯）　¥4,000",
    ].join("\n");
    const items = parsePaidItemsFromDesc(desc);
    ok(items.length === 4, "明細 4 行");
    const p12 = computeRenewalPrice(desc, 12, 12);
    ok(p12 && p12.baseAmount === 60000 && p12.amount === 60000, "續1年＝原價（排除運費/搬運）");
    const p6 = computeRenewalPrice(desc, 12, 6);
    ok(p6 && p6.amount === 30000, "半年＝原價一半");
    const p24 = computeRenewalPrice(desc, 12, 24);
    ok(p24 && p24.amount === 120000, "兩年＝原價兩倍");
    ok(computeRenewalPrice("手動單沒有明細", 12, 12) === null, "無明細 → null（人工報價）");
    ok(computeRenewalPrice("・怪東西　¥1", 12, 12) === null, "金額低於防呆下限 → null");
    ok(durationLabel(6) === "半年" && durationLabel(12) === "1年" && durationLabel(24) === "2年", "durationLabel");

    console.log(fail ? `\n❌ ${fail} 項失敗（${pass} 過）` : `\n✅ 全部通過（${pass} 項）`);
    process.exit(fail ? 1 : 0);
  });
}
