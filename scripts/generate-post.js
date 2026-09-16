#!/usr/bin/env node
/**
 * アフィリエイト記事の自動生成スクリプト
 *
 * Anthropic API (Claude) で指定キーワードの日本語アフィリエイト記事を生成し、
 * Astro のコンテンツコレクション形式（frontmatter 付き Markdown）で
 * src/content/blog/ に保存する。
 *
 * 使い方:
 *   node scripts/generate-post.js "おすすめゲーミングPC"
 *   node scripts/generate-post.js "おすすめゲーミングPC" --slug gaming-pc-2026
 *   node scripts/generate-post.js "おすすめゲーミングPC" --force --model claude-sonnet-5
 *
 * 事前準備:
 *   ANTHROPIC_API_KEY を環境変数に設定（または `ant auth login` でプロファイルを作成）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const blogDir = path.join(projectRoot, 'src/content/blog');
const publicDir = path.join(projectRoot, 'public');

// 記事内画像・アイキャッチ画像に使う画像生成 API（Pollinations）。
// https://image.pollinations.ai/prompt/{english_keyword}?width={width}&height={height}&nologo=true
// で、プロンプト（英語キーワード）に沿った画像が生成される。
const IMAGE_HOST = 'image.pollinations.ai';
const BODY_IMAGE_SIZE = { width: 800, height: 450 };
const HERO_IMAGE_SIZE = { width: 1200, height: 630 };

// AI が妥当な画像 URL を返さなかった場合に使うフォールバック用のプレースホルダー画像。
// Cloudflare Pages で Astro の画像最適化が失敗するため、src/assets/ の相対パスではなく
// public/ をルートとした絶対パスで参照する。
const HERO_IMAGES = [
	'/blog-placeholder-1.jpg',
	'/blog-placeholder-2.jpg',
	'/blog-placeholder-3.jpg',
	'/blog-placeholder-4.jpg',
	'/blog-placeholder-5.jpg',
];

// 楽天アフィリエイトID（楽天アフィリエイトの管理画面で発行されるリンク用ID）。
const RAKUTEN_AFFILIATE_ID = '5788b385.cdd442d9.5788b386.be0db29f';

// pc パラメータに入れる楽天市場の検索結果 URL。この間にエンコード済みキーワードを挟む。
const RAKUTEN_SEARCH_PREFIX = 'https%3A%2F%2Fsearch.rakuten.co.jp%2Fsearch%2Fmall%2F';
const RAKUTEN_SEARCH_SUFFIX = '%2F';

// AI が本文に埋め込むアフィリエイトリンクのプレースホルダー。
// AFFILIATE_LINK:ワイヤレスイヤホン と AFFILIATE_LINK_1:ワイヤレスイヤホン の両形式を受け付ける
// （キーワードのない AFFILIATE_LINK_1 だけの場合は記事のキーワードで代替する）。
const AFFILIATE_MARKDOWN_LINK =
	/\[([^\]]*)\]\(\s*AFFILIATE_LINK(?:_\d+)?(?:\s*[:：]\s*([^)]*))?\s*\)/g;
const AFFILIATE_BARE_PLACEHOLDER = /AFFILIATE_LINK(?:_\d+)?(?:\s*[:：]\s*([^\s)\]、。]+))?/g;

/**
 * slug からフォールバック用の heroImage を決定する。
 * 実ファイルの存在を確認し、存在するものだけを候補にする
 * （存在しないパスを frontmatter に書くと画像が 404 になるため）。
 */
function pickHeroImage(slug) {
	// heroImage のパスは public/ をルートとしたサイト絶対パス
	const available = HERO_IMAGES.filter((image) =>
		fs.existsSync(path.join(publicDir, image)),
	);

	if (available.length === 0) {
		throw new Error(
			`プレースホルダー画像が見つかりません（${publicDir} を確認してください）`,
		);
	}

	return available[hash(slug) % available.length];
}

/**
 * 画像生成のプロンプトに使う英語キーワードを整える。
 * 生成される絵の精度を上げるため、ハイフンやカンマ区切りは半角スペースに開き、
 * 英小文字・数字・スペースだけの短いフレーズにする。
 */
function sanitizeImagePrompt(raw) {
	return String(raw ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6)
		.join(' ')
		.slice(0, 80)
		.trim();
}

