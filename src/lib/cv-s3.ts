type S3Config = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucketName: string
}

const encoder = new TextEncoder()

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const sha256 = async (value: string | ArrayBuffer): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))

const hmac = async (key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> =>
  crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    encoder.encode(value),
  )

const signingKey = async (secret: string, date: string, region: string, service: string) => {
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), date)
  const regionKey = await hmac(dateKey, region)
  const serviceKey = await hmac(regionKey, service)
  return hmac(serviceKey, 'aws4_request')
}

const encodePath = (value: string): string =>
  value.split('/').map((part) => encodeURIComponent(part)).join('/')

export async function getCvObject(objectKey: string, config: S3Config): Promise<ArrayBuffer> {
  const host = `${config.accountId}.r2.cloudflarestorage.com`
  const path = `/${encodeURIComponent(config.bucketName)}/${encodePath(objectKey)}`
  const url = `https://${host}${path}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const region = 'auto'
  const service = 's3'
  const payloadHash = 'UNSIGNED-PAYLOAD'
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `GET\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const credentialScope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`
  const signature = hex(await hmac(await signingKey(config.secretAccessKey, date, region, service), stringToSign))
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await fetch(url, {
    headers: {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
    },
  })
  if (!response.ok) throw new Error(`R2 object read failed with status ${response.status}`)
  return response.arrayBuffer()
}
