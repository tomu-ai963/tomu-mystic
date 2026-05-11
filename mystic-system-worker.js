// ============================================
// とむMYSTIC — Worker.js (Full 30 endpoints)
// ES Module format for Cloudflare Workers
// ============================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Id",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return jsonResponse({ status: "とむMYSTIC Worker OK", endpoints: 30 });
    }

    try {
      if (path.startsWith("/mystic/")) {
        const userId = request.headers.get("X-User-Id");
        if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

        const isSubscribed = await checkSubscription(userId, env);
        if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

        // ① 〜 ③
        if (path === "/mystic/star-reading")      return handleStarReading(request, env);
        if (path === "/mystic/numerology")         return handleNumerology(request, env);
        if (path === "/mystic/guardian-star")      return handleGuardianStar(request, env);

        // ④ 〜 ⑪
        if (path === "/mystic/nine-star-ki")       return handleNineStarKi(request, env);
        if (path === "/mystic/maya-calendar")      return handleMayaCalendar(request, env);
        if (path === "/mystic/animal-fortune")     return handleAnimalFortune(request, env);
        if (path === "/mystic/name-fortune")       return handleNameFortune(request, env);
        if (path === "/mystic/biorhythm")          return handleBiorhythm(request, env);
        if (path === "/mystic/moon-sign")          return handleMoonSign(request, env);
        if (path === "/mystic/eastern-stars")      return handleEasternStars(request, env);
        if (path === "/mystic/horoscope-deep")     return handleHoroscopeDeep(request, env);

        // ⑫ 〜 ⑮
        if (path === "/mystic/tarot")              return handleTarot(request, env);
        if (path === "/mystic/rune-reading")       return handleRuneReading(request, env);
        if (path === "/mystic/oracle-cards")       return handleOracleCards(request, env);
        if (path === "/mystic/nine-palace")        return handleNinePalace(request, env);

        // ⑯ 〜 ㉑
        if (path === "/mystic/past-life")          return handlePastLife(request, env);
        if (path === "/mystic/past-profession")    return handlePastProfession(request, env);
        if (path === "/mystic/soul-mission")       return handleSoulMission(request, env);
        if (path === "/mystic/spirit-animal")      return handleSpiritAnimal(request, env);
        if (path === "/mystic/aura-reading")       return handleAuraReading(request, env);
        if (path === "/mystic/chakra-check")       return handleChakraCheck(request, env);

        // ㉒ 〜 ㉚
        if (path === "/mystic/oracle-message")     return handleOracleMessage(request, env);
        if (path === "/mystic/dream-decoder")      return handleDreamDecoder(request, env);
        if (path === "/mystic/soul-compatibility") return handleSoulCompatibility(request, env);
        if (path === "/mystic/dream-colors")       return handleDreamColors(request, env);
        if (path === "/mystic/moon-journal")       return handleMoonJournal(request, env);
        if (path === "/mystic/cosmic-message")     return handleCosmicMessage(request, env);
        if (path === "/mystic/lucky-color")        return handleLuckyColor(request, env);
        if (path === "/mystic/crystal-guide")      return handleCrystalGuide(request, env);
        if (path === "/mystic/palm-reading")       return handlePalmReading(request, env);

        return jsonResponse({ error: "Not Found" }, 404);
      }

      if (path === "/api/mystic") {
        const userId = request.headers.get("X-User-Id");
        if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

        const isSubscribed = await checkSubscription(userId, env);
        if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

        const body = await request.json();
        const { action, ...rest } = body;
        const makeReq = () => new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(rest),
        });

        switch (action) {
          case "star-reading":      return handleStarReading(makeReq(), env);
          case "numerology":        return handleNumerology(makeReq(), env);
          case "guardian-star":     return handleGuardianStar(makeReq(), env);
          case "nine-star-ki":      return handleNineStarKi(makeReq(), env);
          case "maya-calendar":     return handleMayaCalendar(makeReq(), env);
          case "animal-fortune":    return handleAnimalFortune(makeReq(), env);
          case "name-fortune":      return handleNameFortune(makeReq(), env);
          case "biorhythm":         return handleBiorhythm(makeReq(), env);
          case "moon-sign":         return handleMoonSign(makeReq(), env);
          case "eastern-stars":     return handleEasternStars(makeReq(), env);
          case "horoscope-deep":    return handleHoroscopeDeep(makeReq(), env);
          case "tarot":             return handleTarot(makeReq(), env);
          case "rune-reading":      return handleRuneReading(makeReq(), env);
          case "oracle-cards":      return handleOracleCards(makeReq(), env);
          case "nine-palace":       return handleNinePalace(makeReq(), env);
          case "past-life":         return handlePastLife(makeReq(), env);
          case "past-profession":   return handlePastProfession(makeReq(), env);
          case "soul-mission":      return handleSoulMission(makeReq(), env);
          case "spirit-animal":     return handleSpiritAnimal(makeReq(), env);
          case "aura-reading":      return handleAuraReading(makeReq(), env);
          case "chakra-check":      return handleChakraCheck(makeReq(), env);
          case "oracle-message":    return handleOracleMessage(makeReq(), env);
          case "dream-decoder":     return handleDreamDecoder(makeReq(), env);
          case "soul-compatibility":return handleSoulCompatibility(makeReq(), env);
          case "dream-colors":      return handleDreamColors(makeReq(), env);
          case "moon-journal":      return handleMoonJournal(makeReq(), env);
          case "cosmic-message":    return handleCosmicMessage(makeReq(), env);
          case "lucky-color":       return handleLuckyColor(makeReq(), env);
          case "crystal-guide":     return handleCrystalGuide(makeReq(), env);
          case "palm-reading":      return handlePalmReading(makeReq(), env);
          default:                  return jsonResponse({ error: "Unknown action" }, 404);
        }
      }

      if (path === "/subscription/check")    return handleSubscriptionCheck(request, env);
      if (path === "/subscription/register") return handleSubscriptionRegister(request, env);
      if (path === "/stripe/checkout")       return handleStripeCheckout(request, env);
      if (path === "/webhook")               return handleStripeWebhook(request, env);

      return jsonResponse({ error: "Not Found" }, 404);

    } catch (err) {
      return jsonResponse({ error: "サーバーエラー: " + err.message }, 500);
    }
  },
};