/** プロンプトとサイズから Pollinations の画像 URL を組み立てる。 */
function buildImageUrl(prompt, { width, height }) {
	// prompt はパスの1セグメントなので、スペースなどが入っても URL が壊れないようエンコードする
	return `https://${IMAGE_HOST}/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;
}

/**
 * 画像 URL からプロンプト（どんな絵が生成されるかを決める英語キーワード）を取り出す。
 * Pollinations 以外の URL やローカルパス、プロンプトを取り出せないものは null を返す。
 */
function extractImagePrompt(rawUrl) {
	let url;
	try {
		url = new URL(String(rawUrl).trim());
	} catch {
		return null;
	}

	if (url.protocol !== 'https:' || url.hostname !== IMAGE_HOST) return null;

	// パスは /prompt/laptop%20desk の形。
	let pathname = url.pathname;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// 不正なエスケープが含まれる場合は素の pathname のまま扱う
	}

	const segments = pathname.split('/').filter(Boolean);
	const promptIndex = segments.indexOf('prompt');

	// prompt/ が付いていない場合も、残りのセグメントをまとめてプロンプトとして拾う
	return (
		sanitizeImagePrompt(
			(promptIndex !== -1 ? segments.slice(promptIndex + 1) : segments).join(' '),
		) || null
	);
}

/**
 * AI が生成した画像 URL を
 * https://image.pollinations.ai/prompt/{english_keyword}?width={width}&height={height}&nologo=true
 * の形に正規化する。プロンプトを取り出せないものは null を返す
 * （画像が表示できないとレイアウトが壊れるため、呼び出し側で除去・代替する）。
 */
function normalizeImageUrl(rawUrl, size) {
	const prompt = extractImagePrompt(rawUrl);
	if (!prompt) return null;

	return buildImageUrl(prompt, size);
}

/**
 * 楽天市場の検索キーワードとして使える形に整える。
 * Markdown の記号や改行を落とし、長すぎるものは切り詰める。
 */
function sanitizeSearchKeyword(raw) {
	return String(raw ?? '')
		.replace(/[\r\n]+/g, ' ')
		.replace(/[[\]()<>"'`|*_#]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 50)
		.trim();
}

/**
 * 検索キーワードから楽天アフィリエイトの検索リンクを組み立てる。
 * キーワードを取り出せない場合は null を返す（呼び出し側でリンクを諦める）。
 */
function buildRakutenAffiliateLink(keyword) {
	const cleaned = sanitizeSearchKeyword(keyword);
	if (!cleaned) return null;

	// pc パラメータは「URL エンコードされた楽天市場の検索 URL」なので、
	// キーワードだけを encodeURIComponent し、URL の記号は %3A / %2F のリテラルとして組む。
	const pc = `${RAKUTEN_SEARCH_PREFIX}${encodeURIComponent(cleaned)}${RAKUTEN_SEARCH_SUFFIX}`;

	return `https://hb.afl.rakuten.co.jp/ichiba/${RAKUTEN_AFFILIATE_ID}/?pc=${pc}`;
}

/**
 * 本文中の AFFILIATE_LINK プレースホルダーを実際の楽天アフィリエイト検索リンクに差し替える。
 * 差し替えた本数も返し、リンクが1本も入らなかった場合に警告できるようにする。
 */
function insertAffiliateLinks(text, fallbackKeyword) {
	let replaced = 0;

	// キーワードが空だったり記号だけだった場合は記事のキーワードで代替する
	const resolve = (rawKeyword) => {
		const keyword = sanitizeSearchKeyword(rawKeyword) || sanitizeSearchKeyword(fallbackKeyword);
		const link = buildRakutenAffiliateLink(keyword);
		if (link) replaced++;
		return { keyword, link };
	};

	// [ワイヤレスイヤホンを楽天市場で探す](AFFILIATE_LINK:ワイヤレスイヤホン) 形式
	let result = text.replace(AFFILIATE_MARKDOWN_LINK, (match, label, rawKeyword) => {
		const { keyword, link } = resolve(rawKeyword);
		if (!link) return label.trim() || match;
		return `[${label.trim() || `${keyword}を楽天市場で探す`}](${link})`;
	});

	// Markdown リンクの形になっていない裸のプレースホルダーが残った場合も拾う
	result = result.replace(AFFILIATE_BARE_PLACEHOLDER, (_match, rawKeyword) => {
		const { keyword, link } = resolve(rawKeyword);
		if (!link) return '';
		return `[${keyword}を楽天市場で探す](${link})`;
	});

	return { text: result, replaced };
}

/**
 * frontmatter の title 行からタイトルを取り出す。
 * 取り出せない場合は空文字を返す（重複判定はスラッグ側で行うため致命的ではない）。
 */
