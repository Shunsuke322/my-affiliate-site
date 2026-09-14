import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: z.object({
		title: z.string(),
		description: z.string(),
		// Transform string to Date object
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		// public/ をルートとしたパス（例: '/blog-placeholder-1.jpg'）。
		// Cloudflare Pages で画像最適化が失敗するため image() は使わない。
		heroImage: z.optional(z.string()),
	}),
});

export const collections = { blog };
