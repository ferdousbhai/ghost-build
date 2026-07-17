import { z } from 'zod';
import { GUEST_SESSION_ID_PATTERN } from '~/lib/guest-session';

const guestSessionIdSchema = z.string().regex(GUEST_SESSION_ID_PATTERN);
const sessionIdArgsSchema = z.object({ sessionId: z.string() });
const chatIdentityArgsSchema = z.object({ sessionId: z.string(), id: z.string() });
const chatArgsSchema = z.object({ sessionId: z.string(), chatId: z.string() });
const codeArgsSchema = z.object({ code: z.string() });

export const dataOperationArgSchemas = {
  'messages.claimGuestSession': z.object({ guestSessionId: guestSessionIdSchema, sessionId: z.string() }),
  'messages.initializeChat': chatIdentityArgsSchema,
  'messages.get': chatIdentityArgsSchema.extend({ subchatIndex: z.number().int().nonnegative().optional() }),
  'messages.getAll': sessionIdArgsSchema,
  'messages.setUrlId': z.object({
    sessionId: z.string(),
    chatId: z.string(),
    urlHint: z.string(),
    description: z.string(),
  }),
  'messages.setDescription': chatIdentityArgsSchema.extend({ description: z.string() }),
  'messages.remove': chatIdentityArgsSchema,
  'messages.earliestRewindableMessageRank': chatArgsSchema.extend({ subchatIndex: z.number().optional() }),
  'messages.rewindChat': chatArgsSchema.extend({
    subchatIndex: z.number().optional(),
    lastMessageRank: z.number().optional(),
  }),
  'subchats.get': chatArgsSchema,
  'subchats.create': chatArgsSchema,
  'snapshot.getSnapshotUrl': chatArgsSchema,
  'share.create': chatIdentityArgsSchema,
  'share.getShareDescription': codeArgsSchema,
  'share.clone': z.object({ shareCode: z.string(), sessionId: z.string() }),
  'socialShare.share': chatIdentityArgsSchema.extend({ isShared: z.boolean() }),
  'socialShare.getCurrentSocialShare': chatIdentityArgsSchema,
  'socialShare.getSocialShare': codeArgsSchema,
} as const;