function extractFrontmatterTitle(contents) {
	const text = contents.replace(/\r\n/g, '\n');
	if (!text.startsWith('---\n')) return '';

	const closing = text.indexOf('\n---', 3);
	const frontmatter = closing === -1 ? text : text.slice(4, closing);

	const match = frontmatter.match(/^title[ \t]*:[ \t]*(.+?)[ \t]*$/m);
	if (!match) return '';

	const value = match[1].trim();
	// YAML のクオートを外す（シングルクオート内の '' は ' のエスケープ）
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"');
	}
	return value;
}

/**
 * src/content/blog/ にある既存記事のスラッグ（ファイル名）とタイトルを集める。
 * AI に「既にあるテーマ」を伝えて重複を避けさせるために使う。
 */
function readExistingPosts() {
	if (!fs.existsSync(blogDir)) return [];

	return fs
		.readdirSync(blogDir)
		.filter((name) => name.toLowerCase().endsWith('.md'))
		.map((name) => {
			const slug = name.replace(/\.md$/i, '');
			let title = '';
			try {
				// frontmatter だけ読めればよいので先頭のみ読み込む
				title = extractFrontmatterTitle(
					fs.readFileSync(path.join(blogDir, name), 'utf8').slice(0, 2000),
				);
			} catch {
				// 読めないファイルはタイトルなしで扱う
			}
			return { slug, title };
		})
		.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** 既存記事の一覧を、プロンプトに差し込む「重複禁止」セクションの文字列にする。 */
function buildExistingPostsSection(existingPosts) {
	if (existingPosts.length === 0) return '';

	const list = existingPosts
		.map(({ slug, title }) => `- ${slug}${title ? `（${title}）` : ''}`)
		.join('\n');

	return `

# 既存記事一覧（重複禁止）
以下の既存テーマ・スラッグとは絶対に被らない、新しいジャンル・キーワードで記事を作成してください。

${list}

- 上に並んだスラッグと同じ、または一字違い程度の似たスラッグは使わないでください。
- 上の記事と同じ商品ジャンル・切り口になりそうな場合は、指定キーワードの中でも未使用の切り口・サブジャンルを選び、title と slug の両方を既存記事と明確に区別できるものにしてください。`;
}

/**
 * 既存ファイルと重複しないスラッグを返す。
 * 重複した場合は末尾に日付（-YYYYMMDD）を付けてファイルの上書きを防ぐ。
 * 日付付きでも重複する場合（同日に2本目以降）は連番を足す。
 */
function resolveUniqueSlug(slug, existingSlugs) {
	if (!existingSlugs.has(slug)) return slug;

	const datestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
	const dated = `${slug}-${datestamp}`;
	if (!existingSlugs.has(dated)) return dated;

	for (let suffix = 2; ; suffix++) {
		const candidate = `${dated}-${suffix}`;
		if (!existingSlugs.has(candidate)) return candidate;
	}
}

/** 構造化出力のスキーマ。frontmatter 用の項目と本文を分けて受け取る。 */
const ARTICLE_SCHEMA = {
	type: 'object',
	properties: {
		title: {
			type: 'string',
			description: '記事タイトル。32文字以内の日本語。キーワードを含める。',
		},
		description: {
			type: 'string',
			description: 'meta description 用の要約。70〜110文字の日本語。',
		},
		slug: {
			type: 'string',
			description:
				'ファイル名に使う英小文字のスラッグ。半角英数字とハイフンのみ、3〜60文字（例: recommended-gaming-pc）。',
		},
		heroImage: {
			type: 'string',
			description:
				'frontmatter のアイキャッチ画像 URL。記事全体のテーマを表す英語キーワードを使い、https://image.pollinations.ai/prompt/{english_keyword}?width=1200&height=630&nologo=true の形式で出力する（例: https://image.pollinations.ai/prompt/laptop on wooden desk?width=1200&height=630&nologo=true）。',
		},
		imagePrompts: {
			type: 'array',
			description:
				'body の H2 見出しの順番に対応する、本文画像用の英語キーワード（画像生成プロンプト）の配列。要素数は H2 見出しの数と一致させる。各要素は半角英小文字とスペースのみの2〜5語（例: laptop on wooden desk）。',
			items: { type: 'string' },
		},
		body: {
			type: 'string',
			description:
				'記事本文の Markdown。frontmatter と H1 見出しは含めない（H2 から始める）。すべての H2 見出しの直下に、空行を挟んで ![日本語のaltテキスト](https://image.pollinations.ai/prompt/{english_keyword}?width=800&height=450&nologo=true) 形式の画像を必ず1枚入れる（画像のない H2 見出しを作らない）。商品へのリンクは [リンクテキスト](AFFILIATE_LINK:検索キーワード) の形式で書き、検索キーワードには楽天市場で検索して商品が見つかる日本語の商品名・カテゴリ名（例: ワイヤレスイヤホン）を入れる。',
		},
	},
	required: ['title', 'description', 'slug', 'heroImage', 'imagePrompts', 'body'],
	additionalProperties: false,
};

const SYSTEM_PROMPT = `あなたは日本語のアフィリエイトメディアを担当する編集者兼ライターです。
読者の購買判断に本当に役立つ、SEO を意識した記事を Markdown で執筆します。

# 記事の構成方針
- 冒頭200文字程度で「この記事で分かること」と結論（おすすめの方向性）を示す。
- H2（##）で大見出し、必要に応じて H3（###）で小見出しを使う。H1 は使わない。
- 「選び方のポイント」→「おすすめ商品の比較表」→「商品ごとの詳細」→「よくある質問」→「まとめ」の流れを基本とする。
- 比較表は Markdown のテーブルで作り、商品名・特徴・価格帯・向いている人などの列を持たせる。
- 商品ごとの詳細では、メリットとデメリットの両方を必ず書く。デメリットを省略しない。
- よくある質問は H3 で3〜5問。
- 全体で2500〜4000文字程度。

# アフィリエイト記事としての要件
- 記事冒頭に「※本記事にはアフィリエイト広告（PR）を含みます。」という1行の広告表記を入れる（ステルスマーケティング規制への対応）。
- 商品へのリンクは必ず [リンクテキスト](AFFILIATE_LINK:検索キーワード) の形式で書く。URL 部分には実在の URL を書かず、この AFFILIATE_LINK: プレースホルダーだけを使う（スクリプト側で楽天市場の検索リンクに置き換わる）。
- 検索キーワードには、楽天市場で検索したときにその商品が実際に見つかる日本語の商品名・カテゴリ名を入れる（例: AFFILIATE_LINK:ワイヤレスイヤホン、AFFILIATE_LINK:ゲーミングPC）。
- 検索キーワードはスペース・記号・改行を含めない20文字以内の日本語にする。複数の語を並べず、最も検索されやすい1語を選ぶ。
- 実在しない型番をキーワードにしない。商品の類型（例: 完全ワイヤレスイヤホン、ロボット掃除機）を使う。
- 各商品の詳細セクションの末尾に、必ずこの形式のリンクを1つ置く。セクションごとに、そのセクションの内容に合ったキーワードを選ぶ。
- リンクテキストは「〇〇を楽天市場で探す」「〇〇の価格をチェックする」のように、遷移先が検索結果ページであることが分かる自然な日本語にする。

# 事実の扱い（重要）
- 具体的な価格・型番・スペック・ランキング順位・レビュー件数を断定して書かない。確認できない数値は書かない。
- 価格は「10万円前後」「5万円台から」のような価格帯の表現にとどめ、「執筆時点の目安」など時点の注記を添える。
- 実在しない型番や製品名を作らない。判断に迷う場合は「エントリーモデル」「ミドルレンジモデル」のような類型で書く。
- 医療・健康・金融など断定が危険な領域では、専門家への相談を促す一文を添える。

# 画像の挿入（絶対に守る）
- 本文の H2 見出し（##）は、1つの例外もなく、その直下に画像を1枚だけ置く。画像のない H2 見出しがあってはならない。
- 並び順は必ず「## 見出し行」→「空行」→「画像行」→「空行」→「本文」とする。画像を本文の途中や見出しより前に置かない。
- 画像を置くのは H2 見出しの直下だけ。H3 見出し（###）の直下には置かない。
- 画像は Markdown の画像記法 ![altテキスト](URL) で書く。<img> タグやローカルの画像パス、image.pollinations.ai 以外の URL は使わない。
- 本文中の画像の URL は必ず https://image.pollinations.ai/prompt/{english_keyword}?width=800&height=450&nologo=true の形式にする。クエリ文字列（?width=800&height=450&nologo=true）を省略したり書き換えたりしない。
- {english_keyword} はその見出しの内容に沿った英語キーワード（画像生成 AI へのプロンプト）を自分で考えて埋め込む。半角英小文字とスペースのみで、2〜5語まで（例: laptop on wooden desk、wireless earbuds charging case）。日本語・記号・カンマ・アンダースコアは入れない。
- 見出しごとに異なるキーワードを選び、同じ URL を繰り返さない（キーワードが同じだと同じような画像になる）。
- alt テキストには画像の内容を表す日本語の説明を入れる。空にしたり、英語キーワードをそのまま書いたりしない。
- 次の形をそのまま真似して書く:
  ## 初心者向けノートパソコンの選び方

  ![デスクに置かれたノートパソコンとコーヒー](https://image.pollinations.ai/prompt/laptop and coffee on wooden desk?width=800&height=450&nologo=true)

  ノートパソコンを選ぶときは、まず用途を決めるところから始めます。
- imagePrompts フィールドには、body に書いた H2 見出しの順番どおりに、各画像で使った {english_keyword} を配列で並べる。要素数は H2 見出しの数と一致させる。
- frontmatter のアイキャッチ画像（heroImage フィールド）にも、記事全体のテーマを表す英語キーワードを使った https://image.pollinations.ai/prompt/{english_keyword}?width=1200&height=630&nologo=true を生成して入れる。本文用とは別に、記事のテーマを最もよく表すキーワードを選ぶ。

# 書き終えたあとの自己チェック（必須）
- body に含まれる ## で始まる行をすべて数え、その直下に image.pollinations.ai の画像行があるか1つずつ確認する。
- 抜けている見出しがあれば、返答する前に画像行を追記する。
- imagePrompts の要素数が H2 見出しの数と一致しているか確認する。

# 出力してはいけないもの（重要）
- body に frontmatter（--- で囲まれたメタデータ）は書かない。title・description・slug・heroImage はそれぞれのフィールドで返す。
- body に H1 見出しは書かない。

# 文体
- 「です・ます」調。1文は60文字程度まで。
- 誇大表現（絶対、必ず儲かる、最安値保証 等）は使わない。
- 「この記事では〜」以外のメタ的な自己言及や、AI が生成したことへの言及は入れない。`;

function buildUserPrompt(keyword, today, existingPosts = []) {
	return `次のキーワードでアフィリエイト記事を1本書いてください。

キーワード: ${keyword}
公開日: ${today}

- title には上記キーワードまたはその自然な言い換えを含めてください。
- slug はキーワードの意味を英語で表した半角英小文字のスラッグにしてください（ローマ字表記より、意味が伝わる英語を優先）。
- heroImage には、記事全体のテーマを表す英語キーワードを使った https://image.pollinations.ai/prompt/{english_keyword}?width=1200&height=630&nologo=true を設定してください。
- body は frontmatter を含めず本文の Markdown のみを返してください。
- 画像は必須です。body に出てくるすべての H2 見出し（##）の直下に、空行を挟んで ![日本語のaltテキスト](https://image.pollinations.ai/prompt/{english_keyword}?width=800&height=450&nologo=true) 形式の画像を必ず1枚ずつ入れ、画像のない H2 見出しを1つも作らないでください。
- {english_keyword} は見出しごとに変え、半角英小文字とスペースだけの2〜5語にしてください（例: wireless earbuds charging case）。image.pollinations.ai 以外の画像 URL は使わないでください。
- imagePrompts には、body の H2 見出しの順番どおりに、各画像で使った {english_keyword} を並べてください。要素数は H2 見出しの数と同じにしてください。
- 商品へのリンクは [〇〇を楽天市場で探す](AFFILIATE_LINK:検索キーワード) の形式で書き、検索キーワードには楽天市場で商品が見つかる日本語の商品名・カテゴリ名（スペースなし・20文字以内）を入れてください。${buildExistingPostsSection(existingPosts)}`;
}

function parseArgs(argv) {
	const options = {
		keyword: null,
		slug: null,
		model: DEFAULT_MODEL,
		force: false,
		fallback: true,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--slug':
			case '--model': {
				const value = argv[++i];
				if (!value) throw new Error(`${arg} には値が必要です`);
				options[arg === '--slug' ? 'slug' : 'model'] = value;
				break;
			}
			case '--force':
				options.force = true;
				break;
			case '--no-fallback':
				options.fallback = false;
				break;
			case '-h':
			case '--help':
				options.help = true;
				break;
			default:
				if (arg.startsWith('-')) throw new Error(`不明なオプション: ${arg}`);
				if (options.keyword) throw new Error('キーワードは1つだけ指定してください');
				options.keyword = arg;
		}
	}

	return options;
}

