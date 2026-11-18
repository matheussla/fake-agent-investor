import { z } from "zod";

const environmentSchema = z.object({
  HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
});

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env) => environmentSchema.parse(environment);