// ============================================
// サブスクリプション管理
// ============================================

async function checkSubscription(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(userId);
    if (!data) return false;
    const sub = JSON.parse(data);
    if (sub.expires && new Date(sub.expires) < new Date()) return false;
    return sub.active === true;
  } catch { return false; }
}

async function handleSubscriptionCheck(request, env) {
  const { userId } = await request.json();
  const isSubscribed = await checkSubscription(userId, env);
  return jsonResponse({ subscribed: isSubscribed });
}

async function handleSubscriptionRegister(request, env) {
  const { userId, plan } = await request.json();
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 1);
  await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
    active: true,
    plan: plan || "mystic",
    expires: expires.toISOString(),
    createdAt: new Date().toISOString(),
  }));
  return jsonResponse({ success: true });
}

// ============================================
// Stripe Checkout セッション作成
// ============================================

async function handleStripeCheckout(request, env) {
  const { userId, successUrl, cancelUrl } = await request.json();
  if (!userId) return jsonResponse({ error: "userId が必要です" }, 400);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "payment_method_types[]": "card",
      "mode": "subscription",
      "line_items[0][price]": env.MYSTIC_PRICE_ID,
      "line_items[0][quantity]": "1",
      "metadata[userId]": userId,
      "success_url": successUrl,
      "cancel_url": cancelUrl,
    }),
  });

  const session = await res.json();
  if (!res.ok) return jsonResponse({ error: session.error?.message || "Stripe エラー" }, 500);
  return jsonResponse({ url: session.url });
}

// ============================================
// Stripe Webhook 受信・サブスク有効化
// ============================================

