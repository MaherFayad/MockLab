/**
 * Every user-visible string (PLAN.md §11).
 *
 * OWNER: panel-designer. Filled in with the full §11 copy table at milestone M2.
 *
 * Rule §17.6: a literal user-facing string anywhere in panel.js is a bug. Everything
 * the human reads comes from this one export, so translating MockLab means
 * translating this file and nothing else.
 */
export const S = {
  tab: { pick: 'Pick', sources: 'Sources', scenarios: 'Scenarios', settings: 'Settings' },
  boot: { loading: 'Starting MockLab…' }
};
