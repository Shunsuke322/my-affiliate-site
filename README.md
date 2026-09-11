# Astro Starter Kit: Blog

```sh
npm create astro@latest -- --template blog
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

Features:

- ✅ Minimal styling (make it your own!)
- ✅ 100/100 Lighthouse performance
- ✅ SEO-friendly with canonical URLs and Open Graph data
- ✅ Sitemap support
- ✅ RSS Feed support
- ✅ Markdown & MDX support

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
├── public/
├── scripts/
├── src/
│   ├── assets/
│   ├── components/
│   ├── content/
│   ├── layouts/
│   └── pages/
├── astro.config.mjs
├── README.md
├── package.json
└── tsconfig.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

The `src/content/` directory contains "collections" of related Markdown and MDX documents. Use `getCollection()` to retrieve posts from `src/content/blog/`, and type-check your frontmatter using an optional schema. See [Astro's Content Collections docs](https://docs.astro.build/en/guides/content-collections/) to learn more.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |
| `npm run generate -- "<キーワード>"` | キーワードからアフィリエイト記事を生成（下記参照） |

## ✍️ 記事の自動生成

`scripts/generate-post.js` は、Anthropic API（Claude）でキーワードから日本語のアフィリエイト記事を生成し、`src/content/blog/` に Markdown として保存するスクリプトです。

### セットアップ

1. 依存パッケージをインストールします。

   ```sh
   npm install
   ```

2. API キーを環境変数に設定します（キーは [Claude Console](https://console.anthropic.com/) で発行）。

   ```sh
   # macOS / Linux
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

   ```powershell
   # Windows (PowerShell)
   $env:ANTHROPIC_API_KEY = "sk-ant-..."
   ```

   `ant auth login` でログイン済みの場合は、環境変数を設定しなくてもそのプロファイルが使われます。

### 使い方

```sh
node scripts/generate-post.js "おすすめゲーミングPC"

# npm スクリプト経由（オプションは -- の後ろに書きます）
npm run generate -- "おすすめゲーミングPC" --slug gaming-pc-2026
```

| オプション         | 説明                                                       |
| :----------------- | :--------------------------------------------------------- |
| `--slug <slug>`    | ファイル名に使うスラッグを明示指定する                     |
| `--model <model>`  | 使用するモデル（既定: `claude-opus-5`）                    |
| `--force`          | 同名ファイルが既にある場合も上書きする                     |
| `--no-fallback`    | 生成が拒否された際のサーバーサイドフォールバックを使わない |
| `-h`, `--help`     | ヘルプを表示する                                           |

### 生成される記事について

- 保存先は `src/content/blog/<スラッグ>.md` です。スラッグはモデルが提案した英語表記を半角英小文字に正規化して使います。
- frontmatter は `src/content.config.ts` のスキーマに合わせて `title` / `description` / `pubDate` / `heroImage` を出力します。`heroImage` は `src/assets/blog-placeholder-*.jpg` から自動で割り当てられます。
- 本文は「選び方 → 比較表 → 商品ごとの詳細 → よくある質問 → まとめ」の構成で、冒頭に広告表記（PR）が入ります。
- **商品リンクは `AFFILIATE_LINK_1` のようなプレースホルダーで出力されます。公開前に実際のアフィリエイトリンクへ差し替えてください。**
- 価格やスペックは断定を避けるよう指示していますが、事実確認は保証されません。公開前に必ず内容を目視で確認してください。
- 実行するたびに Anthropic API の利用料が発生します。

生成後は `npm run dev` で表示を確認できます。

## 👀 Want to learn more?

Check out [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).

## Credit

This theme is based off of the lovely [Bear Blog](https://github.com/HermanMartinus/bearblog/).
