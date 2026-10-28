import { z } from 'zod';
export const ARTICLE_LIMITS = Object.freeze({ markdownBytes: 512 * 1024, imageBytes: 4 * 1024 * 1024, totalImageBytes: 6 * 1024 * 1024, savedBytes: 12 * 1024 * 1024, images: 64 });
export const articlePathSchema = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
export const articleSchema = z.object({
  id: z.string().uuid(), title: z.string(), markdown: z.string().max(ARTICLE_LIMITS.markdownBytes),
  importedAt: z.string(), sourceName: z.string(),
  assets: z.record(z.string(), z.string().regex(/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/)), warnings: z.array(z.string()),
});
export type Article = z.infer<typeof articleSchema>;
export const articleResultSchema = z.object({ article: articleSchema.nullable() });
export const articleSourceSchema = z.object({ sourcePath: z.string(), files: z.array(z.string()) });
export type ArticleSource = z.infer<typeof articleSourceSchema>;
