const encoder = new TextEncoder()

export const MAX_BROWSER_APPROVAL_TTL_MS = 5 * 60 * 1000

export class BrowserSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserSecurityError'
  }
}

type PublicHttpsTarget = {
  url: URL
  canonicalUrl: string
  hostname: string
}

export type BrowserApprovalInput = {
  applicationId: string
  targetUrl: string
  manifestDigest: string
  nonce: string
  issuedAt: number
  expiresAt: number
}

export type BrowserApprovalReceipt = BrowserApprovalInput & {
  signature: string
}

const fail = (message: string): never => {
  throw new BrowserSecurityError(message)
}

const parseIpv4 = (hostname: string): number[] | undefined => {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined

  const octets = parts.map(Number)
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined
}

const isReservedIpv4 = ([first, second, third]: number[]): boolean =>
  first === 0 ||
  first === 10 ||
  (first === 100 && second >= 64 && second <= 127) ||
  first === 127 ||
  (first === 169 && second === 254) ||
  (first === 172 && second >= 16 && second <= 31) ||
  (first === 192 && second === 0 && third === 0) ||
  (first === 192 && second === 0 && third === 2) ||
  (first === 192 && second === 88 && third === 99) ||
  (first === 192 && second === 168) ||
  (first === 198 && (second === 18 || second === 19)) ||
  (first === 198 && second === 51 && third === 100) ||
  (first === 203 && second === 0 && third === 113) ||
  first >= 224

type Ipv6Address = [number, number, number, number, number, number, number, number]

const parseIpv6 = (hostname: string): Ipv6Address | undefined => {
  const source = hostname.toLowerCase()
  if (source.includes('%') || source.split('::').length > 2) return undefined

  const [leftSource, rightSource] = source.split('::')
  const left = leftSource ? leftSource.split(':') : []
  const right = rightSource ? rightSource.split(':') : []
  const validGroup = (group: string) => /^[0-9a-f]{1,4}$/.test(group)
  if (!left.every(validGroup) || !right.every(validGroup)) return undefined

  const hasCompression = source.includes('::')
  if ((!hasCompression && left.length !== 8) || (hasCompression && left.length + right.length >= 8)) {
    return undefined
  }

  const groups = hasCompression
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left
  if (groups.length !== 8) return undefined

  return groups.map((group) => Number.parseInt(group, 16)) as Ipv6Address
}

const ipv6Constant = (value: string): Ipv6Address => {
  const parsed = parseIpv6(value)
  if (parsed === undefined) throw new Error('Invalid internal IPv6 range')
  return parsed
}

const blockedIpv6Ranges: ReadonlyArray<readonly [Ipv6Address, number]> = [
  [ipv6Constant('::'), 8],
  [ipv6Constant('64:ff9b::'), 96],
  [ipv6Constant('64:ff9b:1::'), 48],
  [ipv6Constant('100::'), 64],
  [ipv6Constant('2001::'), 23],
  [ipv6Constant('2001:db8::'), 32],
  [ipv6Constant('2002::'), 16],
  [ipv6Constant('3ffe::'), 16],
  [ipv6Constant('3fff::'), 20],
  [ipv6Constant('5f00::'), 16],
  [ipv6Constant('fc00::'), 7],
  [ipv6Constant('fe80::'), 10],
  [ipv6Constant('fec0::'), 10],
  [ipv6Constant('ff00::'), 8],
]

const isReservedIpv6 = (value: Ipv6Address): boolean =>
  blockedIpv6Ranges.some(([base, prefixLength]) => {
    let remainingBits = prefixLength
    for (let index = 0; index < value.length && remainingBits > 0; index += 1) {
      const comparedBits = Math.min(16, remainingBits)
      const mask = (0xffff << (16 - comparedBits)) & 0xffff
      if ((value[index] & mask) !== (base[index] & mask)) return false
      remainingBits -= comparedBits
    }
    return true
  })

const reservedDnsSuffixes = [
  'localhost',
  'local',
  'internal',
  'home',
  'lan',
  'test',
  'invalid',
  'onion',
] as const

const canonicalizePublicHostname = (rawHostname: string): string => {
  let hostname = rawHostname.toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
  if (!hostname || hostname.length > 253) fail('Target hostname is invalid')

  const ipv4 = parseIpv4(hostname)
  if (ipv4) {
    fail('Browser targets must use a DNS hostname')
  }

  if (hostname.includes(':')) {
    const ipv6 = parseIpv6(hostname)
    if (ipv6 === undefined) throw new BrowserSecurityError('Target hostname is invalid')
    fail('Browser targets must use a DNS hostname')
  }

  const labels = hostname.split('.')
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-'),
    )
  ) {
    fail('Target hostname is invalid')
  }

  if (
    reservedDnsSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)) ||
    hostname === 'home.arpa' ||
    hostname.endsWith('.home.arpa')
  ) {
    fail('Target hostname is not public')
  }

  return hostname
}

