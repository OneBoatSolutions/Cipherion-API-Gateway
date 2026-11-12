import '../config/env.js';
import { credentials, Metadata } from '@grpc/grpc-js';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HealthClient } from '../generated/kms/grpc/health/v1/health.js';
import { grpcCallBackfromNestClient } from '../generated/kms/v1/prototypeBufferV1.js';
import {
  checkClientCertificateExpiry,
  failureReason,
  servingFailure,
  watchKmsConnection,
} from '../kms/kms-connection.js';

// Client for the Cipherion KMS over gRPC with mutual TLS: the gateway checks
// the KMS certificate against KMS_CA_CERT and presents its own certificate.
const address = process.env.KMS_ADDRESS;

if (!address) {
  throw new Error('KMS_ADDRESS is not configured');
}

const readPem = (name: string): Buffer => {
  const path = process.env[name];
  if (!path) {
    throw new Error(`${name} is not configured`);
  }
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`${name} can't be read from ${path}`, { cause: error });
  }
};

const clientCertificate = readPem('KMS_CLIENT_CERT');
checkClientCertificateExpiry(
  new Date(new X509Certificate(clientCertificate).validTo),
);

export const kms = new grpcCallBackfromNestClient(
  address,
  credentials.createSsl(
    readPem('KMS_CA_CERT'),
    readPem('KMS_CLIENT_KEY'),
    clientCertificate,
  ),
);

// Standard grpc.health.v1 service on the same KMS server. It reuses the KMS
// client's channel, so the probe checks the very connection the RPCs use.
// The credentials argument is required by grpc-js but ignored when
// channelOverride is set: health checks go over the KMS mTLS channel.
export const kmsHealth = new HealthClient(
  address,
  credentials.createInsecure(),
  {
    channelOverride: kms.getChannel(),
  },
);

// A health check made while the channel is failing fails at once, and its
// details carry the socket error the channel itself doesn't expose.
const describeFailure = (): Promise<string> =>
  new Promise((resolve) => {
    kmsHealth.check(
      { service: '' },
      new Metadata(),
      { deadline: Date.now() + 1000 },
      (error) =>
        resolve(error ? failureReason(error.details) : 'connection dropped'),
    );
  });

watchKmsConnection(kms.getChannel(), describeFailure);

// grpc.health.v1 Check on the whole KMS server (empty service name), used by
// /ready and the startup check. Only SERVING resolves; NOT_SERVING or an error
// rejects with a short reason. Logs nothing: the connection watch does that.
export function checkKmsServing(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    kmsHealth.check(
      { service: '' },
      new Metadata(),
      { deadline: Date.now() + timeoutMs },
      (error, response) => {
        const failure = servingFailure(error, response?.status);
        if (failure) {
          reject(new Error(failure));
        } else {
          resolve();
        }
      },
    );
  });
}

export const closeKms = (): void => kms.close();
