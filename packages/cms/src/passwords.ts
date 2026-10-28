import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// OWASP's minimum cost for scrypt, which takes 128 MiB per hash
const cost = { N: 2 ** 17, r: 8, p: 1 }

function derive(password: string, salt: Buffer, { N, r, p }: typeof cost) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

// Stored as scrypt$N$r$p$salt$key, so the cost can rise later without breaking existing hashes
export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const key = await derive(password, salt, cost)
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, hash: string | undefined) {
  // Hash anyway when there's no user, so response times don't reveal which emails have accounts
  if (!hash) {
    await derive(password, randomBytes(16), cost)
    return false
  }

  const [, N, r, p, salt, key] = hash.split('$')
  const derived = await derive(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) })
  return timingSafeEqual(derived, Buffer.from(key, 'base64'))
}

// Session tokens and API keys are random, so a fast hash is enough. Only the hash is stored, so a copy of the
// database can't be used to sign in or read content.
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
