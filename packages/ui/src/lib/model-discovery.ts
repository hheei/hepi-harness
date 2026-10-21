/** One model a provider's own `/models` answer listed, as `POST /api/models-config/discover` states it. */
export interface DiscoveredModel {
  id: string;
  name?: string;
}
