// きょう何着る？ 中継サーバー（Cloudflare Worker）v14（足りない服に価格帯別のブランドと製品名つき）
// POST /advise   … 服の知識と手持ちの服の一覧から、足りない服をAIが考える（文章だけ・写真なし）
// POST /fromimage … 写真のURLをサーバーで読んで判定する（ブックマーク「服に追加」で、端末で写真を読めなかったとき）
// POST /sync     … 同期コードごとにクローゼットを保存・取得する（KV の SYNC を使う）
// POST /fromurl  … 商品ページのURLから写真と商品情報を取り出し、/classify と同じ判定をする
// POST /classify … 服の写真を Gemini に見せて、種類・暖かさ・系統・色を推定する（キーは GEMINI_API_KEY）
// GET  /official?q= … ユニクロ・GU 公式サイトの商品検索（いまのアプリでは未使用）
// GET  /?query= / ?jan_code= … Yahoo!ショッピング商品検索（いまのアプリでは未使用）
const ALLOWED = "https://daichiforgemini-alt.github.io";
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];   // 無料プランでは軽量版が速くて安定。上位モデルは予備
const STYLES = ["kirei","trad","euro","mode","natural","amekaji","work","military","outdoor","street","sport","rude","rock","basic"];
const COLORS = ["white","ivory","beige","gray","charcoal","black","navy","indigo","brown","khaki","sax","red","blue","green","yellow","orange","pink","purple","multi"];
const PROMPT = `この写真の服を1点判定してください。バッグや小物（帽子・メガネ・アクセ・ベルト・時計・マフラーなど）も服として扱い、is_clothing=true にします。服も小物も写っていない、または人の顔が主役の写真なら is_clothing=false にしてください。
- name: 色と種類がわかる短い日本語名（例「ネイビーのボタンダウンシャツ」「ベージュのトレンチコート」）。ブランド名は、持ち主の情報にある場合だけ先頭に付けてよい
- cat: top（Tシャツ・シャツ・ニット・スウェット等）/ outer（カーディガン・ジャケット・コート等の羽織り）/ bottom / shoes / bag（バッグ・リュック・トートなど）/ acc（帽子・メガネ・ネックレス・リング・時計・ベルト・マフラーなどの小物）/ other
- バッグや小物のときは、warmth は 1、fit は regular、shape は straight、neck は crew にする
- warmth: 1=とても薄手（半袖T・サンダル）2=薄手（長袖T・シャツ・カーディガン）3=ふつう（スウェット・薄手ニット・トレンチ・デニム）4=暖かい（厚手ニット・ウールコート）5=とても暖かい（ダウン）
- rain: 撥水・防水素材に見えれば true
- style: 系統。kirei=きれいめ trad=トラッド euro=ユーロワーク mode=モード natural=ナチュラル amekaji=アメカジ work=ワーク military=ミリタリー outdoor=アウトドア street=ストリート sport=スポーツ rude=ルード・バイカー rock=ロック basic=どれにでも合う無地の定番。名前ではなく、サイズ感・生地感・ディテールで判断する
- style2: もうひとつの系統。2つの系統にまたがる服（例：MA-1＝military と street、CPOジャケット＝work と euro）のときだけ。はっきりしなければ none
- dress: きれいめ度。1=とてもカジュアル（ジャージ・スウェットパンツ・ランニングシューズ）2=カジュアル寄り（パーカー・ロゴT・ワークパンツ・スニーカー）3=どちらでも（無地T・オックスフォードシャツ・デニム・無地ニット）4=きれいめ寄り（スラックス・とろみシャツ・チェスターコート・ローファー）5=ドレス（スーツ・革靴のドレスシューズ）
- color: いちばん面積の大きい色
- material: 主な素材。cotton=綿 linen=麻 wool=ウール cashmere=カシミヤ silk=シルク poly=ポリエステル nylon=ナイロン acrylic=アクリル rayon=レーヨン（とろみ） leather=レザー suede=スエード fleece=フリース mix=混紡・その他。見た目や情報から推定できなければ mix
- texture: 質感。raised=起毛・ざっくり（ツイード、フランネル、コーデュロイ、ローゲージニット、フリース） plain=ふつう smooth=つるっと・光沢（とろみ、サテン、レザー、ナイロン）
- pattern: 柄。solid=無地 onepoint=ワンポイント（小さいロゴや刺繍） stripe=ストライプ・ボーダー check=チェック・ヘリンボーン・千鳥 print=柄・プリント・ジャガード logo=大きなロゴ・グラフィック
- fit: サイズ感（トップス・羽織り）。slim=細身・ジャスト regular=ふつう loose=ゆったり over=オーバーサイズ。ボトムスやくつは regular
- shape: パンツの形（ボトムスのとき）。slim=スキニー・スリム tapered=テーパード straight=ストレート wide=ワイド flare=フレア。ボトムス以外は straight
- neck: 首元（トップス・羽織り）。crew=丸首 v=Vネック・Vゾーン collar=襟付き（台襟のあるシャツ・ポロ） open=開襟・オープンカラー turtle=タートル・ハイネック hood=フード zip=ジップ・スタンド。ボトムスやくつは crew
- reason: 系統をそう判断した理由を、見た目の特徴を挙げて40字以内の日本語で`;
const SCHEMA = {
  type: "object",
  properties: {
    is_clothing: { type: "boolean" },
    name: { type: "string" },
    cat: { type: "string", enum: ["top","outer","bottom","shoes","bag","acc","other"] },
    warmth: { type: "integer" },
    rain: { type: "boolean" },
    style: { type: "string", enum: STYLES },
    style2: { type: "string", enum: [...STYLES, "none"] },
    dress: { type: "integer" },
    color: { type: "string", enum: COLORS },
    material: { type: "string", enum: ["cotton","linen","wool","cashmere","silk","poly","nylon","acrylic","rayon","leather","suede","fleece","mix"] },
    texture: { type: "string", enum: ["raised","plain","smooth"] },
    pattern: { type: "string", enum: ["solid","onepoint","stripe","check","print","logo"] },
    fit: { type: "string", enum: ["slim","regular","loose","over"] },
    shape: { type: "string", enum: ["slim","tapered","straight","wide","flare"] },
    neck: { type: "string", enum: ["crew","v","collar","open","turtle","hood","zip"] },
    reason: { type: "string" }
  },
  required: ["is_clothing","name","cat","warmth","rain","style","style2","dress","color","material","texture","pattern","fit","shape","neck","reason"]
};

