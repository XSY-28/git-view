import { z } from 'zod';

export const languageSchema = z.enum(['en', 'zh-CN']);
export type Language = z.infer<typeof languageSchema>;
export const preferencesSchema = z.object({ schemaVersion: z.literal(1), language: languageSchema }).strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = { schemaVersion: 1, language: 'en' };