function usage() {
	return `使い方: node scripts/generate-post.js "<キーワード>" [オプション]

オプション:
  --slug <slug>    ファイル名に使うスラッグを明示指定する
  --model <model>  使用するモデル（既定: ${DEFAULT_MODEL}）
  --force          同名ファイルが既にある場合も上書きする
  --no-fallback    リフューザル時のサーバーサイドフォールバックを使わない
  -h, --help       このヘルプを表示する`;
}

/** 1回のストリーミングリクエストで記事 JSON を受け取る。 */
async function requestArticle(client, params) {
	const stream = client.beta.messages.stream(params);

	// 本文は JSON なのでそのまま表示せず、受信中であることだけ示す
	let chunks = 0;
	stream.on('text', () => {
		if (++chunks % 25 === 0) process.stderr.write('.');
	});

	const message = await stream.finalMessage();
	if (chunks >= 25) process.stderr.write('\n');
	return message;
}

async function generateArticle({ client, keyword, model, useFallback, existingPosts = [] }) {
	const params = {
		model,
		max_tokens: 32000,
		system: SYSTEM_PROMPT,
		messages: [
			{
				role: 'user',
				content: buildUserPrompt(
					keyword,
					new Date().toISOString().slice(0, 10),
					existingPosts,
				),
			},
		],
		thinking: { type: 'adaptive' },
		output_config: {
			effort: 'high',
			format: { type: 'json_schema', schema: ARTICLE_SCHEMA },
		},
	};

	let message;
	if (useFallback) {
		try {
			// 安全性判断で拒否された場合、同じリクエスト内で別モデルに引き継がせる
			message = await requestArticle(client, {
				...params,
				betas: [FALLBACK_BETA],
				fallbacks: 'default',
			});
		} catch (error) {
			if (!(error instanceof Anthropic.BadRequestError)) throw error;
			console.warn(
				`警告: フォールバック指定が受理されませんでした（${error.message}）。通常リクエストで再試行します。`,
			);
			message = await requestArticle(client, params);
		}
	} else {
		message = await requestArticle(client, params);
	}

	if (message.stop_reason === 'refusal') {
		const category = message.stop_details?.category ?? 'unknown';
		const explanation = message.stop_details?.explanation ?? '詳細不明';
		throw new Error(`モデルが生成を拒否しました（${category}）: ${explanation}`);
	}
	if (message.stop_reason === 'max_tokens') {
		throw new Error(
			'出力が max_tokens に達して途中で切れました。max_tokens を増やして再実行してください。',
		);
	}

	const text = message.content
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('');

	let article;
	try {
		article = JSON.parse(text);
	} catch {
		throw new Error(`モデルの応答を JSON として解析できませんでした:\n${text.slice(0, 500)}`);
	}

	// imagePrompts は配列なので、文字列必須チェックの対象から外す
	for (const field of ARTICLE_SCHEMA.required) {
		if (field === 'imagePrompts') continue;
		if (typeof article[field] !== 'string' || article[field].trim() === '') {
			throw new Error(`生成結果に ${field} が含まれていません`);
		}
	}

	// 画像プロンプトは見出し画像の補完にしか使わないため、欠けていても生成は続行する
	if (!Array.isArray(article.imagePrompts)) article.imagePrompts = [];

	return { article, servedBy: message.model, usage: message.usage };
}

