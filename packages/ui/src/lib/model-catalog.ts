/**
 * The model catalog's answer, as the panel reads it.
 *
 * The catalog itself is computed by the deployment (the `/api/models-config/catalog` route); the client names the shape
 * it answers with and nothing else. A second implementation of the matching and pricing rules here would be a copy that
 * could disagree with the one the answer came from.
 */

export interface ModelCatalogCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type CompleteModelCatalogCost = Required<ModelCatalogCost>;

export interface ModelCatalogPreset {
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: CompleteModelCatalogCost;
}

export type ModelCatalogMatchMethod = "provider" | "base-url" | "consensus" | "none";

export type ModelCatalogPriceRecommendation =
  | {
      status: "reliable";
      method: Exclude<ModelCatalogMatchMethod, "none">;
      cost: CompleteModelCatalogCost;
      providerId?: string;
      providerName?: string;
      support: number;
      total: number;
    }
  | {
      status: "unreliable";
      reason: "no-exact-match" | "no-valid-price" | "insufficient-support" | "conflict";
      support: number;
      total: number;
    };

export interface ModelCatalogRecommendation {
  exactMatches: number;
  metadataMethod: ModelCatalogMatchMethod;
  matchedProviderId?: string;
  matchedProviderName?: string;
  preset: ModelCatalogPreset;
  price: ModelCatalogPriceRecommendation;
}
