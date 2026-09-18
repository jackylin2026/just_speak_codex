import { z } from 'zod';
import { LOCAL_MODELS } from './types';

export const localModelSchema = z.enum(LOCAL_MODELS);

export const textInputSchema = z.object({ text: z.string().trim().min(1).max(12000) });

export const languageFeedbackSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    corrections: z
      .array(
        z
          .object({
            original: z.string().min(1).max(2000),
            suggestion: z.string().min(1).max(2000),
            kind: z.enum(['grammar', 'phrasing']),
            explanation: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(8),
    practice: z.string().min(1).max(2000),
  })
  .strict();

/** One recording, as the detail box sends it for appending to the history. */
export const historyEntrySchema = z
  .object({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    duration: z.number().finite().nonnegative().max(600),
    originalTranscript: z.string().trim().min(1).max(12000),
    polished: z.string().trim().min(1).max(12000),
    language: languageFeedbackSchema.optional(),
    speaking: z.string().trim().min(1).max(20000).optional(),
  })
  .strict();

/** A whole-history rewrite: deleting an entry is a rewrite without it. */
export const historyRewriteSchema = z.object({ markdown: z.string().max(2 * 1024 * 1024) });
