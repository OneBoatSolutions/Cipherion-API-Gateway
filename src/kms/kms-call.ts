import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type CallOptions,
  type Client,
  type ClientUnaryCall,
  Metadata,
  type ServiceError,
  status,
} from '@grpc/grpc-js';
import type { grpcCallBackfromNestClient } from '../generated/kms/v1/prototypeBufferV1.js';
import { kms } from '../lib/kms.js';
import { IncorrectPassphraseException } from './incorrect-passphrase.exception.js';

// Same budget as the readiness checks and Redis commands: a KMS call that
// doesn't answer in time fails instead of holding the request open.
export const KMS_DEADLINE_MS = 2000;

export const KMS_UNAVAILABLE = 'Unavailable. Please try again shortly.';

export type KmsMethod = Exclude<keyof grpcCallBackfromNestClient, keyof Client>;

// For these RPCs the KMS answers PERMISSION_DENIED to a wrong passphrase. On any
// other RPC that status means the gateway itself was refused.
const PASSPHRASE_CHECKING_METHODS: ReadonlySet<string> = new Set<KmsMethod>([
  'rotateWrappingKeyforProjectEncryptionKey',
  'createAndWrapNewGroupRootKeyAndGroupDataEncryptionKey',
  'createDeviceEnvelope',
]);

// Parameters<> resolves to the last overload: (request, metadata, options, callback).
type Signature<M extends KmsMethod> = Parameters<grpcCallBackfromNestClient[M]>;
export type KmsRequest<M extends KmsMethod> = Signature<M>[0];
export type KmsResponse<M extends KmsMethod> = Parameters<Signature<M>[3]>[1];

type UnaryCall = (
  request: unknown,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: unknown) => void,
) => ClientUnaryCall;

const logger = new Logger('KMS');

// Calls one KMS RPC. Never retried: rotating or creating keys twice isn't
// safe. Requests carry passphrases and key material, so they are never logged.
export function kmsCall<M extends KmsMethod>(
  method: M,
  request: KmsRequest<M>,
): Promise<KmsResponse<M>> {
  const call = kms[method] as unknown as UnaryCall;
  const deadline = new Date(Date.now() + KMS_DEADLINE_MS);

  return new Promise((resolve, reject) => {
    call.call(kms, request, new Metadata(), { deadline }, (error, response) => {
      if (error) {
        reject(toHttpException(method, error));
      } else {
        resolve(response as KmsResponse<M>);
      }
    });
  });
}

// Maps the KMS's gRPC status to the HTTP answer. Clients get a generic
// message; the status and details only go to the log.
export function toHttpException(
  method: string,
  error: ServiceError,
): HttpException {
  const summary = `${method} failed: ${status[error.code] ?? error.code} ${error.details}`;

  if (
    error.code === status.PERMISSION_DENIED &&
    PASSPHRASE_CHECKING_METHODS.has(method)
  ) {
    logger.warn(summary);
    return new IncorrectPassphraseException();
  }

  switch (error.code) {
    case status.UNAVAILABLE:
    case status.DEADLINE_EXCEEDED:
      logger.error(summary);
      return new ServiceUnavailableException(KMS_UNAVAILABLE);
    case status.INVALID_ARGUMENT:
    case status.FAILED_PRECONDITION:
      logger.warn(summary);
      return new BadRequestException('The request could not be processed.');
    case status.NOT_FOUND:
      logger.warn(summary);
      return new NotFoundException();
    case status.ALREADY_EXISTS:
      logger.warn(summary);
      return new ConflictException();
    default:
      // Includes UNAUTHENTICATED and any other PERMISSION_DENIED: the gateway's
      // own credentials or setup are wrong, which isn't the caller's fault.
      logger.error(summary);
      return new BadGatewayException();
  }
}
