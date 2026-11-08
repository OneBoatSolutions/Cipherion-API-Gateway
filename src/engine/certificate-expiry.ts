import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { splitPemCertificates } from './engine-tls.js';

const DAY_MS = 86_400_000;
const WARNING_DAYS = 30;

export interface WatchedCertificate {
  label: string;
  notAfter: Date;
}

// A gateway can run for months without a restart, so a check at startup isn't
// enough. `make expiry` doesn't cover the engine server certificate at all.
export function reportCertificateExpiry(
  certificates: WatchedCertificate[],
  logger: Pick<Logger, 'error' | 'warn'> = new Logger('Certificates'),
  now: number = Date.now(),
): void {
  for (const { label, notAfter } of certificates) {
    const daysLeft = (notAfter.getTime() - now) / DAY_MS;
    if (daysLeft <= 0) {
      logger.error(`${label} has expired`);
    } else if (daysLeft < WARNING_DAYS) {
      logger.warn(`${label} expires in ${Math.floor(daysLeft)} days`);
    }
  }
}

function loadCertificates(
  label: string,
  path: string | undefined,
): WatchedCertificate[] {
  if (!path) {
    return [];
  }
  return splitPemCertificates(readFileSync(path, 'utf8')).map((pem, index) => ({
    label: `${label} #${index + 1}`,
    notAfter: new Date(new X509Certificate(pem).validTo),
  }));
}

// Checked now and once a day. The timer doesn't keep the process alive.
export function watchCertificateExpiry(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const certificates = [
    ...loadCertificates('KMS_CLIENT_CERT', env.KMS_CLIENT_CERT),
    ...loadCertificates('KMS_CA_CERT', env.KMS_CA_CERT),
    ...loadCertificates('DEVICE_TLS_CERT', env.DEVICE_TLS_CERT),
    ...loadCertificates('DEVICE_CA_BUNDLE', env.DEVICE_CA_BUNDLE),
  ];
  reportCertificateExpiry(certificates);
  setInterval(() => reportCertificateExpiry(certificates), DAY_MS).unref();
}
