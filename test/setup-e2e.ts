import { FREE_PLAN_DEFAULTS } from './../src/config/free-plan.js';
import { mailer } from './../src/lib/mailer.js';

// No e2e test sends a real email. Tests that need a link read it from the calls.
vi.spyOn(mailer, 'send').mockImplementation(() => {});

// Most e2e tests create several projects, groups and devices per user, so the
// free plan is lifted here and no master is set. plan-limits.e2e-spec.ts and
// the usage test set their own values (plan-limits.ts reads them on each call).
for (const name of Object.keys(FREE_PLAN_DEFAULTS)) {
  process.env[name] = '1000000';
}
delete process.env.MASTER_EMAILS;
