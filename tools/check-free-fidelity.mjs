// ============================================
// 無料版モデルの確定値チェック — tools/check-free-fidelity.mjs
//
// このアーキテクチャは「星座・画数・干支・キン番号を JS で確定計算して、
// AI には変えるなと命じる」設計になっている（READINGS の system と ABSOLUTE_RULE）。
// しかも apps/*.html は計算値を calc-display として AI の文章のすぐ隣に表示するため、
// モデルが確定値を書き換えると、画面上で一目で分かる形で矛盾する。
//
// 有料版の claude-sonnet-5 より安いモデルへ落とすとき、コストだけを見て決めると
// この破綻を見落とす。無料版のモデルを変える前に必ず通すこと。
//
//   ANTHROPIC_API_KEY=xxx node tools/check-free-fidelity.mjs
//   ANTHROPIC_API_KEY=xxx node tools/check-free-fidelity.mjs claude-sonnet-5   # 比較用
//
// ※ 実際に API を叩くので課金される。29件で概算 10円前後（Haiku 4.5 時点。5.5 はさらに安い見込み）。
// ※ キーは環境変数から渡すこと。引数やファイルに実値を書かない。
// ============================================

import { READINGS } from "../readings-data.js";

const MODEL = process.argv[2] || "claude-haiku-5-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY を環境変数で渡してください。");
  process.exit(1);
}

const ABSOLUTE_RULE = `\n\n【絶対ルール】ユーザーメッセージ内の数値・星座名・画数・干支などの確定済みデータは、あなたの知識と異なっていても絶対に変更しないでください。それらはシステムが正確に計算した値です。`;

// 確定計算に使う共通の入力。値は固定（結果を比較できるようにするため）
const SAMPLE = {
  birthdate: "1990-05-15",
  birthdate1: "1990-05-15",
  birthdate2: "1992-08-03",
  name: "山田太郎",
  fullName: "山田太郎",
  animal: "ひつじ",
  card: "星",
  orientation: "正位置",
  rune: "フェオ",
  theme: "恋愛",
  feeling: "少し不安がある",
  dream: "空を飛んでいる夢を見た",
  currentState: "仕事で迷いがある",
  colors: ["青", "金"],
  chakra: "ハートチャクラ",
  chakraNum: 4,
  answers: { q1: "落ち着いている", q2: "人間関係のもやもや", q3: "自分を許すこと" },
  currentMood: "穏やか",
  question: "これからの進み方について",
};

// 「別の値にすり替わっていないか」を見るためのカテゴリ。
// 同じカテゴリの別メンバーが出力に現れたら、確定値が書き換えられた疑いがある。
const CATEGORIES = [
  ["牡羊座","牡牛座","双子座","蟹座","獅子座","乙女座","天秤座","蠍座","射手座","山羊座","水瓶座","魚座"],
  ["一白水星","二黒土星","三碧木星","四緑木星","五黄土星","六白金星","七赤金星","八白土星","九紫火星"],
  ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"].map(s => s + "年"),
];

function collectFixedStrings(extra) {
  const out = [];
  const walk = v => {
    if (v === null || v === undefined) return;
    if (typeof v === "object") { Object.values(v).forEach(walk); return; }
    out.push(String(v));
  };
  walk(extra);
  return out;
}

async function callModel(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      // 本番の callHaiku と同じ条件で比較する
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: system + ABSOLUTE_RULE,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return {
    text: data.content?.find(b => b.type === "text")?.text || "",
    usage: data.usage || {},
  };
}

const results = [];
let inTok = 0, outTok = 0;

for (const [action, reading] of Object.entries(READINGS)) {
  if (reading.vision) { results.push({ action, verdict: "skip", note: "Vision（無料版対象外）" }); continue; }

  let built;
  try {
    built = reading.build(SAMPLE);
  } catch (e) {
    results.push({ action, verdict: "error", note: `build失敗: ${e.message}` });
    continue;
  }

  let out;
  try {
    out = await callModel(built.system || reading.system, built.user);
  } catch (e) {
    results.push({ action, verdict: "error", note: `API: ${e.message}` });
    continue;
  }
  inTok += out.usage.input_tokens || 0;
  outTok += out.usage.output_tokens || 0;

  const problems = [];

  // ① 確定値が出力に残っているか（数値・固有名）
  for (const v of collectFixedStrings(built.extra)) {
    if (v.length >= 2 && built.user.includes(v) && !out.text.includes(v)) {
      problems.push(`確定値「${v}」が出力に含まれない`);
    }
  }

  // ② 同じカテゴリの別メンバーが混入していないか（すり替えの検出）
  for (const members of CATEGORIES) {
    const inInput = members.filter(m => built.user.includes(m));
    if (inInput.length === 0) continue;
    const wrong = members.filter(m => !inInput.includes(m) && out.text.includes(m));
    if (wrong.length) problems.push(`入力にない同種の値が出力に: ${wrong.join("・")}`);
  }

  results.push({
    action,
    verdict: problems.length ? "fail" : "pass",
    note: problems.join(" / "),
    chars: out.text.length,
  });
  process.stdout.write(problems.length ? "x" : ".");
}

console.log("\n");
console.log(`モデル: ${MODEL}`);
console.log("".padEnd(64, "-"));
for (const r of results) {
  const mark = { pass: "✓", fail: "✗", skip: "-", error: "!" }[r.verdict];
  console.log(`${mark} ${r.action.padEnd(20)} ${r.note || `${r.chars}文字`}`);
}
console.log("".padEnd(64, "-"));

const pass = results.filter(r => r.verdict === "pass").length;
const fail = results.filter(r => r.verdict === "fail").length;
const err = results.filter(r => r.verdict === "error").length;
console.log(`pass ${pass} / fail ${fail} / error ${err} / skip ${results.length - pass - fail - err}`);
console.log(`トークン: 入力 ${inTok} / 出力 ${outTok}`);

process.exit(fail + err > 0 ? 1 : 0);
