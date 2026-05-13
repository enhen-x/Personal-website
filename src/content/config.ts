import { defineCollection, z } from 'astro:content';

const timelineCollection = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string(),
    location: z.string().optional(),
  }),
});

const postSchema = z.object({
  title: z.string(),
  date: z.date(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
});

const photographyCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string(),
    location: z.string().optional(),
    cover: z.string(),           // 封面图路径，相对于 /public
    photos: z.array(z.object({
      src: z.string(),
      caption: z.string().optional(),
    })),
  }),
});

export const collections = {
  timeline: timelineCollection,
  abroad: defineCollection({ type: 'content', schema: postSchema }),
  projects: defineCollection({ type: 'content', schema: postSchema }),
  economics: defineCollection({ type: 'content', schema: postSchema }),
  photography: photographyCollection,
  books: defineCollection({ type: 'content', schema: postSchema }),
};