function hash(value) {
	let result = 0;
	for (const char of String(value)) result = (result * 31 + char.codePointAt(0)) % 2147483647;
	return result;
}

/** 半角英小文字・数字・ハイフンだけのスラッグに整える。 */
function normalizeSlug(raw, fallbackSeed) {
	const slug = String(raw)
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/g, '');

	if (slug) return slug;
	// 日本語だけのスラッグが返ってきた場合などのフォールバック
	return `post-${new Date().toISOString().slice(0, 10)}-${hash(fallbackSeed) % 1000}`;
}

/**
 * 本文のすべての H2 見出しの直下に画像が1枚あることを保証する。
 * AI が画像を書き忘れた場合や、Pollinations 以外の URL だったために除去された場合でも、
 * ここで見出しごとに1枚補う（画像が入るかどうかを AI の出力任せにしない）。
 */
function ensureHeadingImages(text, { imagePrompts = [], slug }) {
	const usedPrompts = new Set();

	// 既に本文にある画像のプロンプトを先に登録し、補った画像が同じ絵柄にならないようにする
	for (const [, url] of text.matchAll(/!\[[^\]]*\]\((\S+?)\)/g)) {
		const prompt = extractImagePrompt(url);
		if (prompt) usedPrompts.add(prompt);
	}

	const promptQueue = imagePrompts.map(sanitizeImagePrompt).filter(Boolean);
	let headings = 0;

	// AI が用意したプロンプトを順に使い、尽きたらスラッグと見出し番号から作る。
	// 同じプロンプトからは同じような画像が出るため、既に使われていれば連番でずらす。
	const takePrompt = () => {
		const base =
			promptQueue.shift() || sanitizeImagePrompt(`${slug} ${headings}`) || `section ${headings}`;

		let prompt = base;
		for (let suffix = 2; usedPrompts.has(prompt); suffix++) prompt = `${base} ${suffix}`;
		usedPrompts.add(prompt);

		return prompt;
	};

	const lines = text.split('\n');
	const output = [];
	let inCodeFence = false;
	let inserted = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		output.push(line);

		// コードフェンスの中身は本文ではないので見出しとして扱わない
		if (/^[ \t]*```/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) continue;

		// ## だけを対象にする（### は ## の次が # なのでここには一致しない）
		const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/);
		if (!heading) continue;
		headings++;

		// 見出しの次にある最初の本文行（空行は読み飛ばす）が画像かどうかを見る
		let next = i + 1;
		while (next < lines.length && lines[next].trim() === '') next++;
		if (/^!\[[^\]]*\]\(\S+?\)[ \t]*$/.test(lines[next] ?? '')) continue;

		// 画像がないので補う。alt テキストは見出しから組み立てる
		const label = heading[1].replace(/[[\]()`*_#|]/g, '').trim();
		const alt = label ? `${label}のイメージ写真` : 'この見出しの内容をイメージした写真';

		// 前後に空行を入れて、独立した段落として画像が描画されるようにする
		output.push('', `![${alt}](${buildImageUrl(takePrompt(), BODY_IMAGE_SIZE)})`, '');
		inserted++;
	}

	return { text: output.join('\n'), headings, inserted };
}

