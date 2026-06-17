export interface TriggerLabel {
  name: string;
  route: string;
  description: string;
  color: string;
}

export const BUILT_IN_TRIGGER_LABELS: TriggerLabel[] = [
  {
    name: "agent/answer",
    route: "answer",
    description: "Ask Sepo to answer a question or provide plan-only guidance",
    color: "1f883d",
  },
  {
    name: "agent/implement",
    route: "implement",
    description: "Ask Sepo to implement an issue through a pull request",
    color: "0969da",
  },
  {
    name: "agent/create-action",
    route: "create-action",
    description: "Ask Sepo to propose a scheduled agent workflow",
    color: "8250df",
  },
  {
    name: "agent/review",
    route: "review",
    description: "Ask Sepo to review a pull request",
    color: "bf3989",
  },
  {
    name: "agent/fix-pr",
    route: "fix-pr",
    description: "Ask Sepo to push fixes to a pull request branch",
    color: "d1242f",
  },
  {
    name: "agent/orchestrate",
    route: "orchestrate",
    description: "Ask Sepo to run bounded follow-up orchestration",
    color: "fb8c00",
  },
];