function findJson(node){
  // 応答の中から、JSONとして読める text を探す（APIの応答形式の違いに備える）
  if (typeof node === "string") { try { const v = JSON.parse(node); if (v && typeof v === "object" && "cat" in v) return v; } catch (e) {} return null; }
  if (Array.isArray(node)) { for (const x of node) { const v = findJson(x); if (v) return v; } return null; }
  if (node && typeof node === "object") { for (const k of Object.keys(node)) { const v = findJson(node[k]); if (v) return v; } }
  return null;
}

function b64(buf){
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unent(t){ return String(t || "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x2F;/g,"/").replace(/\s+/g," ").trim(); }
function meta(html, key){
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i");
  const m = html.match(re1) || html.match(re2); return m ? unent(m[1]) : "";
}
function productLd(html){
  const out = {};
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const b of blocks) {
    let j; try { j = JSON.parse(b.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "")); } catch (e) { continue; }
    const list = Array.isArray(j) ? j : (j["@graph"] || [j]);
    for (const x of list) {
      const t = x && x["@type"]; if (!(t === "Product" || (Array.isArray(t) && t.includes("Product")))) continue;
      out.name = out.name || unent(x.name);
      out.brand = out.brand || unent(typeof x.brand === "string" ? x.brand : x.brand && x.brand.name);
      out.material = out.material || unent(x.material);
      out.color = out.color || unent(x.color);
      out.description = out.description || unent(x.description).slice(0, 300);
      const im = Array.isArray(x.image) ? x.image[0] : x.image; out.image = out.image || (typeof im === "string" ? im : im && im.url) || "";
    }
  }
  return out;
}
async function askGemini(env, data, mime, hint){
  const prompt = PROMPT + (hint ? `\n\n持ち主が書いた情報・商品ページの情報（写真と矛盾しなければ優先して使う。ブランド・商品名・素材は name・warmth・style の判断に使う）:\n${hint}` : "");
  const tried = [];
  for (const model of MODELS) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [ { type: "text", text: prompt }, { type: "image", data, mime_type: mime } ],
        response_format: { type: "text", mime_type: "application/json", schema: SCHEMA } })
    }).catch(e => null);
    if (!r) { tried.push(model + ": timeout"); continue; }
    const txt = await r.text();
    if (!r.ok) { tried.push(model + ": " + r.status + " " + txt.slice(0, 300)); if (r.status === 429 && model === MODELS[MODELS.length - 1]) return { status: 429, error: "rate_limited", tried }; continue; }
    let parsed = null; try { parsed = findJson(JSON.parse(txt)); } catch (e) {}
    if (parsed) return { status: 200, ok: true, model, item: parsed, tried };
    tried.push(model + ": unparsed " + txt.slice(0, 300));
  }
  return { status: 502, error: "ai_failed", tried };
}