/**
 * 本文に混ざりうる frontmatter・H1・コードフェンスを取り除き、
 * 画像 URL とアフィリエイトリンクを正規化したうえで、
 * すべての H2 見出しの直下に画像が入っている状態にする。
 */
function normalizeBody(body, { fallbackKeyword, imagePrompts, slug }) {
	let text = body.replace(/\r\n/g, '\n').trim();

	// 全体がコードフェンスで包まれている場合は外す
	const fenced = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
	if (fenced) text = fenced[1].trim();

	// 先頭の frontmatter を除去（frontmatter はこちら側で生成する）
	if (text.startsWith('---')) {
		const closing = text.indexOf('\n---', 3);
		if (closing !== -1) {
			const lineEnd = text.indexOf('\n', closing + 1);
			text = (lineEnd === -1 ? '' : text.slice(lineEnd + 1)).trim();
		}
	}

	// 先頭の H1 を除去（タイトルは frontmatter 側で持つ）
	text = text.replace(/^#\s+.*\n+/, '');

	// frontmatter 外に漏れた heroImage 行を除去
	text = text.replace(/^[ \t]*heroImage[ \t]*:.*\n?/gim, '');

	// 画像は Pollinations のものだけ残し、サイズを 800x450 に揃える。
	// それ以外（ローカルパスや他ドメイン）は存在しない画像を参照してビルドや表示が壊れるため、
	// ここでいったん除去し、後続の ensureHeadingImages で見出しごとに貼り直す。
	// プロンプトに素のスペースが入った URL も拾えるよう、URL 部分は ) 以外を許容して取り込み、
	// normalizeImageUrl で URL エンコードし直す（Markdown はスペース入り URL を解釈できない）。
	text = text.replace(/!\[([^\]]*)\]\(\s*([^)]+?)(?:\s+"[^"]*")?\s*\)/g, (_match, alt, url) => {
		const normalized = normalizeImageUrl(url, BODY_IMAGE_SIZE);
		if (!normalized) return '';
		return `![${alt.trim() || 'この見出しの内容をイメージした写真'}](${normalized})`;
	});
	text = text.replace(/<img\b[^>]*>/gi, '');

	// すべての H2 見出しの直下に画像があることを保証する
	// （AI が入れ忘れた分・上で除去された分をここで補う）
	const images = ensureHeadingImages(text, { imagePrompts, slug });
	text = images.text;

	// AFFILIATE_LINK プレースホルダーを実際の楽天アフィリエイト検索リンクに差し替える
	const affiliate = insertAffiliateLinks(text, fallbackKeyword);
	text = affiliate.text;

	// 除去・挿入の結果できた空行の連続をまとめる
	text = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');

	return {
		body: `${text.trim()}\n`,
		affiliateLinks: affiliate.replaced,
		headings: images.headings,
		insertedImages: images.inserted,
	};
}

