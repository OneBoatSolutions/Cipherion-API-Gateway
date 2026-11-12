// Limits for every account except the master's, until there is billing. Each
// can be changed in the environment; these are the defaults. Kept free of
// imports so the Joi schema can use them too.
export const FREE_PLAN_DEFAULTS = {
  FREE_PLAN_MAX_PROJECTS: 1,
  FREE_PLAN_MAX_GROUPS_PER_PROJECT: 2,
  FREE_PLAN_MAX_PEOPLE_PER_GROUP: 3,
  FREE_PLAN_MAX_DEVICES: 1,
  FREE_PLAN_MAX_ENCRYPTIONS_PER_MONTH: 500,
  FREE_PLAN_MAX_DECRYPTIONS_PER_MONTH: 500,
} as const;

export type FreePlanVariable = keyof typeof FREE_PLAN_DEFAULTS;
