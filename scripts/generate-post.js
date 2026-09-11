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

// src/assets/ に同梱されているプレースホルダー画像（記事ごとに一枚割り当てる）。
// heroImage はこのリストの値だけを使う。モデルには一切生成させない。
const HERO_IMAGES = [
	'../../assets/blog-placeholder-1.jpg',
	'../../assets/blog-placeholder-2.jpg',
	'../../assets/blog-placeholder-3.jpg',
	'../../assets/blog-placeholder-4.jpg',
	'../../assets/blog-placeholder-5.jpg',
];

/**
 * slug から heroImage を決定する。
 * 実ファイルの存在を確認し、存在するものだけを候補にする
 * （存在しないパスを frontmatter に書くと Astro のビルドが落ちるため）。
 */
function pickHeroImage(slug) {
	// heroImage のパスは src/content/blog/<slug>.md からの相対パス
	const available = HERO_IMAGES.filter((image) =>
		fs.existsSync(path.resolve(blogDir, image)),
	);

	if (available.length === 0) {
		throw new Error(
			`プレースホルダー画像が見つかりません（${path.join(projectRoot, 'src/assets')} を確認してください）`,
		);
	}

	return available[hash(slug) % available.length];
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
		body: {
			type: 'string',
			description:
				'記事本文の Markdown。frontmatter・H1 見出し・画像は含めない（H2 から始める）。heroImage などの画像パスは書かない。',
		},
	},
	required: ['title', 'description', 'slug', 'body'],
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
- 商品へのリンクは [商品名の詳細を見る](AFFILIATE_LINK_1) のようにプレースホルダー（AFFILIATE_LINK_1, AFFILIATE_LINK_2, ...）で記述する。実在の URL は書かない。
- 各商品の詳細セクションの末尾に、必ずリンクのプレースホルダーを1つ置く。

# 事実の扱い（重要）
- 具体的な価格・型番・スペック・ランキング順位・レビュー件数を断定して書かない。確認できない数値は書かない。
- 価格は「10万円前後」「5万円台から」のような価格帯の表現にとどめ、「執筆時点の目安」など時点の注記を添える。
- 実在しない型番や製品名を作らない。判断に迷う場合は「エントリーモデル」「ミドルレンジモデル」のような類型で書く。
- 医療・健康・金融など断定が危険な領域では、専門家への相談を促す一文を添える。

# 出力してはいけないもの（重要）
- frontmatter（--- で囲まれたメタデータ）は書かない。title・description・pubDate・heroImage はスクリプト側で付与する。
- heroImage や画像のパス・ファイル名を書かない。存在しない画像を参照するとビルドが失敗する。
- 本文に Markdown の画像記法（![...](...)）や <img> タグを入れない。

# 文体
- 「です・ます」調。1文は60文字程度まで。
- 誇大表現（絶対、必ず儲かる、最安値保証 等）は使わない。
- 「この記事では〜」以外のメタ的な自己言及や、AI が生成したことへの言及は入れない。`;

function buildUserPrompt(keyword, today) {
	return `次のキーワードでアフィリエイト記事を1本書いてください。

キーワード: ${keyword}
公開日: ${today}

- title には上記キーワードまたはその自然な言い換えを含めてください。
- slug はキーワードの意味を英語で表した半角英小文字のスラッグにしてください（ローマ字表記より、意味が伝わる英語を優先）。
- body は frontmatter（heroImage を含む）や画像記法を含めず、本文の Markdown のみを返してください。`;
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

async function generateArticle({ client, keyword, model, useFallback }) {
	const params = {
		model,
		max_tokens: 32000,
		system: SYSTEM_PROMPT,
		messages: [
			{
				role: 'user',
				content: buildUserPrompt(keyword, new Date().toISOString().slice(0, 10)),
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

	for (const field of ARTICLE_SCHEMA.required) {
		if (typeof article[field] !== 'string' || article[field].trim() === '') {
			throw new Error(`生成結果に ${field} が含まれていません`);
		}
	}

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

/** 本文に混ざりうる frontmatter・H1・コードフェンスを取り除く。 */
function normalizeBody(body) {
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

	// モデルが作った画像参照を除去（存在しないパスを参照するとビルドが落ちる）
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
	text = text.replace(/<img\b[^>]*>/gi, '');

	// 除去の結果できた空行の連続をまとめる
	text = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');

	return `${text.trim()}\n`;
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

	console.log(`キーワード「${options.keyword}」の記事を ${options.model} で生成します...`);

	const { article, servedBy, usage: tokenUsage } = await generateArticle({
		client,
		keyword: options.keyword,
		model: options.model,
		useFallback: options.fallback,
	});

	const slug = normalizeSlug(options.slug ?? article.slug, options.keyword);
	const filePath = path.join(blogDir, `${slug}.md`);

	if (fs.existsSync(filePath) && !options.force) {
		throw new Error(
			`${path.relative(projectRoot, filePath)} は既に存在します。--force で上書きできます。`,
		);
	}

	const body = normalizeBody(article.body);
	const contents =
		buildFrontmatter({
			title: article.title,
			description: article.description,
			pubDate: new Date().toISOString().slice(0, 10),
			heroImage: pickHeroImage(slug),
		}) + body;

	fs.mkdirSync(blogDir, { recursive: true });
	fs.writeFileSync(filePath, contents, 'utf8');

	console.log(`\n生成しました: ${path.relative(projectRoot, filePath)}`);
	console.log(`  タイトル: ${article.title}`);
	console.log(`  本文: 約${body.length}文字`);
	if (servedBy !== options.model) console.log(`  応答モデル: ${servedBy}（フォールバック）`);
	if (tokenUsage) {
		console.log(`  トークン: 入力 ${tokenUsage.input_tokens} / 出力 ${tokenUsage.output_tokens}`);
	}
	console.log('  ※ AFFILIATE_LINK_n を実際のアフィリエイトリンクに差し替えてください。');
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
