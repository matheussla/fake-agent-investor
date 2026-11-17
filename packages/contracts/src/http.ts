import { z } from "zod";

const uuid = z.string().uuid();
const positiveDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).refine((value) => Number(value) > 0);

export const EmptyControlBodySchema = z.object({}).strict();
export const PauseBodySchema = z.object({ reason: z.enum(["manual"]).default("manual") }).strict();
export const RunOnceBodySchema = z.object({ requestId: uuid }).strict();
export const SavePromptBodySchema = z.object({ name: z.string().trim().min(1).max(80), content: z.string().trim().min(1).max(12_000) }).strict();
export const ActivatePromptBodySchema = z.object({ promptVersionId: uuid }).strict();
export const SettingsBodySchema = z.object({ expectedVersion: z.number().int().min(1), values: z.record(z.string(), z.unknown()) }).strict();
export const NewSimulationBodySchema = z.object({ startingCash: positiveDecimal, requestId: uuid }).strict();