async function handleStripeWebhook(request, env) {
  const signature = request.headers.get("stripe-signature");
  const body = await request.text();

  if (env.STRIPE_WEBHOOK_SECRET) {
    const valid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return jsonResponse({ error: "署名が無効です" }, 400);
  }

  const event = JSON.parse(body);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      const expires = new Date();
      expires.setMonth(expires.getMonth() + 1);
      await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
        active: true,
        plan: "mystic",
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        expires: expires.toISOString(),
        createdAt: new Date().toISOString(),
      }));
    }
  }

  return jsonResponse({ received: true });
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      acc[k.trim()] = v;
      return acc;
    }, {});

    const signedPayload = `${parts.t}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computed === parts.v1;
  } catch {
    return false;
  }
}

// ============================================
// Claude API 呼び出し共通関数
// ============================================

const ABSOLUTE_RULE = `\n\n【絶対ルール】ユーザーメッセージ内の数値・星座名・画数・干支などの確定済みデータは、あなたの知識と異なっていても絶対に変更しないでください。それらはシステムが正確に計算した値です。`;

async function callClaude(env, systemPrompt, userMessage, maxTokens = 800) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt + ABSOLUTE_RULE,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API Error");
  return data.content[0].text;
}

async function callClaudeVision(env, systemPrompt, imageBase64, mimeType = "image/jpeg", maxTokens = 800) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt + ABSOLUTE_RULE,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: "この手のひらの手相を占ってください。" },
        ],
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API Error");
  return data.content[0].text;
}

// ============================================
// 確定計算ユーティリティ
// ============================================

function getSunSign(birthdate) {
  const [, m, d] = birthdate.split('-').map(Number);
  if ((m===3&&d>=21)||(m===4&&d<=19)) return '牡羊座';
  if ((m===4&&d>=20)||(m===5&&d<=20)) return '牡牛座';
  if ((m===5&&d>=21)||(m===6&&d<=21)) return '双子座';
  if ((m===6&&d>=22)||(m===7&&d<=22)) return '蟹座';
  if ((m===7&&d>=23)||(m===8&&d<=22)) return '獅子座';
  if ((m===8&&d>=23)||(m===9&&d<=22)) return '乙女座';
  if ((m===9&&d>=23)||(m===10&&d<=23)) return '天秤座';
  if ((m===10&&d>=24)||(m===11&&d<=22)) return '蠍座';
  if ((m===11&&d>=23)||(m===12&&d<=21)) return '射手座';
  if ((m===12&&d>=22)||(m===1&&d<=19)) return '山羊座';
  if ((m===1&&d>=20)||(m===2&&d<=18)) return '水瓶座';
  return '魚座';
}

function getNineStarKi(birthdate) {
  const [y, m, d] = birthdate.split('-').map(Number);
  const ay = (m===1||(m===2&&d<=3)) ? y-1 : y;
  let s = String(ay).split('').reduce((a,b)=>a+parseInt(b),0);
  while(s>=10) s=String(s).split('').reduce((a,b)=>a+parseInt(b),0);
  const n = (11-s)%9||9;
  const names=['','一白水星','二黒土星','三碧木星','四緑木星','五黄土星','六白金星','七赤金星','八白土星','九紫火星'];
  return {num:n, name:names[n]};
}

function getMayaKin(birthdate) {
  const base = Date.UTC(2000,0,1);
  const [y,m,d] = birthdate.split('-').map(Number);
  const diff = Math.round((Date.UTC(y,m-1,d)-base)/86400000);
  const kin = ((143+diff)%260+260)%260+1;
  const tones=['磁気','月','電気','自己存在','倍音','リズム','共鳴','銀河','太陽','惑星','スペクトル','水晶','宇宙'];
  const seals=['赤い龍','白い風','青い夜','黄色い種','赤い蛇','白い世界の橋渡し','青い手','黄色い星','赤い月','白い犬','青い猿','黄色い人','赤い空歩く者','白い魔法使い','青い鷲','黄色い戦士','赤い地球','白い鏡','青い嵐','黄色い太陽'];
  return {kin, tone:tones[(kin-1)%13], seal:seals[(kin-1)%20]};
}

function getLifePathNumber(birthdate) {
  let n = birthdate.replace(/-/g,'').split('').reduce((a,b)=>a+parseInt(b),0);
  while(n>9&&n!==11&&n!==22&&n!==33) n=String(n).split('').reduce((a,b)=>a+parseInt(b),0);
  return n;
}

function getEto(birthdate) {
  const y = parseInt(birthdate.split('-')[0]);
  const junishi=['申','酉','戌','亥','子','丑','寅','卯','辰','巳','午','未'];
  const jikkan=['庚','辛','壬','癸','甲','乙','丙','丁','戊','己'];
  return {kan:jikkan[y%10], eto:junishi[y%12]};
}

// 人名用漢字画数テーブル
const KS = {
  '一':1,
  '乃':2,'七':2,'二':2,'人':2,'入':2,'八':2,'力':2,'十':2,'刀':2,'丁':2,
  '三':3,'口':3,'土':3,'大':3,'女':3,'子':3,'小':3,'山':3,'川':3,'千':3,'久':3,'丈':3,'万':3,'干':3,'也':3,'己':3,'士':3,'弓':3,'上':3,'下':3,
  '中':4,'今':4,'仁':4,'元':4,'内':4,'公':4,'六':4,'天':4,'太':4,'五':4,'心':4,'手':4,'文':4,'方':4,'木':4,'月':4,'水':4,'火':4,'王':4,'日':4,'円':4,'少':4,'友':4,'反':4,'化':4,'比':4,'夫':4,'支':4,'斗':4,'不':4,'丹':4,
  '四':5,'以':5,'加':5,'史':5,'司':5,'右':5,'古':5,'由':5,'央':5,'功':5,'令':5,'冬':5,'出':5,'半':5,'占':5,'外':5,'広':5,'弘':5,'末':5,'本':5,'永':5,'玄':5,'玉':5,'平':5,'礼':5,'世':5,'正':5,'生':5,'白':5,'石':5,'田':5,'目':5,'北':5,'申':5,'甲':5,'矢':5,'台':5,'布':5,'市':5,'付':5,'仙':5,
  '伊':6,'光':6,'全':6,'共':6,'合':6,'向':6,'在':6,'多':6,'宇':6,'安':6,'守':6,'宏':6,'次':6,'気':6,'江':6,'成':6,'早':6,'旭':6,'朱':6,'西':6,'羽':6,'老':6,'自':6,'至':6,'舟':6,'血':6,'衣':6,'行':6,'先':6,'名':6,'年':6,'有':6,'百':6,'竹':6,'色':6,'地':6,'帆':6,'凪':6,'吉':6,'好':6,'再':6,'兆':6,'汐':6,'仲':6,'任':6,'伏':6,'朴':6,'曲':6,'妃':6,
  '亜':7,'位':7,'住':7,'克':7,'初':7,'別':7,'努':7,'労':7,'吾':7,'告':7,'君':7,'孝':7,'完':7,'志':7,'忘':7,'我':7,'改':7,'束':7,'杏':7,'李':7,'材':7,'沙':7,'那':7,'均':7,'岐':7,'妙':7,'良':7,'花':7,'赤':7,'男':7,'村':7,'里':7,'来':7,'言':7,'見':7,'車':7,'何':7,'冴':7,'佐':7,'希':7,'抄':7,'沖':7,'扶':7,'佑':7,'宋':7,'肖':7,'寿':7,'汰':7,'伸':7,'伶':7,
  '佳':8,'依':8,'典':8,'具':8,'制':8,'到':8,'命':8,'固':8,'奈':8,'委':8,'定':8,'宗':8,'官':8,'宙':8,'宝':8,'尚':8,'岩':8,'岸':8,'幸':8,'拓':8,'松':8,'武':8,'治':8,'法':8,'沼':8,'炎':8,'物':8,'直':8,'知':8,'空':8,'育':8,'英':8,'茉':8,'長':8,'門':8,'昌':8,'旺':8,'実':8,'昂':8,'林':8,'金':8,'青':8,'学':8,'岡':8,'和':8,'周':8,'承':8,'征':8,'怜':8,'侑':8,'坪':8,'果':8,'昇':8,'宜':8,'虎':8,'並':8,'卓':8,'奉':8,'享':8,'茂':8,'阿':8,'昆':8,'昔':8,'仰':8,
  '哉':9,'型':9,'城':9,'威':9,'奏':9,'姿':9,'室':9,'宣':9,'帝':9,'建':9,'持':9,'政':9,'故':9,'柄':9,'柔':9,'柳':9,'洋':9,'洲':9,'活':9,'津':9,'研':9,'秋':9,'紀':9,'美':9,'背':9,'胡':9,'茜':9,'音':9,'飛':9,'哀':9,'勇':9,'厚':9,'咲':9,'香':9,'春':9,'海':9,'南':9,'星':9,'風':9,'保':9,'信':9,'前':9,'昴':9,'俊':9,'宥':9,'亮':9,'玲':9,'珂':9,'拳':9,'点':9,'律':9,'皇':9,'玻':9,'珊':9,'郎':9,
  '原':10,'家':10,'真':10,'桜':10,'純':10,'留':10,'修':10,'倫':10,'哲':10,'容':10,'宮':10,'展':10,'恋':10,'悟':10,'振':10,'根':10,'格':10,'桂':10,'桃':10,'流':10,'浩':10,'浪':10,'浦':10,'特':10,'益':10,'神':10,'秦':10,'紘':10,'紗':10,'素':10,'能':10,'透':10,'泰':10,'泳':10,'夏':10,'晃':10,'洸':10,'竜':10,'将':10,'航':10,'凌':10,'隼':10,'朔':10,'梅':10,'捷':10,'倖':10,'恭':10,'時':10,'朗':10,
  '健':11,'唯':11,'凰':11,'啓':11,'問':11,'基':11,'堂':11,'堅':11,'悠':11,'梨':11,'梓':11,'清':11,'渉':11,'渓':11,'淳':11,'深':11,'理':11,'現':11,'紬':11,'脩':11,'彩':11,'黄':11,'鹿':11,'崇':11,'康':11,'陸':11,'麻':11,'渚':11,'野':11,'球':11,'帯':11,'副':11,'務':11,'動':11,'匡':11,'猛':11,'崚':11,'鳥':11,'彬':11,'惇':11,
  '朝':12,'博':12,'善':12,'尊':12,'幾':12,'敦':12,'最':12,'植':12,'湯':12,'無':12,'登':12,'絢':12,'絵':12,'結':12,'翔':12,'雄':12,'森':12,'湖':12,'満':12,'晴':12,'喜':12,'御':12,'勝':12,'葵':12,'琴':12,'稀':12,'葉':12,'椎':12,'陽':12,'裕':12,'智':12,'創':12,'統':12,'景':12,'晶':12,'達':12,'運':12,'策':12,'琢':11,
  '蒼':13,'遥':13,'蓮':13,'愛':13,'義':13,'想':13,'新':13,'業':13,'極':13,'楓':13,'歳':13,'滋':13,'照':13,'詩':13,'路':13,'聖':13,'頌':13,'暖':13,'椿':13,'楠':13,'豊':13,'誠':13,'源':13,'瑛':13,
  '静':14,'緑':14,'歌':14,'維':14,'徳':14,'漢':14,'端':14,'翠':14,'語':14,'誓':14,'銀':14,'関':14,'嘉':14,'聡':14,'彰':14,'豪':14,'颯':14,'碧':14,
  '輝':15,'熱':15,'確':15,'論':15,'穂':15,'璃':15,'凛':15,'凜':15,
  '樹':16,'橋':16,'整':16,'親':16,'頼':16,'龍':16,'賢':16,
  '謙':17,'霞':17,'鎌':18,'蘭':19,'鶴':21,'麟':23,
};

function calcGoKaku(fullName) {
  const trimmed = fullName.trim();
  const spIdx = trimmed.search(/[\s　]/);
  let sei, mei;
  if (spIdx > 0) {
    sei = trimmed.slice(0, spIdx).split('');
    mei = trimmed.slice(spIdx+1).trim().split('');
  } else {
    const half = Math.ceil(trimmed.length/2);
    sei = trimmed.slice(0, half).split('');
    mei = trimmed.slice(half).split('');
  }
  const strokes = c => KS[c] ?? '?';
  const ss = sei.map(strokes);
  const ms = mei.map(strokes);
  const ok = arr => arr.every(v=>v!=='?');
  const sum = arr => arr.reduce((a,b)=>a+(b==='?'?0:b),0);
  const tenkaku = ok(ss) ? sum(ss) : '?';
  const chikaku = ok(ms) ? sum(ms) : '?';
  const jinkaku = (ss[ss.length-1]!=='?' && ms[0]!=='?') ? ss[ss.length-1]+ms[0] : '?';
  const soukaku = (tenkaku!=='?' && chikaku!=='?') ? tenkaku+chikaku : '?';
  const sotokaku = (soukaku!=='?' && jinkaku!=='?') ? soukaku-jinkaku : '?';
  return {
    sei: sei.join(''), mei: mei.join(''),
    seiStrokes: ss, meiStrokes: ms,
    tenkaku, jinkaku, chikaku, sotokaku, soukaku,
    unknown: [...ss,...ms].some(v=>v==='?'),
  };
}

// ============================================
// ① 今日の星読み
// ============================================
async function handleStarReading(request, env) {
  const { birthdate } = await request.json();
  const sign = getSunSign(birthdate);
  const result = await callClaude(
    env,
    `あなたは神秘的な星読み師です。以下の確定済みデータを元に、今日の星の配置に基づいたメッセージを詩的で神秘的な文体で日本語で届けてください。星座の判定は変えないでください。200〜300文字程度で。`,
    `生年月日：${birthdate}\n太陽星座：${sign}`
  );
  return jsonResponse({ result, sign });
}

// ============================================
// ② 数秘術診断
// ============================================
async function handleNumerology(request, env) {
  const { name, birthdate } = await request.json();
  const lpn = getLifePathNumber(birthdate);
  const result = await callClaude(
    env,
    `あなたは数秘術の達人です。以下の確定済みライフパスナンバーを元に、魂の使命と今世のテーマを神秘的な文体で日本語で伝えてください。ライフパスナンバーの数値は変えないでください。300文字程度で。`,
    `名前：${name}\n生年月日：${birthdate}\nライフパスナンバー：${lpn}`
  );
  return jsonResponse({ result, lifePathNumber: lpn });
}

// ============================================
// ③ 守護星特定
// ============================================
async function handleGuardianStar(request, env) {
  const { birthdate } = await request.json();
  const sign = getSunSign(birthdate);
  const result = await callClaude(
    env,
    `あなたは星の守護者です。以下の確定済みデータを元に、守護星の性質と今週の指針・開運アドバイスを神秘的な文体で日本語で届けてください。星座は変えないでください。300文字程度で。`,
    `生年月日：${birthdate}\n太陽星座：${sign}`
  );
  return jsonResponse({ result, sign });
}

// ============================================
// ④ 九星気学診断
// ============================================
async function handleNineStarKi(request, env) {
  const { birthdate } = await request.json();
  const ki = getNineStarKi(birthdate);
  const result = await callClaude(
    env,
    `あなたは九星気学の達人です。以下の確定済みデータを元に、その人の本質・人生テーマ・今年の運気を神秘的な文体で日本語で伝えてください。本命星の名前と番号は変えないでください。350文字程度で。`,
    `生年月日：${birthdate}\n本命星：${ki.name}（${ki.num}）`
  );
  return jsonResponse({ result, honmeisei: ki.name, honmeiseiNum: ki.num });
}

// ============================================
// ⑤ マヤ暦診断
// ============================================
async function handleMayaCalendar(request, env) {
  const { birthdate, kin, tone, toneNumber, seal, wavespell, wavespellSeal } = await request.json();
  const result = await callClaude(
    env,
    `ユーザーのKIN番号・太陽の紋章・ウェーブスペル・音はすでに正確に計算済みです。
