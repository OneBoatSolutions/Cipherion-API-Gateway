import { IncorrectPassphraseException } from '../kms/incorrect-passphrase.exception.js';
import {
  clearPassphraseAttempts,
  releasePassphraseAttempt,
  reservePassphraseAttempt,
} from './passphrase-attempts.js';

// Runs a KMS call that checks the project's passphrase, and the write that
// follows it. A wrong passphrase stays counted, success clears the count, and
// any other failure says nothing about the passphrase, so it gives the attempt back.
export async function withPassphraseAttempt<T>(
  projectId: string,
  action: () => Promise<T>,
): Promise<T> {
  await reservePassphraseAttempt(projectId);

  let result: T;
  try {
    result = await action();
  } catch (error) {
    if (!(error instanceof IncorrectPassphraseException)) {
      await releasePassphraseAttempt(projectId);
    }
    throw error;
  }

  await clearPassphraseAttempts(projectId);
  return result;
}