const ADVISE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    missing: { type: "array", items: { type: "object", properties: {
      name: { type: "string" },
      cat: { type: "string", enum: ["top","outer","bottom","shoes","inner","bag","acc","other"] },
      query: { type: "string" },
      picks: { type: "array", items: { type: "object", properties: {
        tier: { type: "string", enum: ["budget","middle","premium"] },
        brand: { type: "string" }, product: { type: "string" }, price: { type: "string" }, why: { type: "string" }
      }, required: ["tier","brand","product","price","why"] } },
      priority: { type: "integer" },
      reason: { type: "string" },
      pairs: { type: "string" }
    }, required: ["name","cat","priority","reason","pairs","query","picks"] } },
    strengths: { type: "array", items: { type: "string" } },
    letgo: { type: "array", items: { type: "string" } },
    brands: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, why: { type: "string" }, price: { type: "string" }
    }, required: ["name","why","price"] } }
  },
  required: ["summary","missing","strengths","letgo","brands"]
};
// 足りない服の提案はたまにしか使わず、長い知識と弱点を読み比べる判断が要るので、上位モデルを先に使う（だめなら軽量版）
const ADVISE_MODELS = [["gemini-3.8-flash", 60000], ["gemini-3.5-flash-lite", 35000]];
async function askAdvice(env, prompt){
  const tried = [];
  for (const [model, ms] of ADVISE_MODELS) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST", signal: AbortSignal.timeout(ms),
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [ { type: "text", text: prompt } ],
        response_format: { type: "text", mime_type: "application/json", schema: ADVISE_SCHEMA } })
    }).catch(e => null);
    if (!r) { tried.push(model + ": timeout"); continue; }
    const txt = await r.text();
    if (!r.ok) { tried.push(model + ": " + r.status + " " + txt.slice(0, 200)); continue; }
    const found = (function walk(n){ if (typeof n === "string") { try { const v = JSON.parse(n); if (v && typeof v === "object" && Array.isArray(v.missing)) return v; } catch (e) {} return null; }
      if (Array.isArray(n)) { for (const x of n) { const v = walk(x); if (v) return v; } return null; }
      if (n && typeof n === "object") { for (const k of Object.keys(n)) { const v = walk(n[k]); if (v) return v; } } return null; })(JSON.parse(txt));
    if (found) return { status: 200, ok: true, model, advice: found, tried };
    tried.push(model + ": unparsed");
  }
  return { status: 502, error: "ai_failed", tried };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    const json = (obj, status) => new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
    });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (origin !== ALLOWED) return json({ error: "forbidden" }, 403);
    const u = new URL(req.url);

    if (u.pathname === "/classify" && req.method === "POST") {
      if (!env.GEMINI_API_KEY) return json({ error: "no_key" }, 500);
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const data = String(body.image || "");
      const mime = /^image\/(jpeg|png|webp)$/.test(body.mime) ? body.mime : "image/jpeg";
      if (!data || data.length > 4_000_000) return json({ error: "bad_image" }, 400);
      const hint = String(body.hint || "").replace(/[\u0000-\u001f]/g, " ").slice(0, 300).trim();
      const res = await askGemini(env, data, mime, hint);
      return json(res, res.status);
    }

    if (u.pathname === "/advise" && req.method === "POST") {
      if (!env.GEMINI_API_KEY) return json({ error: "no_key" }, 500);
      let body; try { body = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const clean = (v, n) => String(v || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, n);
      const knowledge = clean(body.knowledge, 9000), closet = clean(body.closet, 9000), goal = clean(body.goal, 200), gaps = clean(body.gaps, 3500);
      if (!closet) return json({ error: "no_closet" }, 400);
      const prompt = `あなたは、下の「服の知識」だけを根拠に考えるスタイリストです。持ち主の手持ちの服を見て、知識に照らして足りない服を考えてください。
- 目指すスタイル：${goal || "きれいめ"}
${gaps ? "- 下の【アプリが見つけた弱点】は、アプリが手持ちの服で実際にコーデを組んで分かった困りごとと、知識の「方向性ごとに必要なもの」が手持ちにあるかのチェック結果。missing は、ここに出ている困りごと・足りないものを解決する服を最優先にし、効果の大きい順（多くの天気・多くのコーデに効くもの、メインのきれいめに効くもの）に並べる。reason の先頭には、どの弱点やチェックに当たるかを短く書く（例「真冬・冬：アウターが薄い」「トラッド：ブローグ系の革靴がない」）。弱点に出ていない服を入れるときは、知識のどのルールに基づくかを書く\n- letgo は、弱点の「出番がない服」や、よく出る注意の原因になっている服を参考にする\n" : ""}- missing：足りない服や小物（バッグ・帽子・メガネ・アクセ・ベルトなども含む）を、効果の大きい順に最大6点。query は通販サイトで検索するときの短いキーワード（色・素材・アイテム名を空白で区切る。ブランド名は入れない。末尾に「メンズ」。例「ネイビー ハイゲージ クルーネックニット メンズ」）。name は買い物で探せる具体的な名前（色・素材・形を含める）。cat は種類。priority は 1=最優先 2=次に 3=余裕があれば。reason は根拠（弱点・チェック・知識のルール）を入れて80字以内。pairs は手持ちのどの服と組めるかを40字以内で、手持ちの名前を使う
- 手持ちにすでにあるものと同じ役割の服は missing に入れない。季節（真冬・真夏・雨）に足りないものも考える
- strengths：手持ちで、知識に合っていて軸になっている服を最大4点（名前と短い理由）
- letgo：知識から見て、目指すスタイルと合いにくく出番が少なそうな服を最大3点（名前と短い理由）。無理に挙げなくてよい
- summary：全体の評価を80字以内で
- picks（missing の中）：その服の具体的な候補を、価格帯ごとに2つまで（合計6つまで）。tier は budget＝メルカリの中古で〜1万円、middle＝1〜2万円、premium＝2〜3万円。brand はブランド名、product はそのブランドに実在する定番の製品名・モデル名・愛称（例：型番や「〇〇シャツ」のような通称）。実在に確信が持てないときは product を空文字にして、ブランドだけにする。price はメルカリでの中古相場の目安、why は30字以内
- brands（全体）：持ち主に合いそうなブランドを最大5個。name はブランド名、why は知識の方向性・サイズ・手持ちとの相性から30字以内、price は「5,000〜1万円台」のような目安
- ブランドは、日本で買える実在のブランドだけ。知識の方向性（メインのきれいめ、ずらし先のトラッド・ミニマルなモード・ユーロワーク）と、知識の「自分のサイズ」（日本の M は大きい。身幅が細め、ウエストが細め）と、これまでの価格帯に合うものを選ぶ。手持ちによくあるブランドばかりにしない。確信がないブランドは挙げない
- 値段は目安にとどめ、断定しない

【服の知識】
${knowledge}

【手持ちの服】
${closet}${gaps ? "\n\n【アプリが見つけた弱点】\n" + gaps : ""}`;
      const res = await askAdvice(env, prompt);
      return json(res, res.status);
    }

    if (u.pathname === "/fromimage" && req.method === "POST") {
      // ブックマーク（服に追加）で受け取った写真のURLを、端末で読めなかったときにサーバーで読む
      if (!env.GEMINI_API_KEY) return json({ error: "no_key" }, 500);
      let body; try { body = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      let img; try { img = new URL(String(body.imageUrl || "")); } catch (e) { return json({ error: "bad_url" }, 400); }
      if (img.protocol !== "https:") return json({ error: "bad_url" }, 400);
      let ref = ""; try { ref = new URL(String(body.pageUrl || "")).toString(); } catch (e) {}
      const UA = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8" };
      let data, mime;
      try {
        const ir = await fetch(img.toString(), { headers: ref ? { ...UA, "Referer": ref } : UA, signal: AbortSignal.timeout(12000) });
        if (!ir.ok) return json({ error: "image_failed", status: ir.status }, 502);
        mime = (ir.headers.get("content-type") || "image/jpeg").split(";")[0];
        if (!/^image\/(jpeg|png|webp)$/.test(mime)) return json({ error: "image_type", type: mime }, 415);
        const buf = await ir.arrayBuffer(); if (buf.byteLength > 4_000_000) return json({ error: "image_too_big" }, 413);
        data = b64(buf);
      } catch (e) { return json({ error: "image_failed" }, 502); }
      const hint = String(body.hint || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, 600).trim();
      const res = await askGemini(env, data, mime, hint);
      return json({ ...res, imageData: "data:" + mime + ";base64," + data }, res.status);
    }

    if (u.pathname === "/fromurl" && req.method === "POST") {
      if (!env.GEMINI_API_KEY) return json({ error: "no_key" }, 500);
      let body; try { body = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      let target; try { target = new URL(String(body.url || "")); } catch (e) { return json({ error: "bad_url" }, 400); }
      if (!/^https?:$/.test(target.protocol)) return json({ error: "bad_url" }, 400);
      const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept-Language": "ja,en;q=0.8" };
      let html = "";
      try {
        const pr = await fetch(target.toString(), { headers: { ...UA, "Accept": "text/html" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
        if (!pr.ok) return json({ error: "page_failed", status: pr.status }, 502);
        html = (await pr.text()).slice(0, 2_000_000);
      } catch (e) { return json({ error: "page_failed" }, 502); }
      const ld = productLd(html);
      const page = {
        title: ld.name || meta(html, "og:title") || unent((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]),
        brand: ld.brand || meta(html, "product:brand") || "",
        material: ld.material || "",
        color: ld.color || "",
        description: (ld.description || meta(html, "og:description") || meta(html, "description")).slice(0, 300),
        image: ld.image || meta(html, "og:image") || meta(html, "twitter:image") || ""
      };
      if (!page.image) return json({ error: "no_image", page }, 422);
      let imgUrl; try { imgUrl = new URL(page.image, target).toString(); } catch (e) { return json({ error: "no_image", page }, 422); }
      let data, mime;
      try {
        const ir = await fetch(imgUrl, { headers: { ...UA, "Referer": target.toString() }, signal: AbortSignal.timeout(12000) });
        if (!ir.ok) return json({ error: "image_failed", page }, 502);
        mime = (ir.headers.get("content-type") || "image/jpeg").split(";")[0];
        if (!/^image\/(jpeg|png|webp)$/.test(mime)) mime = "image/jpeg";
        const buf = await ir.arrayBuffer(); if (buf.byteLength > 4_000_000) return json({ error: "image_too_big", page }, 413);
        data = b64(buf);
      } catch (e) { return json({ error: "image_failed", page }, 502); }
      const userHint = String(body.hint || "").replace(/[\u0000-\u001f]/g, " ").slice(0, 300).trim();
      const info = [userHint, page.brand && "ブランド: " + page.brand, page.title && "商品名: " + page.title, page.material && "素材: " + page.material, page.color && "色: " + page.color, page.description && "説明: " + page.description].filter(Boolean).join("\n").slice(0, 900);
      const res = await askGemini(env, data, mime, info);
      return json({ ...res, page: { ...page, image: imgUrl }, imageData: "data:" + mime + ";base64," + data }, res.status);
    }

    if (u.pathname === "/sync" && req.method === "POST") {
      // 端末どうしのクローゼット同期。同期コードはハッシュにしてから保存場所の名前に使う（コードそのものは保存しない）
      if (!env.SYNC) return json({ error: "no_kv" }, 500);
      let body; try { body = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
      const key = String(body.key || "");
      if (!/^[A-Z2-9]{16,32}$/.test(key)) return json({ error: "bad_key" }, 400);
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kyou-nani-kiru:" + key)))].map(b => b.toString(16).padStart(2, "0")).join("");
      const name = "closet:" + h;
      if (body.op === "get") {
        const v = await env.SYNC.get(name);
        return json({ ok: true, data: v ? JSON.parse(v) : null });
      }
      if (body.op === "put") {
        const s = JSON.stringify(body.data || null);
        if (s.length > 5_000_000) return json({ error: "too_big" }, 413);
        await env.SYNC.put(name, s);
        return json({ ok: true });
      }
      return json({ error: "bad_op" }, 400);
    }

    if (u.pathname === "/official") {
      const q = (u.searchParams.get("q") || "").trim().slice(0, 60);
      if (!q) return json({ error: "no_query" }, 400);
      const OFFICIAL = [
        { brand: "ユニクロ", host: "https://www.uniqlo.com", site: "https://www.uniqlo.com/jp/ja/products/" },
        { brand: "GU", host: "https://www.gu-global.com", site: "https://www.gu-global.com/jp/ja/products/" }
      ];
      const results = await Promise.all(OFFICIAL.map(async (b) => {
        try {
          const r = await fetch(b.host + "/jp/api/commerce/v5/ja/products?q=" + encodeURIComponent(q) + "&limit=5&httpFailure=true", { headers: { "Accept": "application/json" } });
          if (!r.ok) return [];
          const j = await r.json();
          return ((j.result && j.result.items) || []).map((it) => ({ brand: b.brand, name: it.name, code: it.l1Id, url: b.site + it.productId }));
        } catch (e) { return []; }
      }));
      return json({ items: results.flat() });
    }

    if (!env.YAHOO_APPID) return json({ error: "no_appid" }, 500);
    const q = (u.searchParams.get("query") || "").slice(0, 100);
    const jan = (u.searchParams.get("jan_code") || "").replace(/\D/g, "").slice(0, 13);
    if (!q && !jan) return json({ error: "no_query" }, 400);
    const y = new URL("https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch");
    y.searchParams.set("appid", env.YAHOO_APPID);
    y.searchParams.set("results", "6");
    if (jan) y.searchParams.set("jan_code", jan); else y.searchParams.set("query", q);
    const r = await fetch(y.toString());
    return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  }
};