あなたが再計算する必要は一切ありません。
必ず渡された値（KIN・紋章・ウェーブスペル・音）をそのまま使ってメッセージを作成してください。
絶対に別のKIN番号や紋章を提示しないでください。

あなたはマヤ暦の占い師です。以下の確定済みデータを元に、その魂のエネルギー・使命・才能を神秘的な文体で日本語で伝えてください。350文字程度で。`,
    `生年月日：${birthdate}\nKIN番号：${kin}\n音（トーン）：${tone}（${toneNumber}）\n太陽の紋章：${seal}\nウェーブスペル：${wavespellSeal}のウェーブスペル（第${wavespell}ウェーブスペル）`
  );
  return jsonResponse({ result, kin, tone, toneNumber, seal, wavespell, wavespellSeal });
}

// ============================================
// ⑥ 動物占い
// ============================================
async function handleAnimalFortune(request, env) {
  const { birthdate, animal } = await request.json();
  const result = await callClaude(
    env,
    `あなたは動物キャラナビの占い師です。「${animal}」タイプの人の性格・運勢・対人関係をスピリチュアルな観点で200字程度で鑑定してください。`,
    `生年月日：${birthdate}、守護動物：${animal}`
  );
  return jsonResponse({ result, animal });
}

// ============================================
// ⑦ 姓名判断
// ============================================
async function handleNameFortune(request, env) {
  const { fullName, tenkaku: clientTk, jinkaku: clientJk, chikaku: clientCk, sotokaku: clientGk, soukaku: clientSk, confirmedGoKaku } = await request.json();

  // クライアントから確定値が送られている場合はそれを優先（再計算しない）
  let tk, jk, ck, gk, sk, unknownNote;
  if (confirmedGoKaku && clientTk !== undefined) {
    tk = clientTk; jk = clientJk; ck = clientCk; gk = clientGk; sk = clientSk;
    unknownNote = (tk === '?' || jk === '?' || ck === '?' || gk === '?' || sk === '?')
      ? '\n※一部の漢字の画数が未登録のため「?」としています。' : '';
  } else {
    const calc = calcGoKaku(fullName);
    tk = calc.tenkaku; jk = calc.jinkaku; ck = calc.chikaku; gk = calc.sotokaku; sk = calc.soukaku;
    unknownNote = calc.unknown ? '\n※一部の漢字の画数が未登録のため「?」としています。' : '';
  }

  const result = await callClaude(
    env,
    `あなたは姓名判断の達人です。以下の画数は確定値です。この数値を使って運命の流れと今後の指針を神秘的な文体で日本語で伝えてください。絶対に画数を再計算しないでください。400文字程度で。`,
    `氏名：${fullName}
