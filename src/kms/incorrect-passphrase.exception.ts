import { ForbiddenException } from '@nestjs/common';

// Its own class so a route can tell a wrong passphrase from other 403s.
export class IncorrectPassphraseException extends ForbiddenException {
  constructor() {
    super('Incorrect passphrase');
  }
}
