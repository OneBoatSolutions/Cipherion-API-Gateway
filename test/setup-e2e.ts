import { mailer } from './../src/lib/mailer.js';

// No e2e test sends a real email. Tests that need a link read it from the calls.
vi.spyOn(mailer, 'send').mockImplementation(() => {});