【確定済み五格 — 絶対に再計算しないでください】
天格：${tk}（確定値）
人格：${jk}（確定値）
地格：${ck}（確定値）
外格：${gk}（確定値）
総格：${sk}（確定値）${unknownNote}
以上の数値をそのまま使い、独自に画数を算出・修正しないでください。`
  );
  return jsonResponse({ result, goKaku: { tenkaku: tk, jinkaku: jk, chikaku: ck, sotokaku: gk, soukaku: sk } });
}

// ============================================
// ⑧ バイオリズム
// ============================================
async function handleBiorhythm(request, env) {
  const { birthdate, targetDate, physical, emotional, intellectual } = await request.json();
  const result = await callClaude(
    env,
    `あなたはバイオリズムを読む占い師です。指定日における肉体・感情・知性の3つのリズム値を受け取り、その人の今日のコンディションと取るべき行動指針を神秘的な文体で日本語で伝えてください。300文字程度で。`,
    `対象日：${targetDate}、肉体リズム：${physical}%、感情リズム：${emotional}%、知性リズム：${intellectual}%`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑨ ムーンサイン診断
// ============================================
async function handleMoonSign(request, env) {
  const { birthdate, zodiacSign, lifePathNumber, moonSign } = await request.json();
  const sign = zodiacSign || getSunSign(birthdate);
  const lpn = lifePathNumber || getLifePathNumber(birthdate);
  const result = await callClaude(
    env,
    `あなたは月星座の占い師です。以下の確定済みデータを元に、その人の内面・感情パターン・本当の欲求を神秘的な文体で日本語で伝えてください。太陽星座・月星座・ライフパスナンバーは変えないでください。300文字程度で。`,
    `生年月日：${birthdate}\n太陽星座：${sign}\n月星座：${moonSign}\nライフパスナンバー：${lpn}`
  );
  return jsonResponse({ result, sunSign: sign, moonSign, lifePathNumber: lpn });
}

// ============================================
// ⑩ 東洋星座×干支診断
// ============================================
async function handleEasternStars(request, env) {
  const { birthdate } = await request.json();
  const eto = getEto(birthdate);
  const ki = getNineStarKi(birthdate);
  const result = await callClaude(
    env,
    `あなたは東洋占星術の達人です。以下の確定済みデータを元に、その人の宿命・才能・今年の運勢を神秘的な文体で日本語で伝えてください。干支・本命星は変えないでください。350文字程度で。`,
    `生年月日：${birthdate}\n干支：${eto.kan}${eto.eto}\n本命星：${ki.name}`
  );
  return jsonResponse({ result, eto: `${eto.kan}${eto.eto}`, honmeisei: ki.name });
}

// ============================================
// ⑪ ホロスコープ詳細
// ============================================
async function handleHoroscopeDeep(request, env) {
  const { birthdate, birthTime, birthPlace, zodiacSign, moonSign } = await request.json();
  const sign = zodiacSign || getSunSign(birthdate);
  const result = await callClaude(
    env,
    `あなたは本格的な西洋占星術師です。以下の確定済みデータを元に、その人の本質・魂のテーマ・今後の流れを神秘的で詳しい文体で日本語で伝えてください。太陽星座・月星座は変えないでください。出生時刻・出生地からアセンダントの考察も加えてください。500文字程度で。`,
    `生年月日：${birthdate}\n太陽星座：${sign}\n月星座：${moonSign}\n出生時刻：${birthTime}\n出生地：${birthPlace}`
  );
  return jsonResponse({ result, sunSign: sign, moonSign });
}

// ============================================
// ⑫ タロット一枚引き
// ============================================
async function handleTarot(request, env) {
  const { card } = await request.json();
  const result = await callClaude(
    env,
    `あなたは神秘的なタロット占い師です。引いたカードのエネルギーと意味を、今この瞬間のユーザーへのメッセージとして神秘的な文体で日本語で届けてください。300文字程度で。`,
    `引いたカード：${card}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑬ ルーン占い
