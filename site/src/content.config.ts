import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { z } from 'astro:schema';

/**
 * Docs collection.
 *
 * The schema is extended with two capability fields so pages that document
 * server-backed features declare their prerequisites as data rather than as
 * hand-written prose. A shared `<Requires>` component renders the callout, so
 * the wording stays identical across every page instead of drifting — which
 * matters most for the `-allow-*` flags, where an out-of-date warning is a
 * security problem, not a typo.
 */
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        /** Feature needs a paired companion server (i.e. not offline-capable). */
        requiresServer: z.boolean().default(false),
        /**
         * Capability flags this page's features are gated behind. All are OFF
         * by default. An array because a single page can cover several (the
         * project commands span -allow-code, -allow-exec and -allow-view).
         */
        requiresFlag: z
          .array(z.enum(['allow-exec', 'allow-code', 'allow-view']))
          .optional(),
      }),
    }),
  }),
};
