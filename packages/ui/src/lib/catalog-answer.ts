/**
 * The model catalog a deployment answers, read into the shape the workbench's selectors use.
 *
 * Two shapes reach this page and only one of them is served today. The Backend states `models` as the list of models it
 * can serve — each with its provider, its limits and the thinking levels it accepts — because that is what a composer
 * needs to render a selector. The retired Next BFF restated the same list twice: a `provider:id` → name map under
 * `models` and the entries themselves under `modelList`. Reading only the second shape from an answer that carries the
 * first is not a cosmetic mismatch: the name map would be built from model objects, and a selector that renders a name
 * would render an object instead.
 *
 * So the answer is read here, once, and the workbench below it holds one shape. A list is the deployment's own answer;
 * a record is the old BFF's name map, kept because its route still exists in this tree until it is deleted, and its
 * `modelList` is the entries beside it.
 */

/** One model as a selector, a transcript's model label and the image-input check read it. */
export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  input?: string[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevelMap?: Record<string, string | null>;
};

export type CatalogAnswer = {
  /** `provider:modelId` → display name, which is the key a transcript's model label looks a model up by. */
  models: Record<string, string>;
  modelList: CatalogModel[];
  defaultModel?: { provider: string; modelId: string } | null;
  defaultThinkingLevel?: string | null;
  savedDefaultThinkingLevel?: string | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One entry as the wire stated it, or undefined when it names no model this page could offer. */
function readModel(value: unknown): CatalogModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  const provider = typeof value.provider === "string" ? value.provider : undefined;
  if (id === undefined || provider === undefined) return undefined;
  return {
    ...value,
    id,
    provider,
    name: typeof value.name === "string" ? value.name : id,
  } as CatalogModel;
}

/**
 * Read one catalog answer.
 *
 * An answer that is not an object is the empty catalog rather than a throw: a failed read is reported by the caller's own
 * error path, and a selector that could not read a catalog offers nothing instead of failing to render.
 */
export function readCatalogAnswer(answer: unknown): CatalogAnswer {
  const body = isRecord(answer) ? answer : {};
  const list = Array.isArray(body.models)
    ? body.models.map(readModel).filter((model): model is CatalogModel => model !== undefined)
    : Array.isArray(body.modelList)
      ? body.modelList.map(readModel).filter((model): model is CatalogModel => model !== undefined)
      : [];
  // A record under `models` is the old BFF's name map, stated by the deployment; a list is the models themselves, so the
  // map beside it is the one those entries produce.
  const names = isRecord(body.models)
    ? Object.fromEntries(Object.entries(body.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : Object.fromEntries(list.map((model) => [model.provider + ":" + model.id, model.name]));
  const defaultModel = isRecord(body.defaultModel)
    && typeof body.defaultModel.provider === "string" && typeof body.defaultModel.modelId === "string"
    ? { provider: body.defaultModel.provider, modelId: body.defaultModel.modelId }
    : null;
  return {
    models: names,
    modelList: list,
    defaultModel,
    defaultThinkingLevel: typeof body.defaultThinkingLevel === "string" ? body.defaultThinkingLevel : null,
    savedDefaultThinkingLevel: typeof body.savedDefaultThinkingLevel === "string" ? body.savedDefaultThinkingLevel : null,
    ...(isRecord(body.thinkingLevels) ? { thinkingLevels: body.thinkingLevels as Record<string, string[]> } : {}),
    ...(isRecord(body.thinkingLevelMaps) ? { thinkingLevelMaps: body.thinkingLevelMaps as Record<string, Record<string, string | null>> } : {}),
    ...(isRecord(body.thinkingLevelPins) ? { thinkingLevelPins: body.thinkingLevelPins as Record<string, string> } : {}),
    ...(typeof body.modelError === "string" ? { modelError: body.modelError } : {}),
    ...(Array.isArray(body.modelScopeWarnings) ? { modelScopeWarnings: body.modelScopeWarnings as string[] } : {}),
  };
}