// ============================================
async function handleRuneReading(request, env) {
  const { rune } = await request.json();
  const result = await callClaude(
    env,
    `あなたは北欧の神秘を伝えるルーン占い師です。引いたルーン文字の古代的な意味・エネルギー・今の状況へのメッセージを神秘的な文体で日本語で届けてください。300文字程度で。`,
    `引いたルーン：${rune}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑭ オラクルカード
// ============================================
async function handleOracleCards(request, env) {
  const { theme, card } = await request.json();
  const result = await callClaude(
    env,
    `あなたは宇宙のメッセージを伝えるオラクルカードリーダーです。テーマとカードを受け取り、今この瞬間の宇宙からの神秘的なメッセージを詩的な日本語で届けてください。300文字程度で。`,
    `テーマ：${theme}、カード：${card}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑮ 九宮格診断
// ============================================
async function handleNinePalace(request, env) {
  const { selectedPalace, birthdate, honmeisei: clientHonmei, honmeiseiNum: clientNum } = await request.json();
  const ki = clientHonmei ? { name: clientHonmei, num: clientNum } : getNineStarKi(birthdate);
  const result = await callClaude(
    env,
    `あなたは九宮格（風水×気学）の達人です。以下の確定済みデータを元に、今のあなたの運気の流れと開運の鍵を神秘的な文体で日本語で伝えてください。本命星は変えないでください。350文字程度で。`,
    `生年月日：${birthdate}、本命星：${ki.name}（${ki.num}）、直感で選んだ宮：${selectedPalace}`
  );
  return jsonResponse({ result, honmeisei: ki.name, honmeiseiNum: ki.num });
}

// ============================================
// ⑯ 前世診断
// ============================================
async function handlePastLife(request, env) {
  const { answers } = await request.json();
  const result = await callClaude(
    env,
    `あなたは魂の記憶を読む前世占い師です。ユーザーの回答から前世の物語を読み解き、魂が歩んできた旅を神秘的で詩的な日本語で語ってください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑰ 前世の職業診断
// ============================================
async function handlePastProfession(request, env) {
  const { answers } = await request.json();
  const result = await callClaude(
    env,
    `あなたは魂の過去を読む前世職業占い師です。ユーザーの回答から前世で担っていた職業・役割（神官、騎士、薬師、吟遊詩人など）を特定し、その魂が持つスキルと今世への影響を神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑱ 魂の使命診断
// ============================================
async function handleSoulMission(request, env) {
  const { answers } = await request.json();
  const result = await callClaude(
    env,
    `あなたは魂の設計図を読む占い師です。ユーザーの回答から今世の魂の使命・ライフテーマ・与えるべきギフトを読み解き、宇宙からのメッセージとして神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑲ 精霊動物診断
// ============================================
async function handleSpiritAnimal(request, env) {
  const { answers } = await request.json();
  const result = await callClaude(
    env,
    `あなたはシャーマニックな精霊動物ガイドです。ユーザーの回答から守護精霊動物を特定し、その動物のエネルギー・もたらすメッセージ・今週の指針を神秘的な文体で日本語で届けてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑳ オーラカラー診断
// ============================================
async function handleAuraReading(request, env) {
  const { answers } = await request.json();
  const result = await callClaude(
    env,
    `あなたはオーラを視るスピリチュアルリーダーです。ユーザーの回答から現在のオーラカラーを特定し、そのエネルギーの意味・魂の状態・今週の開運カラーを神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉑ チャクラ診断
// ============================================
async function handleChakraCheck(request, env) {
  const { answers, chakra, chakraNum } = await request.json();
  const chakraDesc = chakra ? `特定チャクラ：${chakra}（${chakraNum}）` : `回答：${JSON.stringify(answers)}`;
  const result = await callClaude(
    env,
    `あなたはチャクラを診るエネルギーヒーラーです。以下の確定済みデータを元に、そのチャクラの意味・滞りの原因・解放のための実践・魂のメッセージを神秘的な文体で日本語で伝えてください。チャクラ名は変えないでください。400文字程度で。`,
    `${chakraDesc}\n感情の詰まり：${answers.q2}\n意識したいテーマ：${answers.q3}`
  );
  return jsonResponse({ result, chakra, chakraNum });
}

// ============================================
// ㉒ オラクルメッセージ
// ============================================
async function handleOracleMessage(request, env) {
  const { feeling } = await request.json();
  const result = await callClaude(
    env,
    `あなたは宇宙のチャネラーです。ユーザーの今の気持ちや状況を受け取り、宇宙からの神秘的なメッセージを詩的な日本語で届けてください。150〜200文字程度で。`,
    `今の気持ち・状況：${feeling}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉓ 夢解読AI
// ============================================
async function handleDreamDecoder(request, env) {
  const { dream } = await request.json();
  const result = await callClaude(
    env,
    `あなたはスピリチュアルな夢解読師です。ユーザーが見た夢の内容を受け取り、象徴・潜在意識・スピリチュアルな意味を神秘的な文体で日本語で解説してください。300文字程度で。`,
    `夢の内容：${dream}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉔ 縁結び相性診断
// ============================================
async function handleSoulCompatibility(request, env) {
  const { birthdate1, birthdate2 } = await request.json();
  const s1 = getSunSign(birthdate1), s2 = getSunSign(birthdate2);
  const l1 = getLifePathNumber(birthdate1), l2 = getLifePathNumber(birthdate2);
  const result = await callClaude(
    env,
    `あなたは魂の縁を読む占い師です。以下の確定済みデータを元に、2人の魂レベルの相性・絆の意味・共に成長するための鍵を神秘的な文体で日本語で届けてください。星座とライフパスナンバーは変えないでください。300文字程度で。`,
    `1人目：生年月日${birthdate1}・${s1}・ライフパスナンバー${l1}\n2人目：生年月日${birthdate2}・${s2}・ライフパスナンバー${l2}`
  );
  return jsonResponse({ result, person1:{sign:s1,lpn:l1}, person2:{sign:s2,lpn:l2} });
}

// ============================================
// ㉕ 夢の色彩診断
// ============================================
async function handleDreamColors(request, env) {
  const { colors } = await request.json();
  const result = await callClaude(
    env,
    `あなたは色彩心理とスピリチュアルを組み合わせた夢解読師です。夢に現れた色の組み合わせから潜在意識のメッセージ・魂の状態・今必要なエネルギーを神秘的な文体で日本語で伝えてください。300文字程度で。`,
    `夢に出た色：${colors.join("、")}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉖ 月相ジャーナル
// ============================================
async function handleMoonJournal(request, env) {
  const body = await request.json().catch(()=>({}));
  const today = body.today || new Date().toISOString().split("T")[0];
  const moonPhase = body.moonPhase || null;
  const moonAge = body.moonAge ?? null;
  const phaseDesc = moonPhase ? `月相：${moonPhase}（月齢約${moonAge}日）` : `今日の日付：${today}`;
  const result = await callClaude(
    env,
    `あなたは月の神秘を語る案内人です。以下の確定済み月相データを元に、内省のための問いかけと月からのメッセージを詩的な日本語で届けてください。月相名は変えないでください。250文字程度で。`,
    `今日の日付：${today}\n${phaseDesc}`
  );
  return jsonResponse({ result, moonPhase, moonAge });
}

// ============================================
// ㉗ 今日の宇宙メッセージ
// ============================================
async function handleCosmicMessage(request, env) {
  const body = await request.json().catch(()=>({}));
  const today = body.today || new Date().toISOString().split("T")[0];
  const cosmicNumber = body.cosmicNumber ?? null;
  const numDesc = cosmicNumber !== null ? `\n今日の宇宙数：${cosmicNumber}` : '';
  const result = await callClaude(
    env,
    `あなたは宇宙の意識とつながるチャネラーです。以下の確定済み日付データを元に、今日この日の宇宙的エネルギーと地球上のすべての魂へのメッセージを詩的で神秘的な日本語で届けてください。宇宙数は変えないでください。250文字程度で。`,
    `今日の日付：${today}${numDesc}`
  );
  return jsonResponse({ result, cosmicNumber });
}

// ============================================
// ㉘ 今日の開運カラー
// ============================================
async function handleLuckyColor(request, env) {
  const { birthdate, targetDate } = await request.json();
  const ki = getNineStarKi(birthdate);
  const sign = getSunSign(birthdate);
  const lpn = getLifePathNumber(birthdate);
  const result = await callClaude(
    env,
    `あなたは色彩運気の占い師です。以下の確定済みデータを元に、今日最も開運をもたらすラッキーカラーを特定し、その色のエネルギー・使い方・今日のアドバイスを神秘的な文体で日本語で伝えてください。本命星・星座・数字は変えないでください。300文字程度で。`,
    `生年月日：${birthdate}\n対象日：${targetDate}\n本命星：${ki.name}\n太陽星座：${sign}\nライフパスナンバー：${lpn}`
  );
  return jsonResponse({ result, honmeisei: ki.name, sign, lifePathNumber: lpn });
}

// ============================================
// ㉙ パワーストーン診断
// ============================================
async function handleCrystalGuide(request, env) {
  const { currentState } = await request.json();
  const result = await callClaude(
    env,
    `あなたはクリスタルヒーラーです。ユーザーの今の状態を受け取り、最も必要なパワーストーン（水晶、アメジスト、ローズクォーツなど）を特定し、その石のエネルギー・使い方・癒しのメッセージを神秘的な文体で日本語で伝えてください。350文字程度で。`,
    `今の状態：${currentState}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉚ 手相占い（Vision API使用）
// ============================================
async function handlePalmReading(request, env) {
  const { imageBase64, mimeType } = await request.json();
  const result = await callClaudeVision(
    env,
    `あなたは神秘的な手相占い師です。手のひらの画像を見て、生命線・感情線・頭脳線・運命線・太陽線を丁寧に読み取り、その人の生命力・感情パターン・知性・運命の流れを神秘的で詩的な日本語で伝えてください。400文字程度で。`,
    imageBase64,
    mimeType || "image/jpeg"
  );
  return jsonResponse({ result });
}

// ============================================
// ユーティリティ
// ============================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