export function canonicalizePublicHttpsUrl(value: string): PublicHttpsTarget {
  if (!value || value.length > 2048) fail('Target URL is invalid')

  const url = (() => {
    try {
      return new URL(value)
    } catch {
      return fail('Target URL is invalid')
    }
  })()

  if (url.protocol !== 'https:') fail('Target URL must use HTTPS')
  if (url.username || url.password) fail('Target URL must not contain credentials')

  const hostname = canonicalizePublicHostname(url.hostname)
  url.hostname = hostname.includes(':') ? `[${hostname}]` : hostname
  if (url.port) fail('Target URL must use the default HTTPS port')
  url.hash = ''

  return { url, canonicalUrl: url.href, hostname }
}

export function canonicalizeAllowedBrowserHost(value: string): string {
  if (
    !value ||
    value !== value.trim() ||
    value.includes('*') ||
    /[\s\\/?#@]/.test(value) ||
    (value.includes(':') && !(value.startsWith('[') && value.endsWith(']')))
  ) {
    fail('Allowed hostname is invalid')
  }

  const target = canonicalizePublicHttpsUrl(`https://${value}/`)
  if (target.url.port) fail('Allowed hostname must not include a port')
  return target.hostname
}

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const hexToBytes = (value: string): Uint8Array | undefined => {
  if (!/^[a-f0-9]{64}$/i.test(value)) return undefined
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return fail('Browser manifest contains an unsupported value')
}

export async function createBrowserManifestDigest(value: unknown): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(value))))
}

export function assertPublicIpAddress(value: string): void {
  const ipv4 = parseIpv4(value)
  if (ipv4) {
    if (isReservedIpv4(ipv4)) fail('Resolved browser target is not public')
    return
  }
  const ipv6 = parseIpv6(value)
  if (ipv6) {
    if (isReservedIpv6(ipv6)) fail('Resolved browser target is not public')
    return
  }
  fail('Resolved browser target is invalid')
}

export const timingSafeBytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return mismatch === 0
}

export const timingSafeHexEqual = (left: string, right: string): boolean => {
  const leftBytes = hexToBytes(left)
  const rightBytes = hexToBytes(right)
  return leftBytes !== undefined && rightBytes !== undefined && timingSafeBytesEqual(leftBytes, rightBytes)
}

const approvalMessage = (input: BrowserApprovalInput): string => {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.applicationId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce) ||
    !/^[a-f0-9]{64}$/i.test(input.manifestDigest) ||
    !Number.isSafeInteger(input.issuedAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.issuedAt <= 0 ||
    input.expiresAt <= input.issuedAt ||
    input.expiresAt - input.issuedAt > MAX_BROWSER_APPROVAL_TTL_MS ||
    input.expiresAt <= 0
  ) {
    fail('Approval receipt is invalid')
  }

  const target = canonicalizePublicHttpsUrl(input.targetUrl)
  return JSON.stringify([
    'browser-submit-v2',
    input.applicationId,
    target.canonicalUrl,
    input.manifestDigest.toLowerCase(),
    input.nonce,
    input.issuedAt,
    input.expiresAt,
  ])
}

export async function createBrowserApprovalSignature(
  input: BrowserApprovalInput,
  secret: string,
): Promise<string> {
  if (encoder.encode(secret).byteLength < 32) fail('Approval secret is invalid')

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(approvalMessage(input))))
}

export async function verifyBrowserApprovalReceipt(
  receipt: BrowserApprovalReceipt,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    if (
      !Number.isSafeInteger(now) ||
      receipt.issuedAt > now + 30_000 ||
      now - receipt.issuedAt > MAX_BROWSER_APPROVAL_TTL_MS ||
      receipt.expiresAt <= now ||
      receipt.expiresAt - receipt.issuedAt > MAX_BROWSER_APPROVAL_TTL_MS
    ) {
      return false
    }

    const provided = hexToBytes(receipt.signature)
    if (!provided) return false

    const expected = hexToBytes(await createBrowserApprovalSignature(receipt, secret))
    return expected !== undefined && timingSafeBytesEqual(expected, provided)
  } catch {
    return false
  }
}
