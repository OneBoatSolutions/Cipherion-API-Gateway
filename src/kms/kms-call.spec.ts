import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Metadata, type ServiceError, status } from '@grpc/grpc-js';
import { IncorrectPassphraseException } from './incorrect-passphrase.exception.js';
import { KMS_DEADLINE_MS, kmsCall, toHttpException } from './kms-call.js';

const { createAndWrapNewProjectRootKey } = vi.hoisted(() => ({
  createAndWrapNewProjectRootKey: vi.fn(),
}));

vi.mock('../lib/kms.js', () => ({ kms: { createAndWrapNewProjectRootKey } }));

const grpcError = (code: status, details = 'boom'): ServiceError =>
  Object.assign(new Error(details), {
    code,
    details,
    metadata: new Metadata(),
  });

describe('kmsCall', () => {
  beforeEach(() => {
    createAndWrapNewProjectRootKey.mockReset();
  });

  it('resolves with the KMS response and sets a deadline', async () => {
    const response = {
      ProjectId: 'p1',
      WrappedProjectRootKeyIV: 'iv',
      WrappedProjectRootKey: 'key',
      WrappedProjectRootKeyTag: 'tag',
    };
    createAndWrapNewProjectRootKey.mockImplementation(
      (_req, _md, _opts, callback) => callback(null, response),
    );
    const before = Date.now();

    await expect(
      kmsCall('createAndWrapNewProjectRootKey', { ProjectId: 'p1' }),
    ).resolves.toEqual(response);

    const [request, metadata, options] =
      createAndWrapNewProjectRootKey.mock.calls[0];
    expect(request).toEqual({ ProjectId: 'p1' });
    expect(metadata).toBeInstanceOf(Metadata);
    const deadline = (options.deadline as Date).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + KMS_DEADLINE_MS);
    expect(deadline).toBeLessThanOrEqual(Date.now() + KMS_DEADLINE_MS);
  });

  it('rejects with the mapped HTTP exception', async () => {
    createAndWrapNewProjectRootKey.mockImplementation(
      (_req, _md, _opts, callback) => callback(grpcError(status.UNAVAILABLE)),
    );

    await expect(
      kmsCall('createAndWrapNewProjectRootKey', { ProjectId: 'p1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('toHttpException', () => {
  it.each([
    [status.UNAVAILABLE, ServiceUnavailableException],
    [status.DEADLINE_EXCEEDED, ServiceUnavailableException],
    [status.INVALID_ARGUMENT, BadRequestException],
    [status.FAILED_PRECONDITION, BadRequestException],
    [status.NOT_FOUND, NotFoundException],
    [status.ALREADY_EXISTS, ConflictException],
    [status.UNAUTHENTICATED, BadGatewayException],
    [status.PERMISSION_DENIED, BadGatewayException],
    [status.INTERNAL, BadGatewayException],
  ])('maps gRPC status %i', (code, Exception) => {
    expect(toHttpException('method', grpcError(code))).toBeInstanceOf(
      Exception,
    );
  });

  it('maps PERMISSION_DENIED to an incorrect passphrase on rotation', () => {
    expect(
      toHttpException(
        'rotateWrappingKeyforProjectEncryptionKey',
        grpcError(status.PERMISSION_DENIED),
      ),
    ).toBeInstanceOf(IncorrectPassphraseException);
  });

  it('keeps PERMISSION_DENIED a gateway fault on RPCs without a passphrase check', () => {
    expect(
      toHttpException(
        'createAndWrapNewProjectRootKey',
        grpcError(status.PERMISSION_DENIED),
      ),
    ).toBeInstanceOf(BadGatewayException);
  });

  it('never exposes the KMS error details to the client', () => {
    const error = toHttpException(
      'method',
      grpcError(
        status.INVALID_ARGUMENT,
        'wrapped key tag mismatch for project p1',
      ),
    );
    expect(JSON.stringify(error.getResponse())).not.toContain('tag mismatch');
  });
});