/** YAML のシングルクオート文字列として安全な形にする。 */
function yamlQuote(value) {
	return `'${String(value).replace(/\s+/g, ' ').trim().replace(/'/g, "''")}'`;
}

function buildFrontmatter({ title, description, pubDate, heroImage }) {
	return [
		'---',
		`title: ${yamlQuote(title)}`,
		`description: ${yamlQuote(description)}`,
		`pubDate: ${yamlQuote(pubDate)}`,
		`heroImage: ${yamlQuote(heroImage)}`,
		'---',
		'',
		'',
	].join('\n');
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	if (options.help) {
		console.log(usage());
		return;
	}
	if (!options.keyword) {
		console.error(`エラー: キーワードを指定してください。\n\n${usage()}`);
		process.exitCode = 1;
		return;
	}

	// API キーが未設定でも `ant auth login` のプロファイルで動くため、ここでは弾かない
	const client = new Anthropic();

	// 既存記事のスラッグとタイトルを先に集め、AI に「被らせないテーマ一覧」として渡す
	const existingPosts = readExistingPosts();
	const existingSlugs = new Set(existingPosts.map((post) => post.slug));

	console.log(`キーワード「${options.keyword}」の記事を ${options.model} で生成します...`);
	if (existingPosts.length > 0) {
		console.log(`  既存記事 ${existingPosts.length} 件と重複しないよう指示します。`);
	}

	const { article, servedBy, usage: tokenUsage } = await generateArticle({
		client,
		keyword: options.keyword,
		model: options.model,
		useFallback: options.fallback,
		existingPosts,
	});

	const requestedSlug = normalizeSlug(options.slug ?? article.slug, options.keyword);
	let slug = requestedSlug;

	// AI が既存記事と同じスラッグを返した場合は日付を足して上書きを避ける。
	// --slug での明示指定は利用者の意図なので、従来どおり下のチェックでエラーにする。
	if (!options.slug && !options.force && existingSlugs.has(slug)) {
		slug = resolveUniqueSlug(slug, existingSlugs);
		console.warn(
			`警告: スラッグ「${requestedSlug}」が既存記事と重複したため「${slug}」に変更しました。テーマ自体が既存記事と被っていないか確認してください。`,
		);
	}

	const filePath = path.join(blogDir, `${slug}.md`);

	if (fs.existsSync(filePath) && !options.force) {
		throw new Error(
			`${path.relative(projectRoot, filePath)} は既に存在します。--force で上書きできます。`,
		);
	}

	const { body, affiliateLinks, headings, insertedImages } = normalizeBody(article.body, {
		fallbackKeyword: options.keyword,
		imagePrompts: article.imagePrompts,
		slug,
	});
	if (affiliateLinks === 0) {
		console.warn(
			'警告: 本文にアフィリエイトリンクが挿入されませんでした（AFFILIATE_LINK プレースホルダーが見つかりません）。',
		);
	}

	// AI が返したアイキャッチ URL を採用し、形式が壊れている場合だけ手元の画像に退避する
	const heroImage = normalizeImageUrl(article.heroImage, HERO_IMAGE_SIZE);
	if (!heroImage) {
		console.warn(
			`警告: heroImage が ${IMAGE_HOST} の URL として解釈できませんでした（${article.heroImage}）。プレースホルダー画像を使います。`,
		);
	}

	const contents =
		buildFrontmatter({
			title: article.title,
			description: article.description,
			pubDate: new Date().toISOString().slice(0, 10),
			heroImage: heroImage ?? pickHeroImage(slug),
		}) + body;

	fs.mkdirSync(blogDir, { recursive: true });
	fs.writeFileSync(filePath, contents, 'utf8');

	console.log(`\n生成しました: ${path.relative(projectRoot, filePath)}`);
	console.log(`  タイトル: ${article.title}`);
	console.log(`  本文: 約${body.length}文字`);
	const bodyImages = (body.match(/!\[[^\]]*\]\(/g) ?? []).length;
	console.log(
		`  本文中の画像: ${bodyImages}枚（H2見出し ${headings}個 / うち自動補完 ${insertedImages}枚）`,
	);
	console.log(`  楽天アフィリエイトリンク: ${affiliateLinks}本`);
	if (servedBy !== options.model) console.log(`  応答モデル: ${servedBy}（フォールバック）`);
	if (tokenUsage) {
		console.log(`  トークン: 入力 ${tokenUsage.input_tokens} / 出力 ${tokenUsage.output_tokens}`);
	}
	console.log('  ※ リンク先の検索キーワードが妥当か、公開前に確認してください。');
}

main().catch((error) => {
	if (error instanceof Anthropic.AuthenticationError) {
		console.error(
			'エラー: 認証に失敗しました。ANTHROPIC_API_KEY を設定するか `ant auth login` を実行してください。',
		);
	} else if (error instanceof Anthropic.RateLimitError) {
		console.error('エラー: レート制限に達しました。しばらく待って再実行してください。');
	} else if (error instanceof Anthropic.APIError) {
		console.error(`エラー: API リクエストが失敗しました (${error.status}): ${error.message}`);
	} else {
		console.error(`エラー: ${error.message}`);
	}
	process.exitCode = 1;
});
