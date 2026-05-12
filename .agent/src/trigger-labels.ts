import { getLabelRouteDefinitions, triggerLabelForRoute } from "./routes.js";

export interface TriggerLabel {
  name: string;
  route: string;
  description: string;
  color: string;
}

export const BUILT_IN_TRIGGER_LABELS: TriggerLabel[] = getLabelRouteDefinitions().map(
  (definition) => ({
    name: triggerLabelForRoute(definition.id),
    route: definition.id,
    description: definition.label?.description || "",
    color: definition.label?.color || "",
  }),
);
