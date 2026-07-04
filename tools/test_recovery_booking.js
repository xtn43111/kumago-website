/* 離線測 api/create-recovery-booking.js —— mock 掉 gcal/telegram，不碰網路。
 * 跑：node tools/test_recovery_booking.js */
"use strict";
const assert = require("assert");
const path = require("path");

// 先攔截 lib，再 require handler（require 快取讓 monkeypatch 生效）。
const gcal = require("../lib/gcal.js");
const telegram = require("../lib/telegram.js");

// handler 在 require 時就解構綁定 insertEvent/sendTelegram，故用「可變 impl」包裝：
// 綁定的是 wrapper，wrapper 每次呼叫都讀最新 impl，中途換 impl 才生效。
const calls = { insert: [], tg: [] };
let insertImpl = async (event, eventId) => { calls.insert.push({ event, eventId }); return { htmlLink: "x", eventId }; };
let tgImpl = async (text) => { calls.tg.push(text); return 1; };
gcal.isConfigured = () => true;
gcal.insertEvent = (...a) => insertImpl(...a);
telegram.sendTelegram = (...a) => tgImpl(...a);

const handler = require("../api/create-recovery-booking.js");
const { buildRecoveryEvent, normalizeInput } = handler;

function mockRes() {
  return {
    _status: 0, _json: null,
    status(c) { this._status = c; return this; },
    setHeader() { return this; },
    json(o) { this._json = o; return this; },
  };
}
async function run(method, body) {
  const res = mockRes();
  await handler({ method, body }, res);
  return res;
}

(async () => {
  let n = 0, pass = 0;
  const ok = (name, fn) => { n++; try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.error("  ✗", name, "\n     ", e.message); } };

  // --- pure: normalizeInput ---
  ok("normalizeInput 缺欄位回 missing", () => {
    const r = normalizeInput({ name: "", phone: "", address: "", date: "bad", slot: "x" });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.missing.sort(), ["address", "date", "name", "phone", "slot"]);
  });
  ok("normalizeInput 好資料通過並截斷備註", () => {
    const r = normalizeInput({ name: " 王小明 ", phone: "090", address: "大阪", date: "2026-08-01", slot: "09-1130", note: "x".repeat(600) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.name, "王小明");
    assert.strictEqual(r.value.note.length, 500);
  });

  // --- pure: buildRecoveryEvent ---
  ok("事件標題含「回收」且含姓名", () => {
    const { event } = buildRecoveryEvent({ name: "王小明", phone: "090", address: "大阪市北区", date: "2026-08-01", slot: "09-1130", note: "" });
    assert.ok(event.summary.includes("回收"), "summary 需含回收");
    assert.ok(event.summary.includes("王小明"), "summary 需含姓名");
  });
  ok("上午時段對映 09:00–11:30 timed event", () => {
    const { event } = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-01", slot: "09-1130", note: "" });
    assert.strictEqual(event.start.dateTime, "2026-08-01T09:00:00");
    assert.strictEqual(event.end.dateTime, "2026-08-01T11:30:00");
    assert.strictEqual(event.start.timeZone, "Asia/Tokyo");
  });
  ok("下午時段對映 12:30–16:00", () => {
    const { event } = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-01", slot: "1230-16", note: "" });
    assert.strictEqual(event.start.dateTime, "2026-08-01T12:30:00");
    assert.strictEqual(event.end.dateTime, "2026-08-01T16:00:00");
  });
  ok("整天皆可 → all-day 事件、隔日結束", () => {
    const { event } = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-01", slot: "any", note: "" });
    assert.strictEqual(event.start.date, "2026-08-01");
    assert.strictEqual(event.end.date, "2026-08-02");
    assert.ok(!event.start.dateTime);
  });
  ok("備註寫進說明；無備註則不出現", () => {
    const withNote = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-01", slot: "any", note: "只收冰箱" }).event;
    assert.ok(withNote.description.includes("只收冰箱"));
    const noNote = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-01", slot: "any", note: "" }).event;
    assert.ok(!noNote.description.includes("【備註】"));
  });
  ok("同內容 → 相同冪等 id；改任一欄 → 不同 id", () => {
    const a = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-01", slot: "any", note: "" }).eventId;
    const b = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-01", slot: "any", note: "改備註不影響id" }).eventId;
    const c = buildRecoveryEvent({ name: "A", phone: "1", address: "x", date: "2026-08-02", slot: "any", note: "" }).eventId;
    assert.strictEqual(a, b, "備註不影響 id");
    assert.notStrictEqual(a, c, "日期不同 id 應不同");
    assert.match(a, /^[0-9a-f]{40}$/);
  });

  // --- handler HTTP 流程 ---
  ok("GET → 405", async () => {}); // 佔位，async 版在下面單獨跑
  await (async () => {
    const res = await run("GET", null);
    n++; try { assert.strictEqual(res._status, 405); pass++; console.log("  ✓ GET → 405"); } catch (e) { console.error("  ✗ GET → 405", e.message); }
  })();
  await (async () => {
    const res = await run("POST", { name: "", phone: "", address: "", date: "", slot: "" });
    n++; try { assert.strictEqual(res._status, 400); assert.strictEqual(res._json.error, "missing_fields"); pass++; console.log("  ✓ POST 缺欄位 → 400"); } catch (e) { console.error("  ✗ POST 缺欄位 → 400", e.message); }
  })();
  calls.insert.length = 0; calls.tg.length = 0;
  await (async () => {
    const res = await run("POST", { name: "測試客", phone: "090-1111-2222", address: "大阪市北区梅田 1-2-3", date: "2026-08-15", slot: "1230-16", note: "只回收洗衣機" });
    n++;
    try {
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._json.ok, true);
      assert.strictEqual(calls.insert.length, 1, "應呼叫 insertEvent 一次");
      assert.ok(calls.insert[0].event.summary.includes("回收"));
      assert.match(calls.insert[0].eventId, /^[0-9a-f]{40}$/);
      assert.strictEqual(calls.tg.length, 1, "應推 Telegram 一次");
      assert.ok(calls.tg[0].includes("測試客"));
      pass++; console.log("  ✓ POST 好資料 → 200 + 寫行事曆 + 推 Telegram");
    } catch (e) { console.error("  ✗ POST 好資料 → 200", e.message); }
  })();
  // Telegram 掛掉不應害 200 變失敗
  tgImpl = async () => { throw new Error("tg down"); };
  await (async () => {
    const res = await run("POST", { name: "客B", phone: "090", address: "大阪", date: "2026-09-01", slot: "any" });
    n++; try { assert.strictEqual(res._status, 200); assert.strictEqual(res._json.telegram, false); pass++; console.log("  ✓ Telegram 失敗仍回 200（telegram:false）"); } catch (e) { console.error("  ✗ Telegram 失敗仍回 200", e.message); }
  })();
  // 行事曆掛掉 → 502
  insertImpl = async () => { throw new Error("cal down"); };
  await (async () => {
    const res = await run("POST", { name: "客C", phone: "090", address: "大阪", date: "2026-09-01", slot: "any" });
    n++; try { assert.strictEqual(res._status, 502); pass++; console.log("  ✓ 行事曆失敗 → 502"); } catch (e) { console.error("  ✗ 行事曆失敗 → 502", e.message); }
  })();

  console.log(`\n${pass}/${n} 通過`);
  process.exit(pass === n ? 0 : 1);
})();
