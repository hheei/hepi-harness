/**
 * The `enabledModels` answer, as the Models panel reads it.
 *
 * The setting is a whitelist of pi `--models` patterns, and the minimal-edit arithmetic that turns one switch into a new
 * pattern list belongs to the deployment that owns the settings file; the client names the view it answers with and
 * writes back through `PUT /api/models/enabled`.
 */

export interface EnabledModelsModelView {
  id: string;
  name: string;
  /** `provider/modelId`, the reference used by every edit. */
  ref: string;
  enabled: boolean;
  /** Thinking level pinned by a `:level` pattern; read-only in pi-web. */
  thinkingPin?: string;
}

export interface EnabledModelsProviderView {
  id: string;
  name: string;
  /**
   * `builtin` covers pi's own providers and any provider an extension registered; both own their model lists, so
   * individual models can only be hidden through `enabledModels`. `custom` providers come from models.json, where a model
   * can simply be deleted, so they are switched as a whole.
   */
  kind: "builtin" | "custom";
  enabledCount: number;
  models: EnabledModelsModelView[];
}

/** Payload of `GET`/`PUT /api/models/enabled`, shared with the browser. */
export interface EnabledModelsView {
  /** True when nothing narrows the model list. */
  allEnabled: boolean;
  patterns: string[] | null;
  /** Configured patterns that match no available model; every edit keeps them. */
  stalePatterns: string[];
  enabledTotal: number;
  availableTotal: number;
  providers: EnabledModelsProviderView[];
  /** Which settings file the effective value comes from. */
  scope: "global" | "project";
  /** That file's path, shortened for display, e.g. `~/.pi/agent/settings.json`. */
  settingsPath: string;
  /** False when project settings shadow the global value pi-web can write. */
  editable: boolean;
  modelError?: string;
}
