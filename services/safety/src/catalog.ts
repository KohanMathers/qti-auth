import type { QtiauthConfig, SafetyActionType } from '@qtiauth/config';

export interface ActionTypeView {
  id: string;
  name: string;
  enabled: boolean;
}

export interface RuleView {
  id: string;
  name: string;
  summary: string;
}

export interface ModerationCatalog {
  actions: ReadonlyMap<string, ActionTypeView>;
  rules: ReadonlyMap<string, RuleView>;
  restrictions: readonly string[];
  requireSecondApproval: boolean;
}

export function loadCatalog(config: QtiauthConfig['safety']): ModerationCatalog {
  const actions = new Map(
    Object.entries(config.actions.types).map(([id, action]) => [
      id,
      { id, name: action.name, enabled: action.enabled },
    ]),
  );
  const rules = new Map(
    Object.entries(config.rules.items).map(([id, rule]) => [
      id,
      { id, name: rule.name, summary: rule.summary },
    ]),
  );
  return {
    actions,
    rules,
    restrictions: config.restrictions,
    requireSecondApproval: config.bans.require_second_approval,
  };
}

export function actionType(catalog: ModerationCatalog, id: string): ActionTypeView | undefined {
  return catalog.actions.get(id);
}

export function ruleOf(catalog: ModerationCatalog, id: string): RuleView | undefined {
  return catalog.rules.get(id);
}

export function isPermanentBan(action: SafetyActionType): boolean {
  return action === 'ban' || action === 'proscribed_org_removal';
}
