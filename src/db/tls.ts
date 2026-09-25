import { rootCertificates } from 'node:tls'
import { readFileSync } from 'node:fs'

// How the app's database connection is secured, decided once at boot.
//
// It was `ssl: 'require'`, which in postgres.js means rejectUnauthorized:
// false: the traffic is encrypted, but the server's certificate is never
// checked, so anything on the path that answers with ANY certificate can read
// and change every query, credentials included. 'verify' checks the chain and
// the host name.
//
// Supabase's pooler (*.pooler.supabase.com) presents a certificate issued by
// "Supabase Intermediate 2021 CA" under "Supabase Root 2021 CA", a private
// root that no public trust store carries, so verification needs that root.
// It is embedded below. Measured 2026-09-25 against
// aws-0-ap-southeast-1.pooler.supabase.com, ports 5432 and 6543, with a
// TLS-only handshake (SSLRequest, then TLS; no startup message, no user, no
// query): with these exact options the handshake reports authorized === true,
// and without the root it fails SELF_SIGNED_CERT_IN_CHAIN.
//
// The root was read from that handshake's own chain. Its SHA-256 fingerprint:
//   80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
// (serial 6CBC4CA1DEB63F692D0A2024C67289C2D13D54F6, valid 2021-04-28 to 2031-04-26).
// Compare it once with the certificate the Supabase dashboard offers under
// Database settings, SSL configuration (`openssl x509 -noout -fingerprint
// -sha256 -in prod-ca-2021.crt`); they must be identical. It expires in 2031:
// before then, replace it with the root Supabase publishes.
//
// Modes, from DATABASE_SSL:
//   verify   the default in production: chain and host name are checked,
//            against this root plus the public roots Node ships.
//   require  encrypted, certificate NOT checked. The default elsewhere.
//   disable  no TLS, for a local database.
// In production 'require' and 'disable' refuse to start unless
// DATABASE_SSL_INSECURE_OK=1 is set as well, and then say so loudly on every
// boot. DATABASE_SSL_CA_FILE adds one more PEM root, for a database that is not
// Supabase.
export const SUPABASE_ROOT_2021_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`

export type DbSslMode = 'verify' | 'require' | 'disable'

export interface DbSsl {
  mode: DbSslMode
  /** What postgres.js is handed as its `ssl` option. */
  ssl: false | 'require' | { rejectUnauthorized: true; ca: string[] }
  /** A line to print at boot, when the mode deserves one. */
  notice: string | null
}

export function dbSsl(env: NodeJS.ProcessEnv = process.env): DbSsl {
  const production = env.NODE_ENV === 'production'
  const raw = (env.DATABASE_SSL ?? '').trim().toLowerCase()
  const mode: DbSslMode | null = raw === '' ? (production ? 'verify' : 'require')
    : raw === 'verify' || raw === 'require' || raw === 'disable' ? raw : null
  if (!mode) {
    throw new Error(`DATABASE_SSL=${raw} is not one of verify, require, disable`)
  }
  if (mode === 'verify') {
    const ca = [SUPABASE_ROOT_2021_CA, ...rootCertificates]
    if (env.DATABASE_SSL_CA_FILE) ca.push(readFileSync(env.DATABASE_SSL_CA_FILE, 'utf8'))
    return { mode, ssl: { rejectUnauthorized: true, ca }, notice: null }
  }
  const insecure = mode === 'disable'
    ? 'DATABASE_SSL=disable: the database connection is NOT encrypted'
    : 'DATABASE_SSL=require: the database certificate is NOT verified'
  if (production && env.DATABASE_SSL_INSECURE_OK !== '1') {
    throw new Error(`${insecure}, and NODE_ENV is production. Refusing to start. Use DATABASE_SSL=verify, or set DATABASE_SSL_INSECURE_OK=1 to override on purpose.`)
  }
  return {
    mode,
    ssl: mode === 'disable' ? false : 'require',
    notice: production ? `[db] WARNING ${insecure}, in production, because DATABASE_SSL_INSECURE_OK=1. Remove the override.` : null,
  }
}
